import {
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

export const idempotencyStatus = pgEnum('idempotency_status', ['IN_PROGRESS', 'COMPLETED']);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Who owns the key: a user id, or `anon` for unauthenticated routes. */
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    /** SHA-256 over method, route and canonical JSON body. */
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_scope_key_unique').on(t.scope, t.key),
    index('idempotency_keys_expires_at_idx').on(t.expiresAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
