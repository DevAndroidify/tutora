import { Injectable, Logger, Module } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { StorageService } from '../../platform/storage/storage.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { RecordingProvider } from '../../providers/livekit/livekit.service';
import { BookingService } from '../sessions/booking.service';
import type { ParticipantRow, SessionRow } from '../sessions/sessions.schema';
import { SessionsModule } from '../sessions/sessions.module';
import {
  recordingConsents,
  recordings,
  type RecordingRow,
  type TranscriptStatus,
} from './recording.schema';

export const roomName = (sessionId: string) => `session-${sessionId}`;
/** Paid learners who are (or were) in the session. */
const PAID = ['CONFIRMED', 'JOINED', 'ATTENDED', 'ABSENT'] as const;

export interface RecordingView {
  sessionId: string;
  status: RecordingRow['status'] | 'NOT_RECORDED';
  consents: Array<{ userId: string; role: 'TUTOR' | 'STUDENT'; granted: boolean | null }>;
  url: string | null;
  deleteAfter: string | null;
}

/** Egress event fields we use (LiveKit EgressInfo). */
export interface EgressUpdate {
  egressId: string;
  status:
    'STARTING' | 'ACTIVE' | 'ENDING' | 'COMPLETE' | 'FAILED' | 'ABORTED' | 'LIMIT_REACHED' | string;
  sizeBytes?: number;
  error?: string;
}

/**
 * Part 14: consent-gated recordings. Recording starts only when the tutor and every paid learner
 * consented, while the session is LIVE. Files are private; access is by short-lived URL.
 */
