import { Injectable, Logger, Module } from '@nestjs/common';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { BiddingModule } from '../bidding/bidding.module';
import { BiddingService, type BidInput } from '../bidding/bidding.service';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { PoolingModule, PoolingService } from '../pooling/pooling.service';
import { RequestsModule } from '../requests/requests.module';
import { RequestsService } from '../requests/requests.service';
import { BookingService } from '../sessions/booking.service';
import { SessionsModule } from '../sessions/sessions.module';
import { TutorsModule } from '../tutors/tutors.module';
import { TutorsService } from '../tutors/tutors.service';

/**
 * Part 19: bids on pools and group payments.
 * - Tutors bid a seat price with min/max seats. Members see all offers.
 * - The first member to accept an offer fixes it for the group and starts the payment deadline;
 *   each member then accepts and pays for their own seat (own payment, dispute, release, refund).
 * - Once minSeats have paid, the session is SCHEDULED. At most maxSeats can pay.
 * - If fewer than minSeats paid by the deadline, everyone is refunded, the pool expires and each
 *   request reopens.
 */
@Injectable()
export class GroupBookingService {
  private readonly logger = new Logger(GroupBookingService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly pooling: PoolingService,
    private readonly bidding: BiddingService,
    private readonly booking: BookingService,
    private readonly requests: RequestsService,
    private readonly payments: PaymentsService,
    private readonly outbox: OutboxService,
    private readonly tutors: TutorsService,
  ) {}

  async placeBid(
    tutor: AuthUser,
    poolId: string,
    input: BidInput & { minSeats: number; maxSeats: number },
  ) {
    const pool = await this.pooling.getPool(poolId);
    if (!pool) throw AppError.notFound('POOL_NOT_FOUND', 'Group not found.');
    if ((await this.pooling.memberCount(poolId)) < 2) {
      throw AppError.conflict(
        'POOL_TOO_SMALL',
        'This group needs at least two members before bids.',
      );
    }
    const bid = await this.bidding.createForPool(
      tutor,
      pool,
      input,
      this.config.env.POOL_MAX_SEATS,
    );
    await this.db.transaction((tx) =>
      this.pooling.setStatusInTx(tx, poolId, ['FORMING'], 'BIDDING'),
    );
    return bid;
  }

  /** Groups a verified tutor can bid on: their approved skills, at least two members. Members stay anonymous. */
  async listOpenPools(tutor: AuthUser) {
    const pools = await this.pooling.openPools(await this.tutors.teachableSkillIds(tutor.id));
    const out = [];
    for (const p of pools) {
      const members = await this.pooling.memberCount(p.id);
      if (members < 2) continue;
      out.push({
        id: p.id,
        skillId: p.skillId,
        level: p.level,
        status: p.status,
        members,
        seatCap: p.seatCap,
      });
    }
    return out;
  }

  async listBids(student: AuthUser, poolId: string) {
    const pool = await this.requireMemberPool(student, poolId);
    return {
      poolId,
      status: pool.status,
      acceptedBidId: pool.acceptedBidId,
      bids: await this.bidding.listForPool(poolId, pool.skillId),
    };
  }

  /** A member accepts an offer and gets their own seat to pay for. */
  async acceptOffer(student: AuthUser, poolId: string, bidId: string) {
    const result = await this.db.transaction(async (tx) => {
      const pool = await this.pooling.lockPool(tx, poolId);
      if (!pool) throw AppError.notFound('POOL_NOT_FOUND', 'Group not found.');
      const member = await this.pooling.membership(student.id, poolId, tx);
      if (!member)
        throw AppError.forbidden('NOT_POOL_MEMBER', 'Join the group before accepting an offer.');

      let sessionId = pool.sessionId;
      let deadline = pool.paymentDeadline;
      if (pool.status === 'FORMING' || pool.status === 'BIDDING') {
        const bid = await this.bidding.acceptPoolBidInTx(tx, poolId, bidId);
        if (!bid)
          throw AppError.conflict('BID_ALREADY_ACCEPTED', 'This offer can no longer be accepted.');
        deadline = new Date(
          this.clock.nowMs() + this.config.env.POOL_PAYMENT_WINDOW_MINUTES * 60_000,
        );
        const session = await this.booking.createPoolSessionInTx(tx, {
          bidId,
          poolId,
          tutorUserId: bid.tutorUserId,
          skillId: pool.skillId,
          startsAt: bid.proposedStartAt,
          durationMinutes: bid.durationMinutes,
          seatPricePaise: bid.seatPricePaise,
          minSeats: bid.minSeats!,
          maxSeats: bid.maxSeats!,
        });
        sessionId = session.id;
        await this.pooling.setStatusInTx(tx, poolId, ['FORMING', 'BIDDING'], 'AWAITING_PAYMENTS', {
          acceptedBidId: bidId,
          sessionId,
          paymentDeadline: deadline,
        });
        await this.outbox.add(tx, 'pool.offer_accepted', {
          poolId,
          bidId,
          tutorUserId: bid.tutorUserId,
          sessionId,
        });
      } else if (pool.status !== 'AWAITING_PAYMENTS' || pool.acceptedBidId !== bidId) {
        throw AppError.conflict(
          'OTHER_OFFER_CHOSEN',
          'The group already chose a different offer.',
          {
            acceptedBidId: pool.acceptedBidId,
          },
        );
      }
      if (deadline! <= this.clock.now())
        throw AppError.conflict('PAYMENT_DEADLINE_PASSED', 'The payment deadline has passed.');

      const bid = await this.bidding.findBid(bidId, tx);
      await this.requests.lockForUpdate(tx, member.requestId);
      if (!(await this.requests.transitionInTx(tx, member.requestId, ['POOLED'], 'RESERVED'))) {
        throw AppError.conflict('REQUEST_NOT_POOLED', 'Your request is no longer in this group.');
      }
      const participant = await this.booking.addPoolParticipantInTx(tx, {
        sessionId: sessionId!,
        studentUserId: student.id,
        requestId: member.requestId,
        amountPaise: bid!.seatPricePaise,
        paymentDueAt: deadline!,
      });
      return {
        poolId,
        sessionId: sessionId!,
        participantId: participant.id,
        amountPaise: participant.amountPaise,
        currency: 'INR' as const,
        minSeats: bid!.minSeats,
        maxSeats: bid!.maxSeats,
        paymentDueAt: deadline!.toISOString(),
      };
    });
    return result;
  }

