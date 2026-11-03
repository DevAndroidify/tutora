-- Runs once, when the Postgres volume is first created.
-- The development database (tutora) is created by POSTGRES_DB; this adds a separate test database.
CREATE DATABASE tutora_test OWNER tutora;

\connect tutora
CREATE EXTENSION IF NOT EXISTS vector;

\connect tutora_test
CREATE EXTENSION IF NOT EXISTS vector;
