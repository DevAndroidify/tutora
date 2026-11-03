import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { MetricsService } from '../../platform/telemetry/metrics';
import { BiddingService } from '../bidding/bidding.service';
import { assertOwnership } from '../identity/auth/ownership';
import { RequestsService } from '../requests/requests.service';
import {
  sessionParticipants,
  sessions,
  type ParticipantRow,
  type SessionRow,
} from './sessions.schema';

export const BOOKING_QUEUE = 'booking';
export const PAYMENT_EXPIRY_JOB = 'participant-payment-expiry';

export interface BookingView {
  sessionId: string;
  participantId: string;
  requestId: string;
  bidId: string;
  tutorUserId: string;
  sessionStatus: SessionRow['status'];
  participantStatus: ParticipantRow['status'];
  startsAt: string;
  durationMinutes: number;
  amountPaise: number;
  currency: 'INR';
  paymentDueAt: string;
}

function toView(s: SessionRow, p: ParticipantRow): BookingView {
  return {
    sessionId: s.id,
    participantId: p.id,
    requestId: p.requestId,
    bidId: s.bidId,
    tutorUserId: s.tutorUserId,
    sessionStatus: s.status,
    participantStatus: p.status,
    startsAt: s.startsAt.toISOString(),
    durationMinutes: s.durationMinutes,
    amountPaise: p.amountPaise,
    currency: 'INR',
    paymentDueAt: p.paymentDueAt.toISOString(),
  };
}