  /**
   * Deadline handling, idempotent:
   * - session already SCHEDULED (min reached): pool CONFIRMED once the deadline passes or seats are full;
   *   members who never paid are released.
   * - deadline passed below minSeats: cancel, refund every paid seat, expire the pool, reopen requests.
   */
  async sweep(): Promise<{ confirmed: number; expired: number; refunds: number }> {
    let confirmed = 0;
    let expired = 0;
    const now = this.clock.now();
    for (const pool of await this.pooling.awaitingPayments()) {
      if (!pool.sessionId || !pool.paymentDeadline) continue;
      const session = await this.booking.getSession(pool.sessionId);
      if (!session) continue;
      const parts = await this.booking.participantsOf(session.id);
      const paid = parts.filter((p) => p.status === 'CONFIRMED').length;
      const deadlinePassed = pool.paymentDeadline <= now;

      if (session.status === 'SCHEDULED' && (deadlinePassed || paid >= session.maxSeats)) {
        await this.db.transaction(async (tx) => {
          const memberRequests = await this.pooling.memberRequestIds(pool.id, tx);
          if (!(await this.pooling.setStatusInTx(tx, pool.id, ['AWAITING_PAYMENTS'], 'CONFIRMED')))
            return;
          await this.booking.cancelUnpaidInTx(tx, session.id);
          // Members who never accepted the offer go back to the open marketplace.
          for (const id of memberRequests)
            await this.requests.transitionInTx(tx, id, ['POOLED'], 'OPEN');
          await this.bidding.closePoolBidsInTx(tx, pool.id, 'CONFIRMED');
          await this.outbox.add(tx, 'pool.confirmed', {
            poolId: pool.id,
            sessionId: session.id,
            seats: paid,
          });
        });
        confirmed++;
      } else if (session.status === 'PENDING_PAYMENT' && deadlinePassed) {
        await this.db.transaction(async (tx) => {
          const memberRequests = await this.pooling.memberRequestIds(pool.id, tx);
          if (!(await this.pooling.setStatusInTx(tx, pool.id, ['AWAITING_PAYMENTS'], 'EXPIRED')))
            return;
          await this.booking.cancelPoolSessionInTx(tx, session.id);
          for (const id of memberRequests)
            await this.requests.transitionInTx(tx, id, ['POOLED'], 'OPEN');
          await this.bidding.closePoolBidsInTx(tx, pool.id, 'EXPIRED');
          await this.outbox.add(tx, 'pool.expired', {
            poolId: pool.id,
            sessionId: session.id,
            studentUserIds: parts.map((p) => p.studentUserId),
          });
        });
        expired++;
      }
    }
    return { confirmed, expired, refunds: await this.refundExpiredGroups() };
  }

  /** Refunds held payments of seats in cancelled group sessions. Retried every sweep until done. */
  private async refundExpiredGroups(): Promise<number> {
    let n = 0;
    for (const sessionId of await this.pooling.expiredSessionIds()) {
      const ids = await this.booking.participantIdsOf(sessionId);
      for (const pay of await this.payments.settledForParticipants(ids)) {
        if (pay.status !== 'HELD') continue;
        try {
          if (await this.payments.refundSettled(pay.id, 'POOL_MIN_SEATS_NOT_MET', null)) n++;
        } catch (err) {
          this.logger.error({ err, paymentId: pay.id }, 'Group refund failed; will retry');
        }
      }
    }
    return n;
  }

  private async requireMemberPool(student: AuthUser, poolId: string) {
    const pool = await this.pooling.getPool(poolId);
    if (!pool) throw AppError.notFound('POOL_NOT_FOUND', 'Group not found.');
    if (!(await this.pooling.membership(student.id, poolId))) {
      throw AppError.forbidden('NOT_POOL_MEMBER', 'Only group members can see offers.');
    }
    return pool;
  }
}

@Module({
  imports: [
    PoolingModule,
    BiddingModule,
    SessionsModule,
    RequestsModule,
    PaymentsModule,
    TutorsModule,
  ],
  providers: [GroupBookingService],
  exports: [GroupBookingService],
})
export class GroupBookingModule {}
