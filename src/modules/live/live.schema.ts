import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Every LiveKit webhook, deduplicated by event id. Attendance is computed from these rows. */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id'),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    /** e.g. "tutor:<userId>" or "student:<userId>". */
    identity: text('identity'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('session_events_event_id_unique').on(t.eventId),
    index('session_events_session_idx').on(t.sessionId, t.occurredAt),
  ],
);
