-- Part 8: ledger integrity.
-- 1) Append-only: transactions and entries can never change; accounts can never be deleted.
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_row_change();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_row_change();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_delete
  BEFORE DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_row_change();
--> statement-breakpoint
-- 2) Second line of defence after the service check: at COMMIT, every transaction that
--    received entries must have debits = credits.
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  diff numeric;
BEGIN
  SELECT coalesce(sum(CASE WHEN direction = 'DEBIT' THEN amount_paise ELSE -amount_paise END), 0)
    INTO diff
    FROM ledger_entries
   WHERE transaction_id = NEW.transaction_id;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced by % paise', NEW.transaction_id, diff
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
