import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNotNull, lte, type SQL } from 'drizzle-orm';
import { AuditService } from '../../platform/audit/audit.service';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import {
  InjectDb,
  type Database,
  type DbExecutor,
  type Transaction,
} from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import {
  ACTIVE_UPI_GATEWAY,
  UPI_GATEWAYS,
  type ProviderPayment,
  type UpiGateway,
  type UpiGateways,
  type UpiProviderName,
} from '../../providers/upi/upi-gateway';
import { assertOwnership } from '../identity/auth/ownership';
import { LedgerService } from '../ledger/ledger.service';
import { BookingService } from '../sessions/booking.service';
import {
  paymentWebhookEvents,
  payments,
  refunds,
  type PaymentRow,
  type PaymentStatus,
} from './payments.schema';
import { HoldProvider } from './hold-provider';
import { splitFee } from '../ledger/ledger.service';

export const PAYMENTS_QUEUE = 'payments';
export const PROCESS_WEBHOOK_JOB = 'process-webhook';
const MAX_WEBHOOK_ATTEMPTS = 10;
const SIGNATURE_HEADERS: Record<UpiProviderName, string> = {
  fake: 'x-fake-signature',
  razorpay: 'x-razorpay-signature',
};

export interface PaymentView {
  id: string;
  participantId: string;
  provider: UpiProviderName;
  status: PaymentStatus;
  amountPaise: number;
  currency: 'INR';
  providerOrderId: string;
  failureReason: string | null;
  refundReason: string | null;
  createdAt: string;
}

/** What the client needs to open checkout. Never contains secrets. */
export interface CheckoutView extends PaymentView {
  checkout: Record<string, unknown> & { orderId: string; amount: number; currency: 'INR' };
}

type CaptureOutcome = 'held' | 'refund' | 'noop' | 'unknown';

const toView = (p: PaymentRow): PaymentView => ({
  id: p.id,
  participantId: p.participantId,
  provider: p.provider,
  status: p.status,
  amountPaise: p.amountPaise,
  currency: 'INR',
  providerOrderId: p.providerOrderId,
  failureReason: p.failureReason,
  refundReason: p.refundReason,
  createdAt: p.createdAt.toISOString(),
});

