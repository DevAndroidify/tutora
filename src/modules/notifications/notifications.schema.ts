import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { clientApp, users } from '../identity/identity.schema';

/** In-app notifications. No email or push provider yet. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which member app shows it. Null = both. */
    app: clientApp('app'),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** The outbox event that produced it; makes redelivery idempotent. */
    sourceEventId: bigint('source_event_id', { mode: 'number' }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('notifications_event_user_unique').on(t.sourceEventId, t.userId),
    index('notifications_user_idx').on(t.userId, t.createdAt),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
