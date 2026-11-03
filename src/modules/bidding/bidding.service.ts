import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { UploadsService } from '../../platform/storage/uploads.service';
import { assertOwnership } from '../identity/auth/ownership';
import { ModerationService } from '../moderation/moderation.service';
import { RequestsService } from '../requests/requests.service';
import type { LearningRequestRow } from '../requests/requests.schema';
import { TutorsService } from '../tutors/tutors.service';
import { MasteryService } from '../mastery/mastery.service';
import { ACTIVE_BID_STATUSES, bids, type BidRow, type BidStatus } from './bidding.schema';
import { scoreBids, type BidScore } from './scoring';

const MIN_LEAD_MS = 15 * 60_000;
const MAX_LEAD_MS = 30 * 86_400_000;

export interface BidInput {
  seatPricePaise: number;
  proposedStartAt: string;
  durationMinutes: number;
  approachText?: string;
  approachMediaKey?: string;
}

/** The tutor's own bid. */
export interface OwnBidView {
  id: string;
  requestId: string | null;
  seatPricePaise: number;
  currency: 'INR';
  proposedStartAt: string;
  durationMinutes: number;
  approachText: string | null;
  hasApproachMedia: boolean;
  status: BidStatus;
  createdAt: string;
  updatedAt: string;
}

/** What the learner sees for each bid on their request. */
export interface StudentBidView extends OwnBidView {
  tutor: { userId: string; fullName: string; badge: string; headline: string };
  approachMediaUrl: string | null;
  score: BidScore;
}

export type BidSort = 'score' | 'price' | 'time';

/** Payload for realtime; the price only ever goes to the request owner. */
export interface BidEventPayload extends Record<string, unknown> {
  requestId: string;
  studentUserId: string;
  tutorUserId: string;
  bidId: string;
  bidCount: number;
  ownerBid: OwnBidView;
}

