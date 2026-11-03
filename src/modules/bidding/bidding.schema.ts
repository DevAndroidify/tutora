import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../identity/identity.schema';
import { learningRequests } from '../requests/requests.schema';

export const BID_STATUSES = [
  'SUBMITTED',
  'ACCEPTED',
  'HELD',
  'WITHDRAWN',
  'EXPIRED',
  'REJECTED',
] as const;
export type BidStatus = (typeof BID_STATUSES)[number];
/** Bids that block a second bid from the same tutor on the same target. */
export const ACTIVE_BID_STATUSES = ['SUBMITTED', 'HELD', 'ACCEPTED'] as const;

export const bidStatus = pgEnum('bid_status', BID_STATUSES);

/**
 * Sealed bids. Learners see every bid on their request; tutors only see their own bid
 * and the bid count. A bid targets a learning request XOR a pool (pools arrive in Part 18;
 * the FK is added then).
 */
export const bids = pgTable(
  'bids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').references(() => learningRequests.id, { onDelete: 'cascade' }),
    poolId: uuid('pool_id'),
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Price per seat in paise. */
    seatPricePaise: bigint('seat_price_paise', { mode: 'number' }).notNull(),
    proposedStartAt: timestamp('proposed_start_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    /** Pool bids (Part 19): the session runs only with at least minSeats paid learners, at most maxSeats. */
    minSeats: integer('min_seats'),
    maxSeats: integer('max_seats'),
    /** Screened text describing how the tutor will teach this. */
    approachText: text('approach_text'),
    /** Optional ~30-second intro video/audio in storage. */
    approachMediaKey: text('approach_media_key'),
    status: bidStatus('status').notNull().default('SUBMITTED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('bids_one_target', sql`(${t.requestId} is null) <> (${t.poolId} is null)`),
    check(
      'bids_price_range',
      sql`${t.seatPricePaise} > 0 and ${t.seatPricePaise} <= 9007199254740991`,
    ),
    check('bids_duration_range', sql`${t.durationMinutes} between 15 and 240`),
    check(
      'bids_pool_seats',
      sql`(${t.poolId} is null and ${t.minSeats} is null and ${t.maxSeats} is null) or (${t.poolId} is not null and ${t.minSeats} >= 2 and ${t.maxSeats} >= ${t.minSeats})`,
    ),
    check(
      'bids_has_approach',
      sql`coalesce(length(${t.approachText}), 0) > 0 or ${t.approachMediaKey} is not null`,
    ),
    uniqueIndex('bids_one_active_per_tutor_request')
      .on(t.tutorUserId, t.requestId)
      .where(sql`${t.requestId} is not null and ${t.status} in ('SUBMITTED', 'HELD', 'ACCEPTED')`),
    uniqueIndex('bids_one_active_per_tutor_pool')
      .on(t.tutorUserId, t.poolId)
      .where(sql`${t.poolId} is not null and ${t.status} in ('SUBMITTED', 'HELD', 'ACCEPTED')`),
    index('bids_request_idx').on(t.requestId, t.status),
    index('bids_pool_idx').on(t.poolId, t.status),
    index('bids_tutor_idx').on(t.tutorUserId, t.createdAt),
  ],
);

export type BidRow = typeof bids.$inferSelect;
