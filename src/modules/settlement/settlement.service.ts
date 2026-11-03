import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { AuditService } from '../../platform/audit/audit.service';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import { auditActor, type AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { UPI_GATEWAYS, type UpiGateways } from '../../providers/upi/upi-gateway';
import { assertOwnership } from '../identity/auth/ownership';
import { LedgerService, tutorPayable } from '../ledger/ledger.service';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { BookingService } from '../sessions/booking.service';
import { SessionsModule } from '../sessions/sessions.module';
import { TutorsModule } from '../tutors/tutors.module';
import { TutorsService } from '../tutors/tutors.service';
import { disputes, payouts, type DisputeRow } from './settlement.schema';

const toDispute = (d: DisputeRow) => ({
  id: d.id,
  sessionId: d.sessionId,
  participantId: d.participantId,
  paymentId: d.paymentId,
  studentUserId: d.studentUserId,
  tutorUserId: d.tutorUserId,
  reason: d.reason,
  details: d.details,
  status: d.status,
  resolutionNote: d.resolutionNote,
  openedAt: d.openedAt.toISOString(),
  resolvedAt: d.resolvedAt?.toISOString() ?? null,
});

/**
 * Part 12: releasing held money, tutor no-shows, disputes, payouts and reconciliation.
 * Every job is idempotent and driven by a sweep, so missed or repeated runs are safe.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly booking: BookingService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
    private readonly tutors: TutorsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(UPI_GATEWAYS) private readonly gateways: UpiGateways,
  ) {}

  // ================= Sweeps =================

  /** Releases HELD money DISPUTE_WINDOW_HOURS after a session ended, unless a dispute froze it. */
  async releaseDue(): Promise<number> {
    const cutoff = new Date(this.clock.nowMs() - this.config.env.DISPUTE_WINDOW_HOURS * 3_600_000);
    const candidates = await this.booking.participantsEndedBefore(cutoff);
    const held = (
      await this.payments.settledForParticipants(candidates.map((c) => c.participantId))
    ).filter((p) => p.status === 'HELD');
    const byParticipant = new Map(candidates.map((c) => [c.participantId, c]));
    let n = 0;
    for (const pay of held) {
      const c = byParticipant.get(pay.participantId);
      if (c && (await this.payments.release(pay.id, c.tutorUserId))) n++;
    }
    return n;
  }

  /** Tutor not in the room NO_SHOW_GRACE_MINUTES after start: full refund and the request reopens. */
  async processNoShows(): Promise<{ sessions: number; refunds: number }> {
    let sessionsMarked = 0;
    for (const sessionId of await this.booking.dueNoShows(this.config.env.NO_SHOW_GRACE_MINUTES)) {
      const marked = await this.db.transaction(async (tx) => {
        const cancelled = await this.booking.markNoShowInTx(tx, sessionId);
        if (!cancelled) return false;
        const session = await this.booking.getSession(sessionId, tx);
        await this.outbox.add(tx, 'session.no_show', {
          sessionId,
          tutorUserId: session?.tutorUserId ?? null,
          studentUserIds: cancelled.map((p) => p.studentUserId),
        });
        return true;
      });
      if (marked) sessionsMarked++;
    }
    // Refund step is separate so a failed provider call is retried on the next run.
    let refunded = 0;
    const toRefund = (
      await this.payments.settledForParticipants(await this.booking.noShowParticipantIds())
    ).filter((p) => p.status === 'HELD' || p.status === 'FROZEN');
    for (const pay of toRefund) {
      try {
        if (await this.payments.refundSettled(pay.id, 'TUTOR_NO_SHOW', null)) refunded++;
      } catch (err) {
        this.logger.error({ err, paymentId: pay.id }, 'No-show refund failed; will retry');
      }
    }
    return { sessions: sessionsMarked, refunds: refunded };
  }

  /** Razorpay Route mode: make sure every HELD payment has its tutor transfer on hold. */
  async ensureRouteHolds(): Promise<void> {
    if (this.payments.holdMode !== 'razorpay_route') return;
    const cutoff = new Date(this.clock.nowMs() + 365 * 86_400_000);
    const candidates = await this.booking.participantsEndedBefore(cutoff);
    for (const pay of await this.payments.settledForParticipants(
      candidates.map((c) => c.participantId),
    )) {
      if (pay.status !== 'HELD') continue;
      const c = candidates.find((x) => x.participantId === pay.participantId)!;
      const profile = await this.tutors.findProfile(c.tutorUserId);
      await this.payments
        .ensureRouteHold(pay.id, profile?.razorpayLinkedAccountId ?? null)
        .catch((err: unknown) => this.logger.warn({ err, paymentId: pay.id }, 'Route hold failed'));
    }
  }

  // ================= Disputes =================

  async openDispute(
    student: AuthUser,
    sessionId: string,
    input: { reason: DisputeRow['reason']; details?: string },
  ) {
    const session = await this.booking.getSession(sessionId);
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    const mine = (await this.booking.participantsOf(sessionId)).find(
      (p) => p.studentUserId === student.id,
    );
    if (!mine) throw AppError.forbidden('NOT_IN_SESSION', 'You are not part of this session.');
    assertOwnership(student, mine.studentUserId);
    if (session.status !== 'ENDED' || !session.endedAt) {
      throw AppError.conflict('SESSION_NOT_ENDED', 'You can dispute a session after it ends.');
    }
    const deadline = session.endedAt.getTime() + this.config.env.DISPUTE_WINDOW_HOURS * 3_600_000;
    if (this.clock.nowMs() > deadline) {
      throw AppError.conflict('DISPUTE_WINDOW_CLOSED', 'The dispute window has closed.');
    }
    const [pay] = (await this.payments.settledForParticipants([mine.id])).filter(
      (p) => p.status === 'HELD',
    );
    if (!pay)
      throw AppError.conflict('NOTHING_TO_DISPUTE', 'There is no held payment for this session.');

    try {
      return await this.db.transaction(async (tx) => {
        if (!(await this.payments.freezeInTx(tx, pay.id))) {
          throw AppError.conflict('NOTHING_TO_DISPUTE', 'The payment is no longer held.');
        }
        const [row] = await tx
          .insert(disputes)
          .values({
            sessionId,
            participantId: mine.id,
            paymentId: pay.id,
            studentUserId: student.id,
            tutorUserId: session.tutorUserId,
            reason: input.reason,
            details: input.details ?? '',
            openedAt: this.clock.now(),
          })
          .returning();
        await this.outbox.add(tx, 'dispute.opened', {
          disputeId: row!.id,
          sessionId,
          tutorUserId: session.tutorUserId,
        });
        return toDispute(row!);
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict('DISPUTE_EXISTS', 'You already disputed this session.');
      throw err;
    }
  }

  async listDisputes(status?: DisputeRow['status']) {
    const rows = await this.db
      .select()
      .from(disputes)
      .where(status ? eq(disputes.status, status) : undefined)
      .orderBy(desc(disputes.openedAt))
      .limit(200);
    return rows.map(toDispute);
  }

  async hasOpenDispute(sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.sessionId, sessionId), eq(disputes.status, 'OPEN')))
      .limit(1);
    return Boolean(row);
  }

  /** Staff decide: RELEASE pays the tutor, REFUND returns the money. Audited. */
  async resolveDispute(
    staff: AuthUser,
    disputeId: string,
    outcome: 'RELEASE' | 'REFUND',
    note: string,
    requestId: string | null,
  ) {
    const [d] = await this.db.select().from(disputes).where(eq(disputes.id, disputeId));
    if (!d) throw AppError.notFound('DISPUTE_NOT_FOUND', 'Dispute not found.');
    if (d.status !== 'OPEN')
      throw AppError.conflict('DISPUTE_CLOSED', `This dispute is ${d.status}.`);

    const moved =
      outcome === 'RELEASE'
        ? await this.payments.release(d.paymentId, d.tutorUserId, ['FROZEN'])
        : await this.payments.refundSettled(d.paymentId, 'DISPUTE_UPHELD', staff.id, ['FROZEN']);
    if (!moved)
      throw AppError.conflict('PAYMENT_NOT_FROZEN', 'The disputed payment is no longer frozen.');

    const [row] = await this.db
      .update(disputes)
      .set({
        status: outcome === 'RELEASE' ? 'RESOLVED_RELEASE' : 'RESOLVED_REFUND',
        resolutionNote: note,
        resolvedBy: staff.id,
        resolvedAt: this.clock.now(),
      })
      .where(and(eq(disputes.id, d.id), eq(disputes.status, 'OPEN')))
      .returning();
    await this.audit.record({
      actor: auditActor(staff),
      action: `dispute.resolved.${outcome.toLowerCase()}`,
      entityType: 'dispute',
      entityId: d.id,
      metadata: { paymentId: d.paymentId, note },
      requestId,
    });
    return toDispute(row!);
  }

  // ================= Admin money actions =================

  async adminRelease(staff: AuthUser, paymentId: string, note: string, requestId: string | null) {
    const pay = await this.requirePayment(paymentId);
    const participant = await this.booking.findParticipant(pay.participantId);
    const session = participant ? await this.booking.getSession(participant.sessionId) : null;
    if (!session) throw AppError.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (!(await this.payments.release(pay.id, session.tutorUserId, ['HELD']))) {
      throw AppError.conflict(
        'NOT_RELEASABLE',
        `A ${pay.status} payment cannot be released here.`,
        { status: pay.status },
      );
    }
    await this.audit.record({
      actor: auditActor(staff),
      action: 'payment.released_by_admin',
      entityType: 'payment',
      entityId: pay.id,
      metadata: { note },
      requestId,
    });
    return { paymentId: pay.id, status: 'RELEASED' as const };
  }

  async adminRefund(staff: AuthUser, paymentId: string, note: string, requestId: string | null) {
    const pay = await this.requirePayment(paymentId);
    if (!(await this.payments.refundSettled(pay.id, 'ADMIN_DECISION', staff.id, ['HELD']))) {
      throw AppError.conflict(
        'NOT_REFUNDABLE',
        `A ${pay.status} payment cannot be refunded here.`,
        { status: pay.status },
      );
    }
    await this.audit.record({
      actor: auditActor(staff),
      action: 'payment.refunded_by_admin',
      entityType: 'payment',
      entityId: pay.id,
      metadata: { note },
      requestId,
    });
    return { paymentId: pay.id, status: 'REFUNDED' as const };
  }

  /** Records a payout an admin already sent by UPI. Cannot exceed what the tutor is owed. */
  async recordPayout(
    staff: AuthUser,
    input: { tutorUserId: string; amountPaise: number; reference: string },
    requestId: string | null,
  ) {
    const profile = await this.tutors.findProfile(input.tutorUserId);
    if (!profile) throw AppError.notFound('TUTOR_NOT_FOUND', 'Tutor not found.');
    const owed = await this.ledger.balanceOf(tutorPayable(input.tutorUserId).code);
    if (input.amountPaise > owed) {
      throw AppError.conflict('PAYOUT_EXCEEDS_BALANCE', 'Payout is more than the tutor is owed.', {
        owedPaise: owed,
      });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(payouts)
          .values({
            tutorUserId: input.tutorUserId,
            amountPaise: input.amountPaise,
            upiId: profile.payoutUpiId,
            reference: input.reference,
            recordedBy: staff.id,
            createdAt: this.clock.now(),
          })
          .returning();
        await this.ledger.payoutRecorded(row!.id, input.tutorUserId, input.amountPaise, tx);
        await this.audit.record(
          {
            actor: auditActor(staff),
            action: 'payout.recorded',
            entityType: 'payout',
            entityId: row!.id,
            metadata: {
              tutorUserId: input.tutorUserId,
              amountPaise: input.amountPaise,
              reference: input.reference,
            },
            requestId,
          },
          tx,
        );
        return {
          id: row!.id,
          amountPaise: row!.amountPaise,
          reference: row!.reference,
          createdAt: row!.createdAt.toISOString(),
        };
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict(
          'DUPLICATE_PAYOUT_REFERENCE',
          'This reference was already recorded.',
        );
      throw err;
    }
  }

  // ================= Tutor earnings =================

  async earnings(tutor: AuthUser) {
    const payable = await this.ledger.balanceOf(tutorPayable(tutor.id).code);
    const settled = await this.payments.settledForParticipants(
      await this.booking.participantIdsForTutor(tutor.id),
    );
    const sum = (statuses: string[]) =>
      settled
        .filter((p) => statuses.includes(p.status))
        .reduce((n, p) => n + (p.paidAmountPaise ?? p.amountPaise), 0);
    const paid = await this.db
      .select()
      .from(payouts)
      .where(eq(payouts.tutorUserId, tutor.id))
      .orderBy(desc(payouts.createdAt))
      .limit(50);
    return {
      currency: 'INR' as const,
      /** Released to you and not yet paid out (after platform fee). */
      availablePaise: payable,
      /** Gross amounts still held (session not finished, dispute window open, or frozen). */
      pendingGrossPaise: sum(['HELD', 'FROZEN']),
      releasedGrossPaise: sum(['RELEASED']),
      platformFeeBps: this.config.env.PLATFORM_FEE_BPS,
      payouts: paid.map((p) => ({
        id: p.id,
        amountPaise: p.amountPaise,
        reference: p.reference,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  // ================= Reconciliation =================

  /**
   * Compares the ledger with payment records and (for up to `providerChecks` payments) with the
   * provider. Every mismatch is listed; an empty list means the books agree.
   */
  async reconciliation(providerChecks = 25) {
    const mismatches: Array<{
      paymentId?: string;
      check: string;
      expected: unknown;
      actual: unknown;
    }> = [];
    const rec = await this.ledger.reconcile();
    if (!rec.balanced)
      mismatches.push({
        check: 'ledger_balanced',
        expected: true,
        actual: rec.unbalancedTransactions,
      });

    const all = await this.payments.rows();
    // VERIFIED = received but awaiting an automatic refund; still sitting in held_funds.
    const heldTotal = all
      .filter((p) => p.status === 'HELD' || p.status === 'FROZEN' || p.status === 'VERIFIED')
      .reduce((n, p) => n + (p.paidAmountPaise ?? p.amountPaise), 0);
    const heldFunds = await this.ledger.balanceOf('held_funds');
    if (heldFunds !== heldTotal)
      mismatches.push({ check: 'held_funds_vs_payments', expected: heldTotal, actual: heldFunds });

    const kinds = await this.ledger.kindsByReference(all.map((p) => p.id));
    const expectedKinds: Record<string, string[]> = {
      INITIATED: [],
      FAILED: [],
      VERIFIED: ['PAYMENT_VERIFIED'],
      HELD: ['PAYMENT_VERIFIED'],
      FROZEN: ['PAYMENT_VERIFIED'],
      RELEASED: ['HOLD_RELEASED', 'PAYMENT_VERIFIED'],
      REFUNDED: ['PAYMENT_VERIFIED', 'REFUND_SENT'],
    };
    for (const p of all) {
      const actual = (kinds.get(p.id) ?? []).sort();
      const expected = expectedKinds[p.status] ?? [];
      if (actual.join() !== expected.join())
        mismatches.push({ paymentId: p.id, check: 'ledger_postings', expected, actual });
    }

    let providerChecked = 0;
    for (const p of all
      .filter((x) => ['HELD', 'FROZEN', 'RELEASED', 'REFUNDED'].includes(x.status))
      .slice(0, providerChecks)) {
      const gw = this.gateways[p.provider];
      const row = p;
      if (!gw || !row.providerPaymentId) continue;
      try {
        const remote = await gw.fetchPayment(row.providerPaymentId);
        providerChecked++;
        const expected = p.status === 'REFUNDED' ? 'refunded' : 'captured';
        if (
          remote.status !== expected ||
          remote.amountPaise !== (row.paidAmountPaise ?? row.amountPaise)
        ) {
          mismatches.push({
            paymentId: p.id,
            check: 'provider',
            expected: { status: expected, amountPaise: row.paidAmountPaise ?? row.amountPaise },
            actual: { status: remote.status, amountPaise: remote.amountPaise },
          });
        }
      } catch (err) {
        mismatches.push({
          paymentId: p.id,
          check: 'provider_unreachable',
          expected: 'reachable',
          actual: String(err),
        });
      }
    }
    return {
      ok: mismatches.length === 0,
      ledger: rec,
      heldFundsPaise: heldFunds,
      paymentsChecked: all.length,
      providerChecked,
      mismatches,
    };
  }

  private async requirePayment(id: string) {
    const pay = await this.payments.findPayment(id);
    if (!pay) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found.');
    return pay;
  }
}

@Module({
  imports: [SessionsModule, PaymentsModule, TutorsModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
