import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../identity/identity.schema';

export const DISPUTE_REASONS = [
  'TUTOR_ABSENT_OR_LATE',
  'POOR_QUALITY',
  'NOT_AS_DESCRIBED',
  'TECHNICAL_ISSUES',
  'MISCONDUCT',
  'OTHER',
] as const;
export const DISPUTE_STATUSES = ['OPEN', 'RESOLVED_RELEASE', 'RESOLVED_REFUND'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const disputeReason = pgEnum('dispute_reason', DISPUTE_REASONS);
export const disputeStatus = pgEnum('dispute_status', DISPUTE_STATUSES);

/** A learner disputes a session during the dispute window; their money is frozen until staff decide. */
export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id),
    reason: disputeReason('reason').notNull(),
    details: text('details').notNull().default(''),
    status: disputeStatus('status').notNull().default('OPEN'),
    resolutionNote: text('resolution_note'),
    resolvedBy: uuid('resolved_by'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('disputes_participant_unique').on(t.participantId),
    index('disputes_status_idx').on(t.status, t.openedAt),
    index('disputes_session_idx').on(t.sessionId),
  ],
);

/** Manual UPI payouts recorded by admins (ledger: tutor_payable -> payout_clearing). */
export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    method: text('method').notNull().default('MANUAL_UPI'),
    upiId: text('upi_id'),
    /** Bank / UPI transaction reference (UTR). */
    reference: text('reference').notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('payouts_tutor_idx').on(t.tutorUserId, t.createdAt),
    uniqueIndex('payouts_reference_unique').on(t.reference),
    check('payouts_amount_positive', sql`${t.amountPaise} > 0`),
  ],
);

export type DisputeRow = typeof disputes.$inferSelect;
