-- Part 0: extensions used across the schema.
-- pgvector backs request embeddings for pooling (Part 18). gen_random_uuid() is built into PostgreSQL 13+.
CREATE EXTENSION IF NOT EXISTS vector;
-- pg_trgm powers fast ILIKE search over skill names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
