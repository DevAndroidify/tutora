import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bids } from '../bidding/bidding.schema';
import { skills } from '../catalog/catalog.schema';
import { users } from '../identity/identity.schema';
import { learningRequests } from '../requests/requests.schema';

export const SESSION_STATUSES = [
  'PENDING_PAYMENT',
  'SCHEDULED',
  'LIVE',
  'NO_SHOW',
  'ENDED',
  'CANCELLED',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const PARTICIPANT_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'JOINED',
  'ABSENT',
  'ATTENDED',
  'CANCELLED',
] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];
/** A request may have at most one participant in these states. */
export const ACTIVE_PARTICIPANT_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'JOINED',
  'ATTENDED',
] as const;

export const sessionStatus = pgEnum('session_status', SESSION_STATUSES);
export const participantStatus = pgEnum('participant_status', PARTICIPANT_STATUSES);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The accepted bid. Pools (Part 19) also create sessions from a bid. */
    bidId: uuid('bid_id')
      .notNull()
      .references(() => bids.id),
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    status: sessionStatus('status').notNull().default('PENDING_PAYMENT'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    seatPricePaise: bigint('seat_price_paise', { mode: 'number' }).notNull(),
    /** Part 19: group session from a pool. One-to-one sessions have 1/1 seats. */
    poolId: uuid('pool_id'),
    minSeats: integer('min_seats').notNull().default(1),
    maxSeats: integer('max_seats').notNull().default(1),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Part 11: set from LiveKit room events. */
    liveAt: timestamp('live_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    tutorJoinedAt: timestamp('tutor_joined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('sessions_bid_unique').on(t.bidId),
    index('sessions_tutor_idx').on(t.tutorUserId, t.startsAt),
  ],
);

export const sessionParticipants = pgTable(
  'session_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    requestId: uuid('request_id')
      .notNull()
      .references(() => learningRequests.id),
    /** What this learner pays, in paise. */
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    status: participantStatus('status').notNull().default('PENDING_PAYMENT'),
    paymentDueAt: timestamp('payment_due_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // At most one active participant per learning request: the core double-booking guard.
    uniqueIndex('session_participants_one_active_per_request')
      .on(t.requestId)
      .where(sql`${t.status} in ('PENDING_PAYMENT', 'CONFIRMED', 'JOINED', 'ATTENDED')`),
    index('session_participants_session_idx').on(t.sessionId),
    index('session_participants_student_idx').on(t.studentUserId, t.createdAt),
    index('session_participants_payment_due_idx')
      .on(t.paymentDueAt)
      .where(sql`${t.status} = 'PENDING_PAYMENT'`),
    check('session_participants_amount_positive', sql`${t.amountPaise} > 0`),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type ParticipantRow = typeof sessionParticipants.$inferSelect;
