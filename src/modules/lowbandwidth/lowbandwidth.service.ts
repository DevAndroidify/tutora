import { Injectable, Module } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { UploadsService } from '../../platform/storage/uploads.service';
import { BookingService } from '../sessions/booking.service';
import { SessionsModule } from '../sessions/sessions.module';
import { sessionModeEvents, whiteboardSnapshots, type SessionMode } from './lowbandwidth.schema';

const ACTIVE_LEARNER = ['CONFIRMED', 'JOINED'] as const;

/** Part 17: low-bandwidth mode events, whiteboard snapshots and their metrics. */
@Injectable()
export class LowBandwidthService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly booking: BookingService,
    private readonly uploads: UploadsService,
  ) {}

  /** Only the tutor and paid learners of a scheduled or live session may post. */
  private async assertActiveMember(user: AuthUser, sessionId: string) {
    const session = await this.booking.assertMember(user, sessionId, [...ACTIVE_LEARNER]);
    if (session.status !== 'SCHEDULED' && session.status !== 'LIVE') {
      throw AppError.conflict('SESSION_NOT_ACTIVE', `This session is ${session.status}.`);
    }
    return session;
  }

  async recordMode(
    user: AuthUser,
    sessionId: string,
    input: { mode: SessionMode; downlinkKbps?: number; reason?: string },
  ) {
    await this.assertActiveMember(user, sessionId);
    const [row] = await this.db
      .insert(sessionModeEvents)
      .values({
        sessionId,
        userId: user.id,
        mode: input.mode,
        downlinkKbps: input.downlinkKbps ?? null,
        reason: input.reason ?? null,
        createdAt: this.clock.now(),
      })
      .returning();
    return { id: row!.id, mode: row!.mode, createdAt: row!.createdAt.toISOString() };
  }

  async presignSnapshot(
    user: AuthUser,
    sessionId: string,
    input: { contentType: string; sizeBytes: number },
  ) {
    await this.assertActiveMember(user, sessionId);
    await this.assertUnderLimit(user, sessionId);
    return this.uploads.presign(user.id, 'WHITEBOARD', input);
  }

  async addSnapshot(
    user: AuthUser,
    sessionId: string,
    input: { objectKey: string; isFinal?: boolean },
  ) {
    await this.assertActiveMember(user, sessionId);
    await this.assertUnderLimit(user, sessionId);
    const file = await this.uploads.verify(user.id, 'WHITEBOARD', input.objectKey);
    try {
      const [row] = await this.db
        .insert(whiteboardSnapshots)
        .values({
          sessionId,
          userId: user.id,
          objectKey: file.objectKey,
          sizeBytes: file.sizeBytes,
          isFinal: input.isFinal ?? false,
          createdAt: this.clock.now(),
        })
        .returning();
      return {
        id: row!.id,
        isFinal: row!.isFinal,
        sizeBytes: row!.sizeBytes,
        createdAt: row!.createdAt.toISOString(),
      };
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict('SNAPSHOT_EXISTS', 'This snapshot was already saved.');
      throw err;
    }
  }

  /** Snapshots marked final, or else the latest one per person, with short-lived URLs. */
  async finalSnapshots(
    sessionId: string,
  ): Promise<Array<{ id: string; userId: string; url: string; createdAt: string }>> {
    const rows = await this.db
      .select()
      .from(whiteboardSnapshots)
      .where(eq(whiteboardSnapshots.sessionId, sessionId))
      .orderBy(desc(whiteboardSnapshots.createdAt));
    const finals = rows.filter((r) => r.isFinal);
    // rows are newest first, so the first row seen per person is their latest.
    const latestPerUser = [...new Map(rows.map((r) => [r.userId, r] as const).reverse()).values()];
    const chosen = finals.length ? finals : latestPerUser;
    return Promise.all(
      chosen
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(async (r) => ({
          id: r.id,
          userId: r.userId,
          url: await this.uploads.readUrl(r.objectKey),
          createdAt: r.createdAt.toISOString(),
        })),
    );
  }

  /** Share of sessions (by start of mode events in the window) that used a low-bandwidth mode. */
  async metrics(from: Date, to: Date) {
    const window = and(gte(sessionModeEvents.createdAt, from), lt(sessionModeEvents.createdAt, to));
    const [totals] = await this.db
      .select({
        sessions: sql<number>`count(distinct ${sessionModeEvents.sessionId})::int`,
        lowBandwidthSessions: sql<number>`count(distinct ${sessionModeEvents.sessionId}) filter (where ${sessionModeEvents.mode} <> 'FULL_VIDEO')::int`,
        avgDownlinkKbps: sql<number | null>`round(avg(${sessionModeEvents.downlinkKbps}))::int`,
      })
      .from(sessionModeEvents)
      .where(window);
    const byMode = await this.db
      .select({
        mode: sessionModeEvents.mode,
        events: count(),
        sessions: sql<number>`count(distinct ${sessionModeEvents.sessionId})::int`,
      })
      .from(sessionModeEvents)
      .where(window)
      .groupBy(sessionModeEvents.mode)
      .orderBy(asc(sessionModeEvents.mode));
    const sessions = totals?.sessions ?? 0;
    const low = totals?.lowBandwidthSessions ?? 0;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      sessionsReporting: sessions,
      lowBandwidthSessions: low,
      lowBandwidthShare: sessions ? Math.round((low / sessions) * 1000) / 1000 : 0,
      avgDownlinkKbps: totals?.avgDownlinkKbps ?? null,
      byMode,
    };
  }

  private async assertUnderLimit(user: AuthUser, sessionId: string): Promise<void> {
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(whiteboardSnapshots)
      .where(
        and(eq(whiteboardSnapshots.sessionId, sessionId), eq(whiteboardSnapshots.userId, user.id)),
      );
    if (n >= this.config.env.WHITEBOARD_SNAPSHOT_LIMIT) {
      throw AppError.conflict(
        'SNAPSHOT_LIMIT',
        `At most ${this.config.env.WHITEBOARD_SNAPSHOT_LIMIT} snapshots per person per session.`,
      );
    }
  }
}

@Module({
  imports: [SessionsModule],
  providers: [LowBandwidthService],
  exports: [LowBandwidthService],
})
export class LowBandwidthModule {}
