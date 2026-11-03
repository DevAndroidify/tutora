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

/**
 * Timestamped transcript lines. A generated `tsv` column (added in the migration) powers
 * PostgreSQL full-text search. (recording_id, seq) is unique, so retries overwrite instead of duplicating.
 */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    speaker: text('speaker'),
    text: text('text').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('transcript_segments_recording_seq_unique').on(t.recordingId, t.seq),
    index('transcript_segments_session_idx').on(t.sessionId, t.startMs),
  ],
);

export const REPLAY_ASSET_KINDS = ['NOTES', 'FLASHCARDS'] as const;
export const REPLAY_ASSET_SOURCES = ['GENERATED', 'TUTOR'] as const;
export const REPLAY_ASSET_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export const replayAssetKind = pgEnum('replay_asset_kind', REPLAY_ASSET_KINDS);
export const replayAssetSource = pgEnum('replay_asset_source', REPLAY_ASSET_SOURCES);
export const replayAssetStatus = pgEnum('replay_asset_status', REPLAY_ASSET_STATUSES);

/** Part 16: notes and flashcards per session, generated or written by the tutor. */
export const replayAssets = pgTable(
  'replay_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    kind: replayAssetKind('kind').notNull(),
    source: replayAssetSource('source').notNull(),
    status: replayAssetStatus('status').notNull().default('PENDING'),
    provider: text('provider'),
    model: text('model'),
    content: jsonb('content').$type<Record<string, unknown>>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('replay_assets_session_kind_source_unique').on(t.sessionId, t.kind, t.source),
  ],
);