@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly booking: BookingService,
    private readonly provider: RecordingProvider,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
  ) {}

  async setConsent(user: AuthUser, sessionId: string, granted: boolean): Promise<RecordingView> {
    const { session } = await this.requireMember(user, sessionId, ['CONFIRMED', 'JOINED']);
    if (session.status !== 'SCHEDULED' && session.status !== 'LIVE') {
      throw AppError.conflict(
        'SESSION_NOT_ACTIVE',
        'Consent can only change before or during the session.',
      );
    }
    await this.db
      .insert(recordingConsents)
      .values({ sessionId, userId: user.id, granted, updatedAt: this.clock.now() })
      .onConflictDoUpdate({
        target: [recordingConsents.sessionId, recordingConsents.userId],
        set: { granted, updatedAt: this.clock.now() },
      });
    if (granted) await this.maybeStart(sessionId);
    else await this.stopIfRecording(sessionId, 'CONSENT_WITHDRAWN');
    return this.view(user, sessionId);
  }

  /** Starts Egress when the session is LIVE and everyone consented. Idempotent. */
  async maybeStart(sessionId: string): Promise<boolean> {
    const session = await this.booking.getSession(sessionId);
    if (session?.status !== 'LIVE') return false;
    const required = await this.requiredConsenters(session);
    const given = await this.db
      .select()
      .from(recordingConsents)
      .where(and(eq(recordingConsents.sessionId, sessionId), eq(recordingConsents.granted, true)));
    const yes = new Set(given.map((c) => c.userId));
    if (!required.every((id) => yes.has(id))) return false;

    const now = this.clock.now();
    const [row] = await this.db
      .insert(recordings)
      .values({
        sessionId,
        objectKey: `recordings/${sessionId}/${now.getTime()}.mp4`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return false; // already started (or finished) once
    try {
      const { egressId } = await this.provider.start(roomName(sessionId), row.objectKey);
      await this.db
        .update(recordings)
        .set({ egressId, status: 'RECORDING', startedAt: now, updatedAt: now })
        .where(eq(recordings.id, row.id));
      return true;
    } catch (err) {
      this.logger.error({ err, sessionId }, 'Could not start recording');
      await this.db
        .update(recordings)
        .set({
          status: 'FAILED',
          error: err instanceof Error ? err.message.slice(0, 300) : 'start failed',
          updatedAt: now,
        })
        .where(eq(recordings.id, row.id));
      return false;
    }
  }

  async stopIfRecording(sessionId: string, reason: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(eq(recordings.sessionId, sessionId));
    if (row?.status !== 'RECORDING' || !row.egressId) return;
    try {
      await this.provider.stop(row.egressId);
    } catch (err) {
      this.logger.warn({ err, sessionId, reason }, 'Stopping egress failed');
    }
  }

  /** Applies LiveKit egress_started / egress_updated / egress_ended. */
  async onEgressUpdate(u: EgressUpdate): Promise<void> {
    const now = this.clock.now();
    const done = ['COMPLETE', 'FAILED', 'ABORTED', 'LIMIT_REACHED'].includes(u.status);
    if (!done) {
      await this.db
        .update(recordings)
        .set({ status: 'RECORDING', updatedAt: now })
        .where(and(eq(recordings.egressId, u.egressId), eq(recordings.status, 'STARTING')));
      return;
    }
    const ok = u.status === 'COMPLETE' || u.status === 'LIMIT_REACHED';
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(recordings)
        .set({
          status: ok ? 'COMPLETED' : 'FAILED',
          sizeBytes: u.sizeBytes ?? null,
          error: ok ? null : (u.error ?? u.status),
          endedAt: now,
          deleteAfter: new Date(
            now.getTime() + this.config.env.RECORDING_RETENTION_DAYS * 86_400_000,
          ),
          updatedAt: now,
        })
        .where(
          and(
            eq(recordings.egressId, u.egressId),
            inArray(recordings.status, ['STARTING', 'RECORDING']),
          ),
        )
        .returning();
      // Queues transcription (Part 15) through the outbox, so it survives restarts.
      if (row && ok) {
        await this.outbox.add(tx, 'recording.completed', {
          recordingId: row.id,
          sessionId: row.sessionId,
        });
      }
    });
  }

  /** The tutor and paid learners of the session may watch; others get 403. */
  async view(user: AuthUser, sessionId: string): Promise<RecordingView> {
    const { session } = await this.requireMember(user, sessionId, PAID);
    return this.buildView(session);
  }

  /** Staff access, only when the caller (admin app) has checked there is a reason, e.g. an open dispute. */
  async viewForStaff(sessionId: string): Promise<RecordingView> {
    const session = await this.booking.getSession(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    return this.buildView(session);
  }

  /** Deletes files past their retention date. Idempotent. */
  async sweepRetention(): Promise<number> {
    const due = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.status, 'COMPLETED'), lte(recordings.deleteAfter, this.clock.now())))
      .limit(100);
    for (const r of due) {
      await this.storage.delete(r.objectKey);
      await this.db
        .update(recordings)
        .set({ status: 'DELETED', updatedAt: this.clock.now() })
        .where(and(eq(recordings.id, r.id), eq(recordings.status, 'COMPLETED')));
    }
    return due.length;
  }

  // ---------- For replay (Part 15) ----------

  async findById(id: string): Promise<RecordingRow | null> {
    const [row] = await this.db.select().from(recordings).where(eq(recordings.id, id));
    return row ?? null;
  }

  async findForSession(sessionId: string): Promise<RecordingRow | null> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(eq(recordings.sessionId, sessionId));
    return row ?? null;
  }

  /** Guarded transcript status change; returns false if the row was not in `from`. */
  async setTranscriptStatus(
    id: string,
    from: TranscriptStatus[],
    to: TranscriptStatus,
    error: string | null = null,
  ): Promise<boolean> {
    const rows = await this.db
      .update(recordings)
      .set({ transcriptStatus: to, transcriptError: error, updatedAt: this.clock.now() })
      .where(and(eq(recordings.id, id), inArray(recordings.transcriptStatus, from)))
      .returning({ id: recordings.id });
    return rows.length > 0;
  }

  /** COMPLETED recordings whose transcript never finished (safety net for the outbox job). */
  async awaitingTranscript(limit = 50): Promise<RecordingRow[]> {
    return this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.status, 'COMPLETED'), eq(recordings.transcriptStatus, 'PENDING')))
      .limit(limit);
  }

  // ---------- Helpers ----------

  private async buildView(session: SessionRow): Promise<RecordingView> {
    const [rec] = await this.db
      .select()
      .from(recordings)
      .where(eq(recordings.sessionId, session.id));
    const consents = await this.db
      .select()
      .from(recordingConsents)
      .where(eq(recordingConsents.sessionId, session.id));
    const byUser = new Map(consents.map((c) => [c.userId, c.granted]));
    const parts = await this.booking.participantsOf(session.id);
    const people = [
      { userId: session.tutorUserId, role: 'TUTOR' as const },
      ...parts
        .filter((p) => (PAID as readonly string[]).includes(p.status))
        .map((p) => ({ userId: p.studentUserId, role: 'STUDENT' as const })),
    ];
    return {
      sessionId: session.id,
      status: rec?.status ?? 'NOT_RECORDED',
      consents: people.map((p) => ({ ...p, granted: byUser.get(p.userId) ?? null })),
      url:
        rec?.status === 'COMPLETED'
          ? await this.storage.presignGet(
              rec.objectKey,
              this.config.env.UPLOAD_URL_TTL_SECONDS,
              `session-${session.id}.mp4`,
            )
          : null,
      deleteAfter: rec?.deleteAfter?.toISOString() ?? null,
    };
  }

  private async requiredConsenters(session: SessionRow): Promise<string[]> {
    const parts = await this.booking.participantsOf(session.id);
    return [
      session.tutorUserId,
      ...parts
        .filter((p) => p.status === 'CONFIRMED' || p.status === 'JOINED')
        .map((p) => p.studentUserId),
    ];
  }

  private async requireMember(
    user: AuthUser,
    sessionId: string,
    allowed: readonly ParticipantRow['status'][],
  ): Promise<{ session: SessionRow }> {
    const session = await this.booking.getSession(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (user.app === 'tutor' && session.tutorUserId === user.id) return { session };
    if (user.app === 'student') {
      const parts = await this.booking.participantsOf(sessionId);
      if (parts.some((p) => p.studentUserId === user.id && allowed.includes(p.status)))
        return { session };
    }
    throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
  }
}

@Module({
  imports: [SessionsModule],
  providers: [RecordingService],
  exports: [RecordingService],
})
export class RecordingModule {}
