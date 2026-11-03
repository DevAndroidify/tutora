import {
  boolean,
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

export const SESSION_MODES = ['FULL_VIDEO', 'AUDIO_ONLY', 'WHITEBOARD_ONLY'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
export const sessionMode = pgEnum('session_mode', SESSION_MODES);

/** Clients report when they switch modes (media adaptation itself happens on the client). */
export const sessionModeEvents = pgTable(
  'session_mode_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    mode: sessionMode('mode').notNull(),
    /** Client-measured downlink estimate, if known. */
    downlinkKbps: integer('downlink_kbps'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('session_mode_events_session_idx').on(t.sessionId, t.createdAt)],
);

/** Whiteboard images uploaded during the session; final ones are attached to the replay. */
export const whiteboardSnapshots = pgTable(
  'whiteboard_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    objectKey: text('object_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    isFinal: boolean('is_final').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('whiteboard_snapshots_object_key_unique').on(t.objectKey),
    index('whiteboard_snapshots_session_idx').on(t.sessionId, t.createdAt),
  ],
);
