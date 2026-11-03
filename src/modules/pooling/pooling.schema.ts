import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { skills } from '../catalog/catalog.schema';
import { users } from '../identity/identity.schema';
import { skillLevel } from '../requests/requests.schema';

/**
 * One embedding per published request, with the fields matching needs copied in so the pooling
 * module never queries the requests table directly. `embedding` is null if the provider failed.
 */
export const requestEmbeddings = pgTable(
  'request_embeddings',
  {
    requestId: uuid('request_id').primaryKey(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    level: skillLevel('level').notNull(),
    topicId: uuid('topic_id'),
    model: text('model'),
    embedding: vector('embedding', { dimensions: 1024 }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('request_embeddings_hnsw_cosine').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('request_embeddings_match_idx').on(t.skillId, t.level),
  ],
);

export const POOL_STATUSES = [
  'FORMING',
  'BIDDING',
  'AWAITING_PAYMENTS',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];
export const poolStatus = pgEnum('pool_status', POOL_STATUSES);

export const INVITE_STATUSES = ['INVITED', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;
export const poolInviteStatus = pgEnum('pool_invite_status', INVITE_STATUSES);

/** A group of learners with near-identical requests (same skill and level) who can share a cheaper session. */
export const requestPools = pgTable(
  'request_pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    level: skillLevel('level').notNull(),
    status: poolStatus('status').notNull().default('FORMING'),
    seatCap: integer('seat_cap').notNull(),
    /** Part 19: the bid members accepted, its session and the payment deadline. */
    acceptedBidId: uuid('accepted_bid_id'),
    sessionId: uuid('session_id'),
    paymentDeadline: timestamp('payment_deadline', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('request_pools_status_idx').on(t.status, t.skillId, t.level)],
);

/** Learners are only ever invited; they join by accepting. */
export const poolInvites = pgTable(
  'pool_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => requestPools.id),
    requestId: uuid('request_id').notNull(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    status: poolInviteStatus('status').notNull().default('INVITED'),
    /** Cosine similarity to the request that formed the pool; null for topic fallback matches. */
    similarity: real('similarity'),
    matchedBy: text('matched_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('pool_invites_pool_request_unique').on(t.poolId, t.requestId),
    // A request can be in at most one live invitation or pool at a time.
    uniqueIndex('pool_invites_one_active_per_request')
      .on(t.requestId)
      .where(sql`${t.status} in ('INVITED', 'ACCEPTED')`),
    index('pool_invites_student_idx').on(t.studentUserId, t.status),
  ],
);
