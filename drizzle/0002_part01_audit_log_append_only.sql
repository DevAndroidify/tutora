-- Part 1: audit_log is append-only. Block UPDATE and DELETE at the database level.
-- Reusable for other append-only tables (the ledger in Part 8, moderation actions in Part 3).
CREATE OR REPLACE FUNCTION forbid_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_row_change();
