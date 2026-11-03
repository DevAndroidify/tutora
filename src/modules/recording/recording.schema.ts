import {
  bigint,
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../identity/identity.schema';

export const RECORDING_STATUSES = [
  'STARTING',
  'RECORDING',
  'COMPLETED',
  'FAILED',
  'DELETED',
] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];
export const recordingStatus = pgEnum('recording_status', RECORDING_STATUSES);
export const TRANSCRIPT_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'FAILED'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];
export const transcriptStatus = pgEnum('transcript_status', TRANSCRIPT_STATUSES);

/** Each person in a session says yes or no to recording. Recording starts only when everyone says yes. */
export const recordingConsents = pgTable(
  'recording_consents',
  {
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    granted: boolean('granted').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    egressId: text('egress_id'),
    status: recordingStatus('status').notNull().default('STARTING'),
    objectKey: text('object_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    error: text('error'),
    /** Part 15: transcription progress for COMPLETED recordings. */
    transcriptStatus: transcriptStatus('transcript_status').notNull().default('PENDING'),
    transcriptError: text('transcript_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Retention: the file is deleted by a sweep after this time. */
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('recordings_session_unique').on(t.sessionId),
    uniqueIndex('recordings_egress_unique').on(t.egressId),
    index('recordings_retention_idx').on(t.deleteAfter),
  ],
);

export type RecordingRow = typeof recordings.$inferSelect;
