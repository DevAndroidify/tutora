import { sql } from 'drizzle-orm';
import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Transactional outbox. A state change and its event commit in the same transaction;
 * the worker publishes pending rows (at least once) and marks them published.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Not published before this time (retry backoff). */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Set when attempts run out; needs an operator. */
    deadAt: timestamp('dead_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.availableAt, t.id)
      .where(sql`${t.publishedAt} is null and ${t.deadAt} is null`),
  ],
);

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
