import { Injectable, Module } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { LiveKitService } from '../../providers/livekit/livekit.service';
import { IdentityModule } from '../identity/identity.module';
import { UsersService } from '../identity/users.service';
import { MasteryModule, MasteryService } from '../mastery/mastery.service';
import { RecordingModule, RecordingService, roomName } from '../recording/recording.service';
import { BookingService } from '../sessions/booking.service';
import { SessionsModule } from '../sessions/sessions.module';
import { sessionEvents } from './live.schema';

export interface JoinTokenView {
  token: string;
  url: string;
  room: string;
  identity: string;
  expiresAt: string;
}

export interface AttendanceRow {
  identity: string;
  role: 'TUTOR' | 'STUDENT';
  userId: string;
  firstJoinedAt: string | null;
  seconds: number;
}

const ROOM = /^session-([0-9a-f-]{36})$/i;

export function parseIdentity(
  identity: string | undefined,
): { role: 'TUTOR' | 'STUDENT'; userId: string } | null {
  const m = identity ? /^(tutor|student):([0-9a-f-]{36})$/i.exec(identity) : null;
  return m ? { role: m[1]!.toLowerCase() === 'tutor' ? 'TUTOR' : 'STUDENT', userId: m[2]! } : null;
}

/**
 * Sums joined -> left intervals per identity. An open interval runs until `until`
 * (session end, or now for a live session). Overlapping joins (two devices) are merged.
 */
export function computeAttendance(
  events: Array<{ type: string; identity: string | null; at: Date }>,
  until: Date,
): Map<string, { seconds: number; firstJoinedAt: Date | null }> {
  const open = new Map<string, { since: Date; depth: number }>();
  const out = new Map<string, { seconds: number; firstJoinedAt: Date | null }>();
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const e of sorted) {
    if (!e.identity) continue;
    const acc = out.get(e.identity) ?? { seconds: 0, firstJoinedAt: null };
    out.set(e.identity, acc);
    const o = open.get(e.identity);
    if (e.type === 'participant_joined') {
      acc.firstJoinedAt ??= e.at;
      if (o) o.depth++;
      else open.set(e.identity, { since: e.at, depth: 1 });
    } else if (e.type === 'participant_left' && o) {
      o.depth--;
      if (o.depth === 0) {
        acc.seconds += Math.max(0, (e.at.getTime() - o.since.getTime()) / 1000);
        open.delete(e.identity);
      }
    }
  }
  for (const [identity, o] of open) {
    out.get(identity)!.seconds += Math.max(0, (until.getTime() - o.since.getTime()) / 1000);
  }
  for (const acc of out.values()) acc.seconds = Math.round(acc.seconds);
  return out;
}

/**
 * Part 11: joining live rooms and following LiveKit's room/participant events.
 * Session status: SCHEDULED -> LIVE on first join, LIVE -> ENDED when the room finishes.
 */
