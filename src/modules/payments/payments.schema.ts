import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../identity/identity.schema';
import { sessionParticipants } from '../sessions/sessions.schema';

export const PAYMENT_STATUSES = [
  'INITIATED',
  'VERIFIED',
  'HELD',
  'RELEASED',
  'REFUNDED',
  'FROZEN',
  'FAILED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const WEBHOOK_STATUSES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'] as const;

export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
export const upiProvider = pgEnum('upi_provider', ['fake', 'razorpay']);
export const webhookStatus = pgEnum('webhook_event_status', WEBHOOK_STATUSES);

/** One UPI payment attempt by one participant. Money is tracked as held until release (Part 12). */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => sessionParticipants.id),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    provider: upiProvider('provider').notNull(),
    providerOrderId: text('provider_order_id').notNull(),
    providerPaymentId: text('provider_payment_id'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** Amount the provider reported as paid (may differ: then we refund). */
    paidAmountPaise: bigint('paid_amount_paise', { mode: 'number' }),
    currency: text('currency').notNull().default('INR'),
    status: paymentStatus('status').notNull().default('INITIATED'),
    failureReason: text('failure_reason'),
    /** Set when a verified payment must go back to the payer (late or wrong amount). */
    refundReason: text('refund_reason'),
    providerRefundId: text('provider_refund_id'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    heldAt: timestamp('held_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** Part 12. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    /** Razorpay Route transfer holding the tutor's share (HOLD_MODE=razorpay_route only). */
    routeTransferId: text('route_transfer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('payments_provider_order_unique').on(t.provider, t.providerOrderId),
    uniqueIndex('payments_provider_payment_unique')
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} is not null`),
    index('payments_participant_idx').on(t.participantId),
    index('payments_initiated_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'INITIATED'`),
    check('payments_inr', sql`${t.currency} = 'INR'`),
    check('payments_amount_positive', sql`${t.amountPaise} > 0`),
  ],
);

/** Every webhook is saved first (deduplicated by provider event id), then processed by the worker. */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: upiProvider('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    status: webhookStatus('status').notNull().default('RECEIVED'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('payment_webhook_events_dedupe').on(t.provider, t.eventId),
    index('payment_webhook_events_pending_idx')
      .on(t.receivedAt)
      .where(sql`${t.status} = 'RECEIVED'`),
  ],
);

export type PaymentRow = typeof payments.$inferSelect;
export type WebhookEventRow = typeof paymentWebhookEvents.$inferSelect;

export const REFUND_STATUSES = ['PENDING', 'PROCESSED'] as const;
export const refundStatus = pgEnum('refund_status', REFUND_STATUSES);

/** Part 12: one row per refund sent to a payer. */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    providerRefundId: text('provider_refund_id').notNull(),
    status: refundStatus('status').notNull().default('PROCESSED'),
    initiatedBy: uuid('initiated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('refunds_payment_unique').on(t.paymentId),
    check('refunds_amount_positive', sql`${t.amountPaise} > 0`),
  ],
);