/**
 * Owns `payments` and `payment_webhook_events`. Final state comes only from a verified
 * webhook or a server-side provider check; the client's checkout callback is a fast hint.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly booking: BookingService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(ACTIVE_UPI_GATEWAY) private readonly active: UpiGateway,
    @Inject(UPI_GATEWAYS) private readonly gateways: UpiGateways,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
    private readonly hold: HoldProvider,
  ) {}

  // ================= Student =================

  /** Creates (or returns the open) provider order for a participant who still owes payment. */
  async initiate(student: AuthUser, participantId: string): Promise<CheckoutView> {
    const participant = await this.booking.findParticipant(participantId);
    if (!participant) throw AppError.notFound('PARTICIPANT_NOT_FOUND', 'Booking not found.');
    assertOwnership(student, participant.studentUserId);
    if (participant.status !== 'PENDING_PAYMENT' || participant.paymentDueAt <= this.clock.now()) {
      throw AppError.conflict('NOT_PAYABLE', 'This booking can no longer be paid.', {
        status: participant.status,
      });
    }

    const [open] = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.participantId, participantId),
          eq(payments.provider, this.active.name),
          eq(payments.status, 'INITIATED'),
        ),
      )
      .limit(1);
    if (open) return this.withCheckout(open);

    const id = randomUUID();
    const order = await this.active.createOrder({
      amountPaise: participant.amountPaise,
      currency: 'INR',
      receipt: id,
      notes: { participantId },
    });
    const now = this.clock.now();
    const [row] = await this.db
      .insert(payments)
      .values({
        id,
        participantId,
        studentUserId: student.id,
        provider: this.active.name,
        providerOrderId: order.providerOrderId,
        amountPaise: participant.amountPaise,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.withCheckout(row!);
  }

  async get(student: AuthUser, paymentId: string): Promise<PaymentView> {
    return toView(await this.requireOwned(student, paymentId));
  }

  /**
   * Standard Checkout success callback. Verifies the signature, then asks the provider
   * (server-side) for the real status. This only speeds up the UI; webhooks remain the source of truth.
   */
  async confirmCheckout(
    student: AuthUser,
    paymentId: string,
    body: { providerOrderId: string; providerPaymentId: string; signature: string },
  ): Promise<PaymentView> {
    const payment = await this.requireOwned(student, paymentId);
    const gw = this.gateway(payment.provider);
    if (body.providerOrderId !== payment.providerOrderId || !gw.verifyCheckoutResponse(body)) {
      throw AppError.badRequest('INVALID_SIGNATURE', 'Payment signature is not valid.');
    }
    const providerPayment = await gw.fetchPayment(body.providerPaymentId);
    if (providerPayment.providerOrderId !== payment.providerOrderId) {
      throw AppError.badRequest('ORDER_MISMATCH', 'Payment does not belong to this order.');
    }
    await this.applyCaptured(gw, providerPayment);
    return toView(await this.requireOwned(student, paymentId));
  }

  // ================= Webhooks =================

  /** Verify, save (deduplicated), enqueue, return fast. Processing happens in the worker. */
  async ingestWebhook(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true; duplicate: boolean }> {
    const gw = this.gateways[providerName as UpiProviderName];
    if (!gw) throw AppError.notFound('UNKNOWN_PROVIDER', 'Unknown payment provider.');
    if (!rawBody?.length) throw AppError.badRequest('EMPTY_BODY', 'Webhook body is empty.');

    const sigHeader = headers[SIGNATURE_HEADERS[gw.name]];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!signature || !gw.verifyWebhook(rawBody, signature)) {
      this.logger.warn({ provider: gw.name }, 'Rejected webhook with invalid signature');
      throw AppError.badRequest('INVALID_SIGNATURE', 'Webhook signature is not valid.');
    }
    const parsed = gw.parseWebhook(rawBody, headers);
    if (!parsed.eventId) throw AppError.badRequest('MISSING_EVENT_ID', 'Webhook has no event id.');

    const [row] = await this.db
      .insert(paymentWebhookEvents)
      .values({
        provider: gw.name,
        eventId: parsed.eventId,
        eventType: parsed.type,
        payload: JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>,
        signatureValid: true,
        receivedAt: this.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookEvents.id });
    if (!row) return { received: true, duplicate: true };

    try {
      await this.queue.add(
        PROCESS_WEBHOOK_JOB,
        { webhookEventId: row.id },
        { jobId: `webhook-${row.id}` },
      );
    } catch (err) {
      this.logger.warn({ err }, 'Could not enqueue webhook; the sweep will process it');
    }
    return { received: true, duplicate: false };
  }

  /** Processes one saved webhook event. Safe to call repeatedly and out of order. */
  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const [ev] = await this.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, webhookEventId));
    if (!ev || ev.status !== 'RECEIVED') return;
    const gw = this.gateway(ev.provider);
    const parsed = gw.parseWebhook(Buffer.from(JSON.stringify(ev.payload)), {
      'x-fake-event-id': ev.eventId,
      'x-razorpay-event-id': ev.eventId,
    });

    try {
      let handled = true;
      switch (parsed.type) {
        case 'payment.captured':
        case 'order.paid':
          if (parsed.payment) await this.applyCaptured(gw, parsed.payment);
          break;
        case 'payment.failed':
          if (parsed.payment)
            await this.markFailed(gw.name, parsed.payment.providerOrderId, 'PROVIDER_FAILED');
          break;
        case 'refund.processed':
          break; // We mark REFUNDED when the refund is created; nothing more to do.
        case 'refund.failed':
          await this.alert(null, 'REFUND_FAILED', { refund: parsed.refund ?? null });
          break;
        default:
          handled = false; // unknown events are kept for audit and ignored
      }
      await this.db
        .update(paymentWebhookEvents)
        .set({
          status: handled ? 'PROCESSED' : 'IGNORED',
          processedAt: this.clock.now(),
          attempts: ev.attempts + 1,
        })
        .where(eq(paymentWebhookEvents.id, ev.id));
    } catch (err) {
      const attempts = ev.attempts + 1;
      await this.db
        .update(paymentWebhookEvents)
        .set({
          attempts,
          lastError: err instanceof Error ? err.message.slice(0, 500) : 'error',
          status: attempts >= MAX_WEBHOOK_ATTEMPTS ? 'FAILED' : 'RECEIVED',
        })
        .where(eq(paymentWebhookEvents.id, ev.id));
      throw err;
    }
  }

  // ================= Core state changes =================

  /**
   * A captured payment arrived (webhook, checkout confirm or sweep). Verifies amount and currency,
   * posts the ledger, and confirms the booking, all in one transaction. A late or wrong-amount
   * payment is refunded automatically and staff are alerted.
   */
  async applyCaptured(gw: UpiGateway, p: ProviderPayment): Promise<CaptureOutcome> {
    if (p.status !== 'captured') return 'noop';
    let paymentId = '';
    const outcome = await this.db.transaction(async (tx): Promise<CaptureOutcome> => {
      const [pay] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.provider, gw.name), eq(payments.providerOrderId, p.providerOrderId)))
        .for('update');
      if (!pay) return 'unknown';
      paymentId = pay.id;

      if (
        pay.providerPaymentId &&
        pay.providerPaymentId !== p.providerPaymentId &&
        pay.status !== 'INITIATED' &&
        pay.status !== 'FAILED'
      ) {
        // A second, different capture on an order we already settled: money a human must return.
        await this.alert(tx, 'DUPLICATE_CAPTURE', {
          paymentId: pay.id,
          providerPaymentId: p.providerPaymentId,
        });
        return 'noop';
      }
      if (pay.status === 'VERIFIED') return pay.refundReason ? 'refund' : 'noop';
      if (pay.status !== 'INITIATED' && pay.status !== 'FAILED') return 'noop'; // already handled

      const now = this.clock.now();
      const amountOk = p.amountPaise === pay.amountPaise && p.currency === 'INR';
      await tx
        .update(payments)
        .set({
          status: 'VERIFIED',
          providerPaymentId: p.providerPaymentId,
          paidAmountPaise: p.amountPaise,
          failureReason: null,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(eq(payments.id, pay.id));
      // The ledger records what was actually received.
      await this.ledger.paymentVerified(pay.id, p.amountPaise, tx);

      if (amountOk && (await this.booking.confirmPaidInTx(tx, pay.participantId))) {
        await tx
          .update(payments)
          .set({ status: 'HELD', heldAt: now, updatedAt: now })
          .where(and(eq(payments.id, pay.id), eq(payments.status, 'VERIFIED')));
        return 'held';
      }

      const reason = amountOk ? 'BOOKING_NOT_PAYABLE' : 'AMOUNT_MISMATCH';
      await tx
        .update(payments)
        .set({ refundReason: reason, updatedAt: now })
        .where(eq(payments.id, pay.id));
      await this.alert(tx, reason, {
        paymentId: pay.id,
        expectedPaise: pay.amountPaise,
        receivedPaise: p.amountPaise,
        currency: p.currency,
      });
      return 'refund';
    });

    if (outcome === 'refund') await this.refund(paymentId);
    return outcome;
  }

  /** Sends a verified-but-unusable payment back. Idempotent; the sweep retries failures. */
  async refund(paymentId: string): Promise<boolean> {
    const [pay] = await this.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!pay || pay.status !== 'VERIFIED' || !pay.refundReason || !pay.providerPaymentId)
      return false;
    const amount = pay.paidAmountPaise ?? pay.amountPaise;
    let refundId: string;
    try {
      refundId = (
        await this.gateway(pay.provider).refund({
          providerPaymentId: pay.providerPaymentId,
          amountPaise: amount,
          receipt: `refund-${pay.id}`,
          notes: { reason: pay.refundReason },
        })
      ).providerRefundId;
    } catch (err) {
      this.logger.error({ err, paymentId }, 'Refund call failed; will retry');
      return false;
    }
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [row] = await tx
        .update(payments)
        .set({ status: 'REFUNDED', providerRefundId: refundId, refundedAt: now, updatedAt: now })
        .where(and(eq(payments.id, pay.id), eq(payments.status, 'VERIFIED')))
        .returning();
      if (!row) return;
      await tx.insert(refunds).values({
        paymentId: pay.id,
        amountPaise: amount,
        reason: pay.refundReason!,
        providerRefundId: refundId,
        createdAt: now,
      });
      await this.ledger.refundSent(pay.id, amount, tx);
      await this.outbox.add(tx, 'payment.refunded', {
        paymentId: pay.id,
        studentUserId: pay.studentUserId,
        amountPaise: amount,
        reason: pay.refundReason,
      });
      await this.audit.record(
        {
          actor: null,
          action: 'payment.auto_refunded',
          entityType: 'payment',
          entityId: pay.id,
          metadata: { reason: pay.refundReason, amountPaise: amount, providerRefundId: refundId },
        },
        tx,
      );
    });
    return true;
  }

  private async markFailed(
    provider: UpiProviderName,
    providerOrderId: string,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(payments)
      .set({ status: 'FAILED', failureReason: reason, updatedAt: this.clock.now() })
      .where(
        and(
          eq(payments.provider, provider),
          eq(payments.providerOrderId, providerOrderId),
          eq(payments.status, 'INITIATED'),
        ),
      );
  }

  // ================= Worker sweeps =================

  /**
   * Checks old INITIATED payments with the provider API (missed webhooks), retries pending
   * refunds and unprocessed webhooks. All idempotent.
   */
  async sweep(): Promise<{ checked: number; refunds: number; webhooks: number }> {
    const now = this.clock.nowMs();
    const stale = await this.db
      .select()
      .from(payments)
      .where(
        and(eq(payments.status, 'INITIATED'), lte(payments.createdAt, new Date(now - 2 * 60_000))),
      )
      .orderBy(asc(payments.createdAt))
      .limit(100);
    for (const pay of stale) {
      try {
        const gw = this.gateway(pay.provider);
        const found = await gw.fetchOrderPayments(pay.providerOrderId);
        const captured = found.find((x) => x.status === 'captured');
        if (captured) {
          await this.applyCaptured(gw, captured);
        } else if (
          pay.createdAt.getTime() <
          now - (this.config.env.PAYMENT_WINDOW_MINUTES + 30) * 60_000
        ) {
          await this.markFailed(pay.provider, pay.providerOrderId, 'EXPIRED_UNPAID');
        }
      } catch (err) {
        this.logger.warn({ err, paymentId: pay.id }, 'Payment status check failed');
      }
    }

    const pendingRefunds = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.status, 'VERIFIED'), isNotNull(payments.refundReason)))
      .limit(100);
    let refunds = 0;
    for (const r of pendingRefunds) if (await this.refund(r.id)) refunds++;

    const pendingHooks = await this.db
      .select({ id: paymentWebhookEvents.id })
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.status, 'RECEIVED'),
          lte(paymentWebhookEvents.receivedAt, new Date(now - 60_000)),
        ),
      )
      .orderBy(asc(paymentWebhookEvents.id))
      .limit(100);
    for (const h of pendingHooks) {
      await this.processWebhookEvent(h.id).catch((err) =>
        this.logger.warn({ err }, 'Webhook retry failed'),
      );
    }
    return { checked: stale.length, refunds, webhooks: pendingHooks.length };
  }

  // ================= Settlement (Part 12) =================

  async findPayment(id: string, tx: DbExecutor = this.db): Promise<PaymentRow | null> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, id));
    return row ?? null;
  }

  /** Settled (HELD/FROZEN/RELEASED/REFUNDED) payments of these participants. */
  async settledForParticipants(participantIds: string[]): Promise<PaymentRow[]> {
    if (participantIds.length === 0) return [];
    return this.db
      .select()
      .from(payments)
      .where(
        and(
          inArray(payments.participantId, participantIds),
          inArray(payments.status, ['HELD', 'FROZEN', 'RELEASED', 'REFUNDED']),
        ),
      );
  }

  /** HELD -> FROZEN while a dispute is open. */
  async freezeInTx(tx: DbExecutor, paymentId: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await tx
      .update(payments)
      .set({ status: 'FROZEN', frozenAt: now, updatedAt: now })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'HELD')))
      .returning({ id: payments.id });
    return rows.length > 0;
  }

  /**
   * HELD|FROZEN -> RELEASED: the tutor earns the amount minus the platform fee
   * (ledger: held_funds -> tutor_payable + platform_revenue). Idempotent.
   */
  async release(
    paymentId: string,
    tutorUserId: string,
    from: PaymentStatus[] = ['HELD'],
  ): Promise<boolean> {
    const released = await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [row] = await tx
        .update(payments)
        .set({ status: 'RELEASED', releasedAt: now, updatedAt: now })
        .where(and(eq(payments.id, paymentId), inArray(payments.status, from)))
        .returning();
      if (!row) return null;
      const amount = row.paidAmountPaise ?? row.amountPaise;
      const fee = this.config.env.PLATFORM_FEE_BPS;
      await this.ledger.holdReleased(row.id, tutorUserId, amount, fee, tx);
      await this.outbox.add(tx, 'payment.released', {
        paymentId: row.id,
        tutorUserId,
        tutorSharePaise: splitFee(amount, fee).tutorPaise,
      });
      return row;
    });
    if (!released) return false;
    await this.hold
      .release(this.holdTarget(released, null))
      .catch((err: unknown) =>
        this.logger.error(
          { err, paymentId },
          'Route release failed; ledger is released, retry from admin',
        ),
      );
    return true;
  }

  /**
   * HELD|FROZEN -> REFUNDED: full refund to the payer (tutor no-show, dispute decided for the
   * learner, admin decision). The provider is called first; the ledger posts after it accepts.
   */
  async refundSettled(
    paymentId: string,
    reason: string,
    initiatedBy: string | null,
    from: PaymentStatus[] = ['HELD', 'FROZEN'],
  ): Promise<boolean> {
    const pay = await this.findPayment(paymentId);
    if (!pay || !from.includes(pay.status) || !pay.providerPaymentId) return false;
    const amount = pay.paidAmountPaise ?? pay.amountPaise;
    await this.hold.reverse(this.holdTarget(pay, null));
    const result = await this.gateway(pay.provider).refund({
      providerPaymentId: pay.providerPaymentId,
      amountPaise: amount,
      receipt: `refund-${pay.id}`,
      notes: { reason },
    });
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [row] = await tx
        .update(payments)
        .set({
          status: 'REFUNDED',
          refundReason: reason,
          providerRefundId: result.providerRefundId,
          refundedAt: now,
          updatedAt: now,
        })
        .where(and(eq(payments.id, pay.id), inArray(payments.status, from)))
        .returning();
      if (!row) return false;
      await tx.insert(refunds).values({
        paymentId: pay.id,
        amountPaise: amount,
        reason,
        providerRefundId: result.providerRefundId,
        status: result.status === 'processed' ? 'PROCESSED' : 'PENDING',
        initiatedBy,
        createdAt: now,
      });
      await this.ledger.refundSent(pay.id, amount, tx);
      await this.outbox.add(tx, 'payment.refunded', {
        paymentId: pay.id,
        studentUserId: pay.studentUserId,
        amountPaise: amount,
        reason,
      });
      return true;
    });
  }

  /** Razorpay Route only: put the tutor share of a HELD payment on hold at the provider. */
  async ensureRouteHold(paymentId: string, linkedAccountId: string | null): Promise<void> {
    if (this.hold.mode !== 'razorpay_route') return;
    const pay = await this.findPayment(paymentId);
    if (!pay || pay.status !== 'HELD' || pay.routeTransferId) return;
    const { routeTransferId } = await this.hold.hold(this.holdTarget(pay, linkedAccountId));
    if (routeTransferId) {
      await this.db
        .update(payments)
        .set({ routeTransferId, updatedAt: this.clock.now() })
        .where(eq(payments.id, pay.id));
    }
  }

  get holdMode(): HoldProvider['mode'] {
    return this.hold.mode;
  }

  private holdTarget(pay: PaymentRow, linkedAccountId: string | null) {
    const amount = pay.paidAmountPaise ?? pay.amountPaise;
    return {
      paymentId: pay.id,
      providerPaymentId: pay.providerPaymentId ?? '',
      tutorLinkedAccountId: linkedAccountId,
      tutorSharePaise: splitFee(amount, this.config.env.PLATFORM_FEE_BPS).tutorPaise,
      routeTransferId: pay.routeTransferId,
    };
  }

  // ================= Admin =================

  async list(status?: PaymentStatus): Promise<PaymentView[]> {
    const where: SQL | undefined = status ? eq(payments.status, status) : undefined;
    const rows = await this.db
      .select()
      .from(payments)
      .where(where)
      .orderBy(desc(payments.createdAt))
      .limit(200);
    return rows.map(toView);
  }

  /** Raw rows for reconciliation. */
  async rows(limit = 1000): Promise<PaymentRow[]> {
    return this.db.select().from(payments).orderBy(desc(payments.createdAt)).limit(limit);
  }

  async byParticipants(participantIds: string[]): Promise<PaymentRow[]> {
    if (participantIds.length === 0) return [];
    return this.db.select().from(payments).where(inArray(payments.participantId, participantIds));
  }

  // ================= Helpers =================

  private gateway(name: UpiProviderName): UpiGateway {
    const gw = this.gateways[name];
    if (!gw) throw new Error(`Payment provider ${name} is not configured.`);
    return gw;
  }

  private async requireOwned(student: AuthUser, paymentId: string): Promise<PaymentRow> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!row) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found.');
    assertOwnership(student, row.studentUserId);
    return row;
  }

  private withCheckout(row: PaymentRow): CheckoutView {
    return {
      ...toView(row),
      checkout: {
        ...this.gateway(row.provider).publicCheckoutConfig(),
        orderId: row.providerOrderId,
        amount: row.amountPaise,
        currency: 'INR',
      },
    };
  }

  private async alert(
    tx: Transaction | null,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const run = async (t: Transaction) => {
      await this.outbox.add(t, 'payments.alert', { reason, ...details });
      await this.audit.record(
        {
          actor: null,
          action: `payment.alert.${reason.toLowerCase()}`,
          entityType: 'payment',
          entityId: String(details.paymentId ?? 'unknown'),
          metadata: details,
        },
        t,
      );
    };
    if (tx) await run(tx);
    else await this.db.transaction(run);
  }
}