@Injectable()
export class LiveSessionsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly livekit: LiveKitService,
    private readonly booking: BookingService,
    private readonly users: UsersService,
    private readonly mastery: MasteryService,
    private readonly recording: RecordingService,
    private readonly outbox: OutboxService,
  ) {}

  /** Only the assigned tutor and paid learners, only around the session time. */
  async joinToken(user: AuthUser, sessionId: string): Promise<JoinTokenView> {
    const session = await this.booking.getSession(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');

    let role: 'tutor' | 'student';
    if (user.app === 'tutor' && session.tutorUserId === user.id) {
      role = 'tutor';
    } else if (user.app === 'student') {
      const parts = await this.booking.participantsOf(sessionId);
      const mine = parts.find((p) => p.studentUserId === user.id);
      if (!mine) throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
      if (mine.status !== 'CONFIRMED' && mine.status !== 'JOINED') {
        throw AppError.forbidden('NOT_PAID', 'Pay for the session to join it.', {
          status: mine.status,
        });
      }
      role = 'student';
    } else {
      throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
    }

    if (session.status !== 'SCHEDULED' && session.status !== 'LIVE') {
      throw AppError.conflict('SESSION_NOT_JOINABLE', `This session is ${session.status}.`, {
        status: session.status,
      });
    }
    const now = this.clock.nowMs();
    const opensAt =
      session.startsAt.getTime() - this.config.env.SESSION_JOIN_EARLY_MINUTES * 60_000;
    const closesAt = session.startsAt.getTime() + (session.durationMinutes + 60) * 60_000;
    if (now < opensAt || now > closesAt) {
      throw AppError.conflict(
        'OUTSIDE_SESSION_WINDOW',
        'The room opens shortly before the session starts.',
        {
          opensAt: new Date(opensAt).toISOString(),
        },
      );
    }

    const person = await this.users.findById(user.id);
    const ttl = this.config.env.SESSION_TOKEN_TTL_SECONDS;
    const identity = `${role}:${user.id}`;
    const room = roomName(sessionId);
    return {
      token: await this.livekit.joinToken({
        room,
        identity,
        name: person?.fullName ?? role,
        canPublish: true,
        ttlSeconds: ttl,
      }),
      url: this.config.livekit.url.replace(/^http/, 'ws'),
      room,
      identity,
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    };
  }

  /** POST /webhooks/livekit. Verifies the signature, deduplicates, applies the event. */
  async handleWebhook(
    rawBody: Buffer | undefined,
    authHeader: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    let event: Awaited<ReturnType<LiveKitService['receiveWebhook']>>;
    try {
      event = await this.livekit.receiveWebhook(rawBody?.toString('utf8') ?? '', authHeader);
    } catch {
      throw AppError.unauthorized('INVALID_SIGNATURE', 'Webhook signature is not valid.');
    }
    const roomMatch = ROOM.exec(event.room?.name ?? event.egressInfo?.roomName ?? '');
    const sessionId = roomMatch?.[1] ?? null;
    const identity = event.participant?.identity ?? null;
    const occurredAt = event.createdAt
      ? new Date(Number(event.createdAt) * 1000)
      : this.clock.now();

    const [saved] = await this.db
      .insert(sessionEvents)
      .values({
        sessionId,
        eventId: event.id,
        eventType: event.event,
        identity,
        payload: JSON.parse(rawBody!.toString('utf8')) as Record<string, unknown>,
        occurredAt,
        receivedAt: this.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: sessionEvents.id });
    if (!saved) return { received: true, duplicate: true };

    if (event.event.startsWith('egress_') && event.egressInfo) {
      const info = event.egressInfo;
      await this.recording.onEgressUpdate({
        egressId: info.egressId,
        status: EGRESS_STATUS[info.status] ?? String(info.status),
        sizeBytes:
          info.fileResults?.[0]?.size !== undefined ? Number(info.fileResults[0].size) : undefined,
        error: info.error || undefined,
      });
      return { received: true, duplicate: false };
    }
    if (!sessionId) return { received: true, duplicate: false };

    if (event.event === 'participant_joined') await this.onJoined(sessionId, identity);
    if (event.event === 'room_finished') await this.onRoomFinished(sessionId);
    return { received: true, duplicate: false };
  }

  async attendance(user: AuthUser, sessionId: string): Promise<AttendanceRow[]> {
    const session = await this.booking.getSession(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    const parts = await this.booking.participantsOf(sessionId);
    const allowed =
      (user.app === 'tutor' && session.tutorUserId === user.id) ||
      (user.app === 'student' && parts.some((p) => p.studentUserId === user.id)) ||
      user.app === 'admin';
    if (!allowed) throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
    return this.computeFor(sessionId, session.endedAt ?? this.clock.now());
  }

  async computeFor(sessionId: string, until: Date): Promise<AttendanceRow[]> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(asc(sessionEvents.occurredAt));
    const totals = computeAttendance(
      rows.map((r) => ({ type: r.eventType, identity: r.identity, at: r.occurredAt })),
      until,
    );
    const out: AttendanceRow[] = [];
    for (const [identity, t] of totals) {
      const who = parseIdentity(identity);
      if (!who) continue;
      out.push({
        identity,
        ...who,
        firstJoinedAt: t.firstJoinedAt?.toISOString() ?? null,
        seconds: t.seconds,
      });
    }
    return out;
  }

  private async onJoined(sessionId: string, identity: string | null): Promise<void> {
    const who = parseIdentity(identity ?? undefined);
    if (!who) return;
    const wentLive = await this.db.transaction(async (tx) => {
      const session = await this.booking.lockSession(tx, sessionId);
      if (!session || (session.status !== 'SCHEDULED' && session.status !== 'LIVE')) return false;
      if (who.role === 'TUTOR') {
        if (who.userId !== session.tutorUserId) return false;
        await this.booking.markTutorJoinedInTx(tx, sessionId);
      } else {
        await this.booking.markParticipantJoinedInTx(tx, sessionId, who.userId);
      }
      const live = await this.booking.markLiveInTx(tx, sessionId);
      await this.outbox.add(tx, 'session.participant_joined', {
        sessionId,
        role: who.role,
        userId: who.userId,
      });
      if (live) await this.outbox.add(tx, 'session.status_changed', { sessionId, status: 'LIVE' });
      return live;
    });
    if (wentLive) await this.recording.maybeStart(sessionId);
  }

  private async onRoomFinished(sessionId: string): Promise<void> {
    const ended = await this.db.transaction(async (tx) => {
      const session = await this.booking.lockSession(tx, sessionId);
      if (!session) return false;
      const row = await this.booking.endSessionInTx(tx, sessionId);
      if (!row) return false;
      const attended = (await this.booking.participantsOf(sessionId, tx)).filter(
        (p) => p.status === 'ATTENDED',
      );
      await this.mastery.createForSessionInTx(tx, {
        sessionId,
        tutorUserId: row.tutorUserId,
        skillId: row.skillId,
        endedAt: row.endedAt!,
        participants: attended.map((p) => ({ id: p.id, studentUserId: p.studentUserId })),
      });
      await this.outbox.add(tx, 'session.status_changed', { sessionId, status: 'ENDED' });
      return true;
    });
    if (ended) await this.recording.stopIfRecording(sessionId, 'SESSION_ENDED');
  }
}

/** LiveKit EgressStatus enum values -> names. */
const EGRESS_STATUS: Record<number, string> = {
  0: 'STARTING',
  1: 'ACTIVE',
  2: 'ENDING',
  3: 'COMPLETE',
  4: 'FAILED',
  5: 'ABORTED',
  6: 'LIMIT_REACHED',
};

@Module({
  imports: [IdentityModule, SessionsModule, MasteryModule, RecordingModule],
  providers: [LiveSessionsService],
  exports: [LiveSessionsService],
})
export class LiveModule {}
