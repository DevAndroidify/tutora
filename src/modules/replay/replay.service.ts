import { Injectable, Logger, Module } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import type { OutboxEvent } from '../../platform/outbox/outbox.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import {
  FakeReplayAssetProvider,
  ReplayAssetProvider,
  type AssetKind,
} from '../../providers/replay-assets/replay-assets.provider';
import {
  FakeTranscriptionProvider,
  TranscriptionProvider,
} from '../../providers/transcription/transcription.provider';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService } from '../catalog/catalog.service';
import { LowBandwidthModule, LowBandwidthService } from '../lowbandwidth/lowbandwidth.service';
import { RecordingModule, RecordingService } from '../recording/recording.service';
import { BookingService } from '../sessions/booking.service';
import { SessionsModule } from '../sessions/sessions.module';
import { replayAssets, transcriptSegments } from './replay.schema';

const MAX_TEXT = 2_000;
const MAX_ITEMS = 50;

/**
 * Generated content is untrusted data. Strip markup and control characters, cap sizes, and keep
 * only the expected shape, so nothing a model returns is ever rendered as HTML or run as instructions.
 */
export function cleanText(value: unknown): string {
  return (
    String(value ?? '')
      .replace(/<[^>]*>/g, '')
      // Stripping control characters is the point of this regex.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, MAX_TEXT)
  );
}

const cleanMs = (v: unknown) =>
  Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0;

export function sanitizeAsset(kind: AssetKind, content: unknown): Record<string, unknown> {
  const c = (content ?? {}) as Record<string, unknown>;
  if (kind === 'NOTES') {
    const points = Array.isArray(c.keyPoints) ? c.keyPoints : [];
    return {
      summary: cleanText(c.summary),
      keyPoints: points.slice(0, MAX_ITEMS).map((p: Record<string, unknown>) => ({
        text: cleanText(p?.text),
        atMs: cleanMs(p?.atMs),
      })),
    };
  }
  const cards = Array.isArray(c.cards) ? c.cards : [];
  return {
    cards: cards
      .slice(0, MAX_ITEMS)
      .map((x: Record<string, unknown>) => ({
        front: cleanText(x?.front),
        back: cleanText(x?.back),
        atMs: cleanMs(x?.atMs),
      }))
      .filter((x) => x.front && x.back),
  };
}

/**
 * Parts 15-16: transcripts, search, notes and flashcards. Each step is its own idempotent job;
 * a failure in one leaves the recording (and other assets) usable.
 */