/**
 * Owns `sessions` and `session_participants`. Coordinates accepting a bid, the payment
 * window and confirming a paid booking across requests and bidding, each in one transaction.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly requests: RequestsService,
    private readonly bidding: BiddingService,
    private readonly outbox: OutboxService,
    @InjectQueue(BOOKING_QUEUE) private readonly queue: Queue,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * POST /student/bids/:id/accept. Locks the request row, so concurrent accepts serialize and
   * exactly one wins; the rest get 409. The payment-expiry job is scheduled after commit
   * (the minute sweep is the safety net if scheduling fails).
   */
  async acceptBid(student: AuthUser, bidId: string): Promise<BookingView> {
    const bid = await this.bidding.findBid(bidId);
    if (!bid?.requestId) throw AppError.notFound('BID_NOT_FOUND', 'Bid not found.');

    const view = await this.db.transaction(async (tx) => {
      const request = await this.requests.lockForUpdate(tx, bid.requestId!);
      if (request && request.status !== 'OPEN') this.metrics?.acceptanceConflicts.inc();
      if (!request) throw AppError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
      assertOwnership(student, request.studentUserId);
      if (request.status !== 'OPEN') {
        throw AppError.conflict(
          'REQUEST_NOT_OPEN',
          'This request is not open for accepting bids.',
          {
            status: request.status,
          },
        );
      }
      if (!(await this.bidding.acceptInTx(tx, bidId))) {
        throw AppError.conflict('BID_ALREADY_ACCEPTED', 'This bid can no longer be accepted.');
      }
      await this.bidding.holdOthersInTx(tx, request.id, bidId);
      await this.requests.transitionInTx(tx, request.id, ['OPEN'], 'RESERVED');

      const now = this.clock.now();
      const [session] = await tx
        .insert(sessions)
        .values({
          bidId,
          tutorUserId: bid.tutorUserId,
          skillId: request.skillId,
          startsAt: bid.proposedStartAt,
          durationMinutes: bid.durationMinutes,
          seatPricePaise: bid.seatPricePaise,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      let participant: ParticipantRow;
      try {
        [participant] = (await tx
          .insert(sessionParticipants)
          .values({
            sessionId: session!.id,
            studentUserId: student.id,
            requestId: request.id,
            amountPaise: bid.seatPricePaise,
            paymentDueAt: new Date(now.getTime() + this.config.env.PAYMENT_WINDOW_MINUTES * 60_000),
            createdAt: now,
            updatedAt: now,
          })
          .returning()) as [ParticipantRow];
      } catch (err) {
        if (isUniqueViolation(err))
          throw AppError.conflict(
            'REQUEST_ALREADY_RESERVED',
            'This request already has a booking.',
          );
        throw err;
      }

      await this.outbox.add(tx, 'bid.accepted', {
        requestId: request.id,
        studentUserId: student.id,
        tutorUserId: bid.tutorUserId,
        bidId,
        sessionId: session!.id,
      });
      await this.outbox.add(tx, 'request.closed', {
        requestId: request.id,
        studentUserId: student.id,
        status: 'RESERVED',
      });
      return toView(session!, participant);
    });

    await this.scheduleExpiry(view.participantId, new Date(view.paymentDueAt));
    return view;
  }

  /**
   * Payment window over: cancel the booking and reopen the request (accepted bid -> EXPIRED,
   * held bids -> SUBMITTED). Idempotent and safe to run from both the delayed job and the sweep.
   */
  async expireParticipant(participantId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Same lock order as confirmPaidInTx (session, participant, then request), so expiry and a
      // racing payment confirmation serialize instead of deadlocking.
      const [peek] = await tx
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.id, participantId));
      if (!peek) return false;
      const own = await this.lockSession(tx, peek.sessionId);
      if (own?.poolId) return false; // group sessions expire through the pool deadline (Part 19)
      const [p] = await tx
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.id, participantId))
        .for('update');
      const now = this.clock.now();
      if (!p || p.status !== 'PENDING_PAYMENT' || p.paymentDueAt.getTime() > now.getTime())
        return false;

      await this.requests.lockForUpdate(tx, p.requestId);
      await tx
        .update(sessionParticipants)
        .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
        .where(
          and(eq(sessionParticipants.id, p.id), eq(sessionParticipants.status, 'PENDING_PAYMENT')),
        );
      const [session] = await tx
        .update(sessions)
        .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
        .where(and(eq(sessions.id, p.sessionId), eq(sessions.status, 'PENDING_PAYMENT')))
        .returning();
      if (session) await this.bidding.releaseInTx(tx, p.requestId, session.bidId);
      await this.requests.transitionInTx(tx, p.requestId, ['RESERVED'], 'OPEN');
      await this.outbox.add(tx, 'booking.payment_expired', {
        requestId: p.requestId,
        studentUserId: p.studentUserId,
        tutorUserId: session?.tutorUserId ?? null,
        sessionId: p.sessionId,
      });
      return true;
    });
  }

  /** Safety net for missed delayed jobs. */
  async sweepExpiredPayments(limit = 200): Promise<number> {
    const due = await this.db
      .select({ id: sessionParticipants.id })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(
        and(
          eq(sessionParticipants.status, 'PENDING_PAYMENT'),
          lte(sessionParticipants.paymentDueAt, this.clock.now()),
          isNull(sessions.poolId),
        ),
      )
      .orderBy(asc(sessionParticipants.paymentDueAt))
      .limit(limit);
    let n = 0;
    for (const { id } of due) if (await this.expireParticipant(id)) n++;
    return n;
  }

  // ================= For payments (Part 9) =================

  async findParticipant(id: string, tx: DbExecutor = this.db): Promise<ParticipantRow | null> {
    const [row] = await tx.select().from(sessionParticipants).where(eq(sessionParticipants.id, id));
    return row ?? null;
  }

  /**
   * Payment verified for this participant. Locks the session first, so concurrent payments for a
   * group session serialize and can never exceed maxSeats. PENDING_PAYMENT (not past due) ->
   * CONFIRMED, request -> BOOKED; the session becomes SCHEDULED once minSeats have paid (1 for
   * one-to-one). Returns false when the seat is no longer payable; the caller refunds.
   */
  async confirmPaidInTx(tx: DbExecutor, participantId: string): Promise<boolean> {
    const now = this.clock.now();
    const [peek] = await tx
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, participantId));
    if (!peek) return false;
    const session = await this.lockSession(tx, peek.sessionId);
    const [p] = await tx
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, participantId))
      .for('update');
    if (
      !session ||
      !p ||
      p.status !== 'PENDING_PAYMENT' ||
      p.paymentDueAt.getTime() <= now.getTime()
    )
      return false;
    if (session.status !== 'PENDING_PAYMENT' && session.status !== 'SCHEDULED') return false;

    const paid = await this.paidCount(tx, session.id);
    if (paid >= session.maxSeats) return false; // group full

    await tx
      .update(sessionParticipants)
      .set({ status: 'CONFIRMED', confirmedAt: now, updatedAt: now })
      .where(eq(sessionParticipants.id, p.id));
    await this.requests.transitionInTx(tx, p.requestId, ['RESERVED'], 'BOOKED');
    if (session.poolId === null) await this.bidding.rejectHeldInTx(tx, p.requestId);

    if (session.status === 'PENDING_PAYMENT' && paid + 1 >= session.minSeats) {
      await tx
        .update(sessions)
        .set({ status: 'SCHEDULED', updatedAt: now })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, 'PENDING_PAYMENT')));
      await this.outbox.add(tx, 'session.scheduled', {
        sessionId: session.id,
        poolId: session.poolId,
        requestId: p.requestId,
        studentUserId: p.studentUserId,
        tutorUserId: session.tutorUserId,
        startsAt: session.startsAt.toISOString(),
      });
    } else if (session.status === 'SCHEDULED') {
      // A later group member paid after the session was already confirmed.
      await this.outbox.add(tx, 'session.scheduled', {
        sessionId: session.id,
        poolId: session.poolId,
        requestId: p.requestId,
        studentUserId: p.studentUserId,
        tutorUserId: null,
        startsAt: session.startsAt.toISOString(),
      });
    }
    return true;
  }

  private async paidCount(tx: DbExecutor, sessionId: string): Promise<number> {
    const rows = await tx
      .select({ id: sessionParticipants.id })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          inArray(sessionParticipants.status, ['CONFIRMED', 'JOINED', 'ATTENDED', 'ABSENT']),
        ),
      );
    return rows.length;
  }

  // ================= Group sessions (Part 19) =================

  /** Creates the PENDING_PAYMENT session for an accepted pool bid. */
  async createPoolSessionInTx(
    tx: DbExecutor,
    input: {
      bidId: string;
      poolId: string;
      tutorUserId: string;
      skillId: string;
      startsAt: Date;
      durationMinutes: number;
      seatPricePaise: number;
      minSeats: number;
      maxSeats: number;
    },
  ): Promise<SessionRow> {
    const now = this.clock.now();
    const [row] = await tx
      .insert(sessions)
      .values({ ...input, createdAt: now, updatedAt: now })
      .returning();
    return row!;
  }

  /** Adds one pool member as a PENDING_PAYMENT participant (their own seat and payment). */
  async addPoolParticipantInTx(
    tx: DbExecutor,
    input: {
      sessionId: string;
      studentUserId: string;
      requestId: string;
      amountPaise: number;
      paymentDueAt: Date;
    },
  ): Promise<ParticipantRow> {
    const now = this.clock.now();
    try {
      const [row] = await tx
        .insert(sessionParticipants)
        .values({ ...input, createdAt: now, updatedAt: now })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict('ALREADY_JOINED', 'You already accepted this offer.');
      throw err;
    }
  }

  async findSessionParticipant(
    sessionId: string,
    requestId: string,
  ): Promise<ParticipantRow | null> {
    const [row] = await this.db
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.requestId, requestId),
        ),
      );
    return row ?? null;
  }

  /** Deadline passed with paid members: cancel the ones who never paid and reopen their requests. */
  async cancelUnpaidInTx(tx: DbExecutor, sessionId: string): Promise<ParticipantRow[]> {
    const now = this.clock.now();
    const cancelled = await tx
      .update(sessionParticipants)
      .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.status, 'PENDING_PAYMENT'),
        ),
      )
      .returning();
    for (const p of cancelled)
      await this.requests.transitionInTx(tx, p.requestId, ['RESERVED'], 'OPEN');
    return cancelled;
  }

  /** Not enough seats paid by the deadline: cancel the whole group session and reopen every request. */
  async cancelPoolSessionInTx(tx: DbExecutor, sessionId: string): Promise<ParticipantRow[]> {
    const now = this.clock.now();
    await tx
      .update(sessions)
      .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'PENDING_PAYMENT')));
    const cancelled = await tx
      .update(sessionParticipants)
      .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          inArray(sessionParticipants.status, ['PENDING_PAYMENT', 'CONFIRMED']),
        ),
      )
      .returning();
    for (const p of cancelled)
      await this.requests.transitionInTx(tx, p.requestId, ['RESERVED', 'BOOKED'], 'OPEN');
    return cancelled;
  }

  /** Participants of a session (any state), for refunds after a group cancellation. */
  async participantIdsOf(sessionId: string): Promise<string[]> {
    return (await this.participantsOf(sessionId)).map((p) => p.id);
  }

  // ================= Live sessions (Parts 11-12) =================

  async getSession(id: string, tx: DbExecutor = this.db): Promise<SessionRow | null> {
    const [row] = await tx.select().from(sessions).where(eq(sessions.id, id));
    return row ?? null;
  }

  async participantsOf(sessionId: string, tx: DbExecutor = this.db): Promise<ParticipantRow[]> {
    return tx
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, sessionId));
  }

  /** Locks the session row for the rest of the caller's transaction. */
  async lockSession(tx: DbExecutor, id: string): Promise<SessionRow | null> {
    const [row] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update');
    return row ?? null;
  }

  /** First person joined: SCHEDULED -> LIVE. Returns true if the status changed. */
  async markLiveInTx(tx: DbExecutor, sessionId: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await tx
      .update(sessions)
      .set({ status: 'LIVE', liveAt: now, updatedAt: now })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'SCHEDULED')))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  async markTutorJoinedInTx(tx: DbExecutor, sessionId: string): Promise<void> {
    const now = this.clock.now();
    await tx
      .update(sessions)
      .set({ tutorJoinedAt: now, updatedAt: now })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.tutorJoinedAt)));
  }

  /** CONFIRMED -> JOINED for a paid learner. Returns true if the status changed. */
  async markParticipantJoinedInTx(
    tx: DbExecutor,
    sessionId: string,
    studentUserId: string,
  ): Promise<boolean> {
    const now = this.clock.now();
    const rows = await tx
      .update(sessionParticipants)
      .set({ status: 'JOINED', joinedAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          eq(sessionParticipants.studentUserId, studentUserId),
          eq(sessionParticipants.status, 'CONFIRMED'),
        ),
      )
      .returning({ id: sessionParticipants.id });
    return rows.length > 0;
  }

  /**
   * LIVE -> ENDED. Learners who joined become ATTENDED, the rest ABSENT; the request is COMPLETED.
   * Returns the ended session, or null if it was not LIVE.
   */
  async endSessionInTx(tx: DbExecutor, sessionId: string): Promise<SessionRow | null> {
    const now = this.clock.now();
    const [row] = await tx
      .update(sessions)
      .set({ status: 'ENDED', endedAt: now, updatedAt: now })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'LIVE')))
      .returning();
    if (!row) return null;
    const parts = await this.participantsOf(sessionId, tx);
    for (const p of parts) {
      const next = p.status === 'JOINED' ? 'ATTENDED' : p.status === 'CONFIRMED' ? 'ABSENT' : null;
      if (!next) continue;
      await tx
        .update(sessionParticipants)
        .set({ status: next, updatedAt: now })
        .where(and(eq(sessionParticipants.id, p.id), eq(sessionParticipants.status, p.status)));
      await this.requests.transitionInTx(tx, p.requestId, ['BOOKED'], 'COMPLETED');
    }
    return row;
  }

  /**
   * Tutor never joined: SCHEDULED|LIVE -> NO_SHOW, paid learners -> CANCELLED, requests reopen
   * (BOOKED -> OPEN) and the accepted bid expires. Returns the cancelled participants, or null.
   */
  async markNoShowInTx(tx: DbExecutor, sessionId: string): Promise<ParticipantRow[] | null> {
    const now = this.clock.now();
    const [row] = await tx
      .update(sessions)
      .set({ status: 'NO_SHOW', updatedAt: now })
      .where(
        and(
          eq(sessions.id, sessionId),
          inArray(sessions.status, ['SCHEDULED', 'LIVE']),
          isNull(sessions.tutorJoinedAt),
        ),
      )
      .returning();
    if (!row) return null;
    const cancelled = await tx
      .update(sessionParticipants)
      .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionParticipants.sessionId, sessionId),
          inArray(sessionParticipants.status, ['CONFIRMED', 'JOINED']),
        ),
      )
      .returning();
    for (const p of cancelled) {
      await this.requests.transitionInTx(tx, p.requestId, ['BOOKED'], 'OPEN');
    }
    await this.bidding.expireAcceptedInTx(tx, row.bidId);
    return cancelled;
  }

  /** Sessions whose tutor still hasn't joined after start + grace. */
  async dueNoShows(graceMinutes: number, limit = 200): Promise<string[]> {
    const cutoff = new Date(this.clock.nowMs() - graceMinutes * 60_000);
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          inArray(sessions.status, ['SCHEDULED', 'LIVE']),
          isNull(sessions.tutorJoinedAt),
          lte(sessions.startsAt, cutoff),
        ),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /** Participants of sessions that ended at or before `cutoff` (candidates for releasing held money). */
  async participantsEndedBefore(
    cutoff: Date,
    limit = 500,
  ): Promise<
    Array<{ participantId: string; sessionId: string; tutorUserId: string; endedAt: Date }>
  > {
    const rows = await this.db
      .select({
        participantId: sessionParticipants.id,
        sessionId: sessions.id,
        tutorUserId: sessions.tutorUserId,
        endedAt: sessions.endedAt,
      })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(
        and(
          eq(sessions.status, 'ENDED'),
          lte(sessions.endedAt, cutoff),
          inArray(sessionParticipants.status, ['ATTENDED', 'ABSENT']),
        ),
      )
      .limit(limit);
    return rows.map((r) => ({ ...r, endedAt: r.endedAt! }));
  }

  /** Cancelled participants of tutor no-show sessions (their payments must be refunded). */
  async noShowParticipantIds(limit = 500): Promise<string[]> {
    const rows = await this.db
      .select({ id: sessionParticipants.id })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(and(eq(sessions.status, 'NO_SHOW'), eq(sessionParticipants.status, 'CANCELLED')))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async participantIdsForTutor(tutorUserId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: sessionParticipants.id })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(eq(sessions.tutorUserId, tutorUserId));
    return rows.map((r) => r.id);
  }

  /**
   * Throws unless the caller is the session's tutor (tutor app) or a learner in one of
   * `allowed` states (student app). Returns the session.
   */
  async assertMember(
    user: AuthUser,
    sessionId: string,
    allowed: ParticipantRow['status'][] = ['CONFIRMED', 'JOINED', 'ATTENDED', 'ABSENT'],
  ): Promise<SessionRow> {
    const session = await this.getSession(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (user.app === 'tutor' && session.tutorUserId === user.id) return session;
    if (user.app === 'student') {
      const parts = await this.participantsOf(sessionId);
      if (parts.some((p) => p.studentUserId === user.id && allowed.includes(p.status)))
        return session;
    }
    throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
  }

  // ================= Reads =================

  async listForStudent(student: AuthUser): Promise<BookingView[]> {
    const rows = await this.db
      .select({ s: sessions, p: sessionParticipants })
      .from(sessionParticipants)
      .innerJoin(sessions, eq(sessions.id, sessionParticipants.sessionId))
      .where(eq(sessionParticipants.studentUserId, student.id))
      .orderBy(desc(sessionParticipants.createdAt))
      .limit(100);
    return rows.map((r) => toView(r.s, r.p));
  }

  async listForTutor(tutor: AuthUser): Promise<BookingView[]> {
    const rows = await this.db
      .select({ s: sessions, p: sessionParticipants })
      .from(sessions)
      .innerJoin(sessionParticipants, eq(sessionParticipants.sessionId, sessions.id))
      .where(eq(sessions.tutorUserId, tutor.id))
      .orderBy(desc(sessions.startsAt))
      .limit(100);
    return rows.map((r) => toView(r.s, r.p));
  }

  private async scheduleExpiry(participantId: string, dueAt: Date): Promise<void> {
    try {
      await this.queue.add(
        PAYMENT_EXPIRY_JOB,
        { participantId },
        {
          jobId: `expiry-${participantId}`,
          // A little slack so the job never fires before the due time; the job re-checks the clock.
          delay: Math.max(0, dueAt.getTime() - this.clock.nowMs()) + 1_000,
        },
      );
    } catch (err) {
      this.logger.warn(
        { err, participantId },
        'Could not schedule payment expiry; the sweep will handle it',
      );
    }
  }
}