function toOwnView(b: BidRow): OwnBidView {
  return {
    id: b.id,
    requestId: b.requestId,
    seatPricePaise: b.seatPricePaise,
    currency: 'INR',
    proposedStartAt: b.proposedStartAt.toISOString(),
    durationMinutes: b.durationMinutes,
    approachText: b.approachText,
    hasApproachMedia: b.approachMediaKey !== null,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/**
 * Owns `bids`. Sealed: tutors never see other tutors' prices, only the count.
 * Also coordinates request closing (cancel/expiry) with bid expiry in one transaction.
 */
@Injectable()
export class BiddingService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly requests: RequestsService,
    private readonly tutors: TutorsService,
    private readonly moderation: ModerationService,
    private readonly uploads: UploadsService,
    private readonly outbox: OutboxService,
    private readonly mastery: MasteryService,
  ) {}

  // ================= Tutor =================

  async create(tutor: AuthUser, requestId: string, input: BidInput): Promise<OwnBidView> {
    const request = await this.requests.find(requestId);
    if (!request) throw AppError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
    await this.assertEligible(tutor, request);
    const clean = await this.prepare(tutor, input);

    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      // Lock the request so the status check and the bid insert can't race a cancel/expiry.
      const locked = await this.requests.lockForUpdate(tx, requestId);
      if (locked?.status !== 'OPEN') {
        throw AppError.conflict('REQUEST_NOT_OPEN', 'This request is no longer taking bids.', {
          status: locked?.status ?? null,
        });
      }
      let row: BidRow;
      try {
        [row] = (await tx
          .insert(bids)
          .values({ requestId, tutorUserId: tutor.id, ...clean, createdAt: now, updatedAt: now })
          .returning()) as [BidRow];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw AppError.conflict('BID_EXISTS', 'You already have an active bid on this request.');
        }
        throw err;
      }
      await this.emit(tx, 'bid.created', locked, row);
      return toOwnView(row);
    });
  }

  /** Edit price/time/approach while SUBMITTED. */
  async update(tutor: AuthUser, bidId: string, input: Partial<BidInput>): Promise<OwnBidView> {
    const current = await this.requireOwnBid(tutor, bidId);
    const request = current.requestId ? await this.requests.find(current.requestId) : null;
    if (!request) throw AppError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
    await this.assertEligible(tutor, request);
    const merged: BidInput = {
      seatPricePaise: input.seatPricePaise ?? current.seatPricePaise,
      proposedStartAt: input.proposedStartAt ?? current.proposedStartAt.toISOString(),
      durationMinutes: input.durationMinutes ?? current.durationMinutes,
      approachText: input.approachText ?? current.approachText ?? undefined,
      approachMediaKey: input.approachMediaKey ?? current.approachMediaKey ?? undefined,
    };
    const clean = await this.prepare(tutor, merged, bidId);
    return this.db.transaction(async (tx) => {
      const locked = await this.requests.lockForUpdate(tx, request.id);
      if (locked?.status !== 'OPEN') {
        throw AppError.conflict('REQUEST_NOT_OPEN', 'This request is no longer taking bids.');
      }
      const [row] = await tx
        .update(bids)
        .set({ ...clean, updatedAt: this.clock.now() })
        .where(and(eq(bids.id, bidId), eq(bids.status, 'SUBMITTED')))
        .returning();
      if (!row) throw this.invalidState(current.status, 'edited');
      await this.emit(tx, 'bid.updated', locked, row);
      return toOwnView(row);
    });
  }

  /** SUBMITTED -> WITHDRAWN. */
  async withdraw(tutor: AuthUser, bidId: string): Promise<OwnBidView> {
    const current = await this.requireOwnBid(tutor, bidId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(bids)
        .set({ status: 'WITHDRAWN', updatedAt: this.clock.now() })
        .where(and(eq(bids.id, bidId), eq(bids.status, 'SUBMITTED')))
        .returning();
      if (!row) throw this.invalidState(current.status, 'withdrawn');
      const request = row.requestId ? await this.requests.find(row.requestId, tx) : null;
      if (request) await this.emit(tx, 'bid.withdrawn', request, row);
      return toOwnView(row);
    });
  }

  async listOwn(tutor: AuthUser, status?: BidStatus): Promise<OwnBidView[]> {
    const rows = await this.db
      .select()
      .from(bids)
      .where(and(eq(bids.tutorUserId, tutor.id), status ? eq(bids.status, status) : undefined))
      .orderBy(desc(bids.createdAt))
      .limit(200);
    return rows.map(toOwnView);
  }

  /** Tutor's view of one request: the request, the bid count and only their own bid. */
  async tutorRequestView(tutor: AuthUser, requestId: string) {
    const request = await this.requests.find(requestId);
    if (!request || (request.status !== 'OPEN' && !(await this.hasBid(tutor.id, requestId)))) {
      throw AppError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
    }
    if (!(await this.tutors.canTeach(tutor.id, request.skillId))) {
      throw AppError.forbidden('SKILL_NOT_APPROVED', 'You are not approved to teach this skill.');
    }
    const [view, bidCount, mine] = await Promise.all([
      this.requests.toTutorView(request),
      this.countActive(requestId),
      this.db
        .select()
        .from(bids)
        .where(and(eq(bids.requestId, requestId), eq(bids.tutorUserId, tutor.id)))
        .orderBy(desc(bids.createdAt))
        .limit(1),
    ]);
    return { ...view, bidCount, myBid: mine[0] ? toOwnView(mine[0]) : null };
  }

  async countActive(requestId: string, tx: DbExecutor = this.db): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(bids)
      .where(and(eq(bids.requestId, requestId), inArray(bids.status, [...ACTIVE_BID_STATUSES])));
    return row?.n ?? 0;
  }

  async countsFor(requestIds: string[]): Promise<Map<string, number>> {
    if (requestIds.length === 0) return new Map();
    const rows = await this.db
      .select({ requestId: bids.requestId, n: count() })
      .from(bids)
      .where(
        and(inArray(bids.requestId, requestIds), inArray(bids.status, [...ACTIVE_BID_STATUSES])),
      )
      .groupBy(bids.requestId);
    return new Map(rows.map((r) => [r.requestId!, r.n]));
  }

  // ================= Student =================

  /** Every bid on the learner's request, with prices and a score explanation. */
  async listForStudent(
    student: AuthUser,
    requestId: string,
    sort: BidSort,
  ): Promise<StudentBidView[]> {
    const request = await this.requests.find(requestId);
    if (!request) throw AppError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
    assertOwnership(student, request.studentUserId);

    const rows = await this.db
      .select()
      .from(bids)
      .where(and(eq(bids.requestId, requestId), inArray(bids.status, [...ACTIVE_BID_STATUSES])));
    if (rows.length === 0) return [];
    const masteryByTutor = await this.mastery.scores(
      rows.map((r) => r.tutorUserId),
      request.skillId,
    );
    const scores = scoreBids(
      rows.map((r) => ({ ...r, mastery: masteryByTutor.get(r.tutorUserId)?.score ?? null })),
    );
    const cards = await this.tutors.cards(rows.map((r) => r.tutorUserId));
    const views = await Promise.all(
      rows.map(async (r) => ({
        ...toOwnView(r),
        tutor: cards.get(r.tutorUserId) ?? {
          userId: r.tutorUserId,
          fullName: '',
          badge: 'NONE',
          headline: '',
        },
        approachMediaUrl: r.approachMediaKey
          ? await this.uploads.readUrl(r.approachMediaKey)
          : null,
        score: scores.get(r.id)!,
      })),
    );
    const by: Record<BidSort, (a: StudentBidView, b: StudentBidView) => number> = {
      score: (a, b) => b.score.total - a.score.total || a.seatPricePaise - b.seatPricePaise,
      price: (a, b) => a.seatPricePaise - b.seatPricePaise || b.score.total - a.score.total,
      time: (a, b) =>
        a.proposedStartAt.localeCompare(b.proposedStartAt) || a.seatPricePaise - b.seatPricePaise,
    };
    return views.sort(by[sort]);
  }

  /** Cancels the learner's request and expires its open bids atomically. */
  async cancelRequest(student: AuthUser, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.requests.cancelInTx(tx, student, requestId);
      await this.expireForRequests(tx, [requestId]);
    });
  }

  // ================= Pool bids (Part 19) =================

  /**
   * A sealed bid on a group. Same rules as one-to-one bids (verified, approved for the skill,
   * not restricted) plus seat limits: 2 <= minSeats <= maxSeats <= POOL_MAX_SEATS.
   */
  async createForPool(
    tutor: AuthUser,
    pool: { id: string; skillId: string; status: string },
    input: BidInput & { minSeats: number; maxSeats: number },
    poolMaxSeats: number,
  ): Promise<OwnBidView> {
    if (pool.status !== 'FORMING' && pool.status !== 'BIDDING') {
      throw AppError.conflict('POOL_NOT_OPEN', 'This group is not taking bids.', {
        status: pool.status,
      });
    }
    if (input.minSeats < 2 || input.maxSeats < input.minSeats || input.maxSeats > poolMaxSeats) {
      throw AppError.badRequest(
        'INVALID_SEATS',
        `Seats must satisfy 2 <= minSeats <= maxSeats <= ${poolMaxSeats}.`,
      );
    }
    if (!(await this.tutors.canTeach(tutor.id, pool.skillId))) {
      throw AppError.forbidden('SKILL_NOT_APPROVED', 'You are not approved to teach this skill.');
    }
    await this.moderation.assertCanBid(tutor.id);
    const clean = await this.prepare(tutor, input);
    const now = this.clock.now();
    try {
      const [row] = await this.db
        .insert(bids)
        .values({
          poolId: pool.id,
          tutorUserId: tutor.id,
          ...clean,
          minSeats: input.minSeats,
          maxSeats: input.maxSeats,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toOwnView(row!);
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict('BID_EXISTS', 'You already have an active bid on this group.');
      throw err;
    }
  }

  async listForPool(poolId: string, skillId: string): Promise<StudentBidView[]> {
    const rows = await this.db
      .select()
      .from(bids)
      .where(and(eq(bids.poolId, poolId), inArray(bids.status, [...ACTIVE_BID_STATUSES])));
    if (rows.length === 0) return [];
    const mastery = await this.mastery.scores(
      rows.map((r) => r.tutorUserId),
      skillId,
    );
    const scores = scoreBids(
      rows.map((r) => ({ ...r, mastery: mastery.get(r.tutorUserId)?.score ?? null })),
    );
    const cards = await this.tutors.cards(rows.map((r) => r.tutorUserId));
    return rows
      .map((r) => ({
        ...toOwnView(r),
        minSeats: r.minSeats,
        maxSeats: r.maxSeats,
        tutor: cards.get(r.tutorUserId) ?? {
          userId: r.tutorUserId,
          fullName: '',
          badge: 'NONE',
          headline: '',
        },
        approachMediaUrl: null,
        score: scores.get(r.id)!,
      }))
      .sort((a, b) => b.score.total - a.score.total);
  }

  /** The chosen pool bid -> ACCEPTED, the rest -> HELD. */
  async acceptPoolBidInTx(tx: DbExecutor, poolId: string, bidId: string): Promise<BidRow | null> {
    const [row] = await tx
      .update(bids)
      .set({ status: 'ACCEPTED', updatedAt: this.clock.now() })
      .where(and(eq(bids.id, bidId), eq(bids.poolId, poolId), eq(bids.status, 'SUBMITTED')))
      .returning();
    if (!row) return null;
    await tx
      .update(bids)
      .set({ status: 'HELD', updatedAt: this.clock.now() })
      .where(and(eq(bids.poolId, poolId), eq(bids.status, 'SUBMITTED'), ne(bids.id, bidId)));
    return row;
  }

  /** Group confirmed: HELD -> REJECTED. Group expired: every active bid -> EXPIRED. */
  async closePoolBidsInTx(
    tx: DbExecutor,
    poolId: string,
    outcome: 'CONFIRMED' | 'EXPIRED',
  ): Promise<void> {
    const now = this.clock.now();
    if (outcome === 'CONFIRMED') {
      await tx
        .update(bids)
        .set({ status: 'REJECTED', updatedAt: now })
        .where(and(eq(bids.poolId, poolId), eq(bids.status, 'HELD')));
    } else {
      await tx
        .update(bids)
        .set({ status: 'EXPIRED', updatedAt: now })
        .where(
          and(eq(bids.poolId, poolId), inArray(bids.status, ['SUBMITTED', 'HELD', 'ACCEPTED'])),
        );
    }
  }

  // ================= Booking (Parts 7 and 9) =================

  async findBid(id: string, tx: DbExecutor = this.db): Promise<BidRow | null> {
    const [row] = await tx.select().from(bids).where(eq(bids.id, id));
    return row ?? null;
  }

  /** SUBMITTED -> ACCEPTED. Returns false if the bid was not SUBMITTED. */
  async acceptInTx(tx: DbExecutor, bidId: string): Promise<boolean> {
    const rows = await tx
      .update(bids)
      .set({ status: 'ACCEPTED', updatedAt: this.clock.now() })
      .where(and(eq(bids.id, bidId), eq(bids.status, 'SUBMITTED')))
      .returning({ id: bids.id });
    return rows.length > 0;
  }

  /** Other SUBMITTED bids on the request -> HELD while the learner pays. */
  async holdOthersInTx(tx: DbExecutor, requestId: string, acceptedBidId: string): Promise<void> {
    await tx
      .update(bids)
      .set({ status: 'HELD', updatedAt: this.clock.now() })
      .where(
        and(
          eq(bids.requestId, requestId),
          eq(bids.status, 'SUBMITTED'),
          ne(bids.id, acceptedBidId),
        ),
      );
  }

  /** Payment window missed: ACCEPTED -> EXPIRED and HELD -> SUBMITTED. */
  async releaseInTx(tx: DbExecutor, requestId: string, acceptedBidId: string): Promise<void> {
    const now = this.clock.now();
    await tx
      .update(bids)
      .set({ status: 'EXPIRED', updatedAt: now })
      .where(and(eq(bids.id, acceptedBidId), eq(bids.status, 'ACCEPTED')));
    await tx
      .update(bids)
      .set({ status: 'SUBMITTED', updatedAt: now })
      .where(and(eq(bids.requestId, requestId), eq(bids.status, 'HELD')));
  }

  /** Tutor no-show: ACCEPTED -> EXPIRED. */
  async expireAcceptedInTx(tx: DbExecutor, bidId: string): Promise<void> {
    await tx
      .update(bids)
      .set({ status: 'EXPIRED', updatedAt: this.clock.now() })
      .where(and(eq(bids.id, bidId), eq(bids.status, 'ACCEPTED')));
  }

  /** Payment confirmed: HELD -> REJECTED. */
  async rejectHeldInTx(tx: DbExecutor, requestId: string): Promise<void> {
    await tx
      .update(bids)
      .set({ status: 'REJECTED', updatedAt: this.clock.now() })
      .where(and(eq(bids.requestId, requestId), eq(bids.status, 'HELD')));
  }

  // ================= Worker sweep =================

  /** Expires OPEN requests whose window ended, and their bids. Safe to run repeatedly. */
  async expireDueRequests(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const expired = await this.requests.expireDueInTx(tx);
      await this.expireForRequests(
        tx,
        expired.map((r) => r.id),
      );
      return expired.length;
    });
  }

  private async expireForRequests(tx: DbExecutor, requestIds: string[]): Promise<void> {
    if (requestIds.length === 0) return;
    await tx
      .update(bids)
      .set({ status: 'EXPIRED', updatedAt: this.clock.now() })
      .where(and(inArray(bids.requestId, requestIds), inArray(bids.status, ['SUBMITTED', 'HELD'])));
  }

  // ================= Helpers =================

  private async assertEligible(tutor: AuthUser, request: LearningRequestRow): Promise<void> {
    if (request.studentUserId === tutor.id) {
      throw AppError.forbidden('OWN_REQUEST', 'You cannot bid on your own request.');
    }
    if (!(await this.tutors.canTeach(tutor.id, request.skillId))) {
      throw AppError.forbidden('SKILL_NOT_APPROVED', 'You are not approved to teach this skill.');
    }
    await this.moderation.assertCanBid(tutor.id);
  }

  private async prepare(tutor: AuthUser, input: BidInput, bidId?: string) {
    const start = new Date(input.proposedStartAt);
    const lead = start.getTime() - this.clock.nowMs();
    if (Number.isNaN(start.getTime()) || lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) {
      throw AppError.badRequest(
        'INVALID_START_TIME',
        'Proposed start must be between 15 minutes and 30 days from now.',
      );
    }
    if (!Number.isSafeInteger(input.seatPricePaise) || input.seatPricePaise <= 0) {
      throw AppError.badRequest(
        'INVALID_PRICE',
        'Seat price must be a positive whole number of paise.',
      );
    }
    const text = input.approachText?.trim() || undefined;
    if (!text && !input.approachMediaKey) {
      throw AppError.badRequest(
        'APPROACH_REQUIRED',
        'Explain your approach in text or attach a short intro video/audio.',
      );
    }
    const approachText = text
      ? await this.moderation.screen(tutor.id, text, {
          entityType: 'BID',
          entityId: bidId ?? null,
          field: 'approachText',
        })
      : null;
    if (input.approachMediaKey) {
      await this.uploads.verify(tutor.id, 'BID_MEDIA', input.approachMediaKey);
    }
    return {
      seatPricePaise: input.seatPricePaise,
      proposedStartAt: start,
      durationMinutes: input.durationMinutes,
      approachText,
      approachMediaKey: input.approachMediaKey ?? null,
    };
  }

  private async emit(
    tx: DbExecutor,
    type: string,
    request: LearningRequestRow,
    bid: BidRow,
  ): Promise<void> {
    const payload: BidEventPayload = {
      requestId: request.id,
      studentUserId: request.studentUserId,
      tutorUserId: bid.tutorUserId,
      bidId: bid.id,
      bidCount: await this.countActive(request.id, tx),
      ownerBid: toOwnView(bid),
    };
    await this.outbox.add(tx, type, payload);
  }

  private async hasBid(tutorId: string, requestId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: bids.id })
      .from(bids)
      .where(and(eq(bids.tutorUserId, tutorId), eq(bids.requestId, requestId)))
      .limit(1);
    return Boolean(row);
  }

  private async requireOwnBid(tutor: AuthUser, bidId: string): Promise<BidRow> {
    const [row] = await this.db.select().from(bids).where(eq(bids.id, bidId));
    if (!row) throw AppError.notFound('BID_NOT_FOUND', 'Bid not found.');
    assertOwnership(tutor, row.tutorUserId);
    return row;
  }

  private invalidState(status: BidStatus, verb: string): AppError {
    return AppError.conflict('INVALID_BID_STATE', `A ${status} bid cannot be ${verb}.`, { status });
  }
}