@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly recording: RecordingService,
    private readonly booking: BookingService,
    private readonly catalog: CatalogService,
    private readonly lowBandwidth: LowBandwidthService,
    private readonly transcriber: TranscriptionProvider,
    private readonly assets: ReplayAssetProvider,
    private readonly outbox: OutboxService,
  ) {}

  /** Outbox consumer (worker): recording.completed -> transcribe; replay.transcript_ready -> notes + flashcards. */
  async onEvent(event: OutboxEvent): Promise<void> {
    if (event.type === 'recording.completed')
      await this.transcribe(String(event.payload.recordingId));
    if (event.type === 'replay.transcript_ready') {
      const sessionId = String(event.payload.sessionId);
      await this.generate(sessionId, 'NOTES');
      await this.generate(sessionId, 'FLASHCARDS');
    }
  }

  /** Transcribes a completed recording. Safe to retry: segments are upserted by (recording, seq). */
  async transcribe(recordingId: string): Promise<boolean> {
    const rec = await this.recording.findById(recordingId);
    if (!rec || rec.status !== 'COMPLETED') return false;
    if (!(await this.recording.setTranscriptStatus(rec.id, ['PENDING', 'FAILED'], 'PROCESSING')))
      return false;
    try {
      const result = await this.transcriber.transcribe({
        objectKey: rec.objectKey,
        sessionId: rec.sessionId,
      });
      const now = this.clock.now();
      await this.db.transaction(async (tx) => {
        for (const [seq, s] of result.segments.entries()) {
          const values = {
            recordingId: rec.id,
            sessionId: rec.sessionId,
            seq,
            startMs: cleanMs(s.startMs),
            endMs: cleanMs(s.endMs),
            speaker: s.speaker ? cleanText(s.speaker).slice(0, 40) : null,
            text: cleanText(s.text),
            provider: result.provider,
            model: result.model,
            createdAt: now,
          };
          await tx
            .insert(transcriptSegments)
            .values(values)
            .onConflictDoUpdate({
              target: [transcriptSegments.recordingId, transcriptSegments.seq],
              set: {
                startMs: values.startMs,
                endMs: values.endMs,
                speaker: values.speaker,
                text: values.text,
              },
            });
        }
        await this.outbox.add(tx, 'replay.transcript_ready', {
          sessionId: rec.sessionId,
          recordingId: rec.id,
        });
      });
      await this.recording.setTranscriptStatus(rec.id, ['PROCESSING'], 'READY');
      return true;
    } catch (err) {
      this.logger.warn({ err, recordingId }, 'Transcription failed; the recording stays playable');
      await this.recording.setTranscriptStatus(
        rec.id,
        ['PROCESSING'],
        'FAILED',
        err instanceof Error ? err.message.slice(0, 300) : 'failed',
      );
      return false;
    }
  }

  /** Generates notes or flashcards from the transcript. Upserts one row per (session, kind). */
  async generate(sessionId: string, kind: AssetKind): Promise<boolean> {
    const segments = await this.segments(sessionId);
    if (segments.length === 0) return false;
    const session = await this.booking.getSession(sessionId);
    const skill = session
      ? (await this.catalog.findSkills([session.skillId])).get(session.skillId)
      : undefined;
    const now = this.clock.now();
    const [row] = await this.db
      .insert(replayAssets)
      .values({
        sessionId,
        kind,
        source: 'GENERATED',
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [replayAssets.sessionId, replayAssets.kind, replayAssets.source],
        set: { attempts: sql`${replayAssets.attempts} + 1`, updatedAt: now },
      })
      .returning();
    if (row!.status === 'READY') return true; // already done; retries are no-ops
    try {
      const input = { skillName: skill?.name ?? 'this skill', segments };
      const out =
        kind === 'NOTES' ? await this.assets.notes(input) : await this.assets.flashcards(input);
      await this.db
        .update(replayAssets)
        .set({
          status: 'READY',
          provider: out.provider,
          model: out.model,
          content: sanitizeAsset(kind, out.content),
          error: null,
          updatedAt: this.clock.now(),
        })
        .where(eq(replayAssets.id, row!.id));
      return true;
    } catch (err) {
      await this.db
        .update(replayAssets)
        .set({
          status: 'FAILED',
          error: err instanceof Error ? err.message.slice(0, 300) : 'failed',
          updatedAt: this.clock.now(),
        })
        .where(eq(replayAssets.id, row!.id));
      return false;
    }
  }

  /** Tutor-written notes: the fallback (and override) when generated notes are missing or wrong. */
  async writeTutorNotes(
    user: AuthUser,
    sessionId: string,
    input: { summary: string; keyPoints: string[] },
  ) {
    const session = await this.booking.assertMember(user, sessionId);
    if (session.tutorUserId !== user.id)
      throw AppError.forbidden('NOT_SESSION_TUTOR', 'Only the tutor can write notes.');
    const now = this.clock.now();
    const content = sanitizeAsset('NOTES', {
      summary: input.summary,
      keyPoints: input.keyPoints.map((text) => ({ text, atMs: 0 })),
    });
    await this.db
      .insert(replayAssets)
      .values({
        sessionId,
        kind: 'NOTES',
        source: 'TUTOR',
        status: 'READY',
        provider: 'tutor',
        content,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [replayAssets.sessionId, replayAssets.kind, replayAssets.source],
        set: { content, status: 'READY', updatedAt: now },
      });
    return this.replay(user, sessionId);
  }

  /** Everything a member needs to review a session. */
  async replay(user: AuthUser, sessionId: string) {
    await this.booking.assertMember(user, sessionId);
    const [recording, rec, segments, assets, whiteboard] = await Promise.all([
      this.recording.view(user, sessionId),
      this.recording.findForSession(sessionId),
      this.segments(sessionId),
      this.db.select().from(replayAssets).where(eq(replayAssets.sessionId, sessionId)),
      this.lowBandwidth.finalSnapshots(sessionId),
    ]);
    const pick = (kind: AssetKind) => {
      const tutor = assets.find(
        (a) => a.kind === kind && a.source === 'TUTOR' && a.status === 'READY',
      );
      const gen = assets.find((a) => a.kind === kind && a.source === 'GENERATED');
      const a = tutor ?? gen;
      return a
        ? {
            status: a.status,
            source: a.source,
            provider: a.provider,
            model: a.model,
            content: a.content,
          }
        : null;
    };
    return {
      sessionId,
      recording,
      transcript: { status: rec?.transcriptStatus ?? 'NOT_RECORDED', segments },
      notes: pick('NOTES'),
      flashcards: pick('FLASHCARDS'),
      whiteboard,
    };
  }

  /** Full-text search inside one session's transcript only. */
  async search(user: AuthUser, sessionId: string, q: string) {
    await this.booking.assertMember(user, sessionId);
    const query = sql`plainto_tsquery('simple', ${q})`;
    const rows = await this.db
      .select({
        startMs: transcriptSegments.startMs,
        endMs: transcriptSegments.endMs,
        speaker: transcriptSegments.speaker,
        text: transcriptSegments.text,
        snippet: sql<string>`ts_headline('simple', ${transcriptSegments.text}, ${query}, 'StartSel=[[,StopSel=]]')`,
      })
      .from(transcriptSegments)
      .where(and(eq(transcriptSegments.sessionId, sessionId), sql`tsv @@ ${query}`))
      .orderBy(asc(transcriptSegments.startMs))
      .limit(50);
    return { sessionId, q, results: rows };
  }

  /** Safety net: transcribe recordings the outbox job missed, and fill missing assets. */
  async sweep(): Promise<void> {
    for (const rec of await this.recording.awaitingTranscript()) await this.transcribe(rec.id);
    const missing = await this.db.execute<{ session_id: string; kind: AssetKind }>(sql`
      select distinct t.session_id, k.kind from transcript_segments t
      cross join (values ('NOTES'::replay_asset_kind), ('FLASHCARDS'::replay_asset_kind)) k(kind)
      where not exists (
        select 1 from replay_assets a
        where a.session_id = t.session_id and a.kind = k.kind and a.source = 'GENERATED' and a.status = 'READY'
      )
      limit 50`);
    for (const m of missing.rows) await this.generate(m.session_id, m.kind);
  }

  private async segments(sessionId: string) {
    return this.db
      .select({
        startMs: transcriptSegments.startMs,
        endMs: transcriptSegments.endMs,
        speaker: transcriptSegments.speaker,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.sessionId, sessionId))
      .orderBy(asc(transcriptSegments.startMs), asc(transcriptSegments.seq));
  }
}

@Module({
  imports: [RecordingModule, SessionsModule, CatalogModule, LowBandwidthModule],
  providers: [
    ReplayService,
    { provide: TranscriptionProvider, useClass: FakeTranscriptionProvider },
    { provide: ReplayAssetProvider, useClass: FakeReplayAssetProvider },
  ],
  exports: [ReplayService, TranscriptionProvider, ReplayAssetProvider],
})
export class ReplayModule {}
