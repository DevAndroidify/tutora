-- Part 15: PostgreSQL full-text search over transcript lines.
ALTER TABLE transcript_segments
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED;
--> statement-breakpoint
CREATE INDEX transcript_segments_tsv_idx ON transcript_segments USING gin (tsv);
