import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const LEDGER_ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'REVENUE'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];
export const ENTRY_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number];

export const ledgerAccountType = pgEnum('ledger_account_type', LEDGER_ACCOUNT_TYPES);
export const entryDirection = pgEnum('ledger_entry_direction', ENTRY_DIRECTIONS);

/**
 * Chart of accounts. Codes: gateway_clearing, held_funds, platform_revenue, payout_clearing,
 * tutor_payable:{tutorId}. All INR, amounts in paise.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    code: text('code').notNull(),
    type: ledgerAccountType('type').notNull(),
    currency: text('currency').notNull().default('INR'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('ledger_accounts_code_unique').on(t.code),
    check('ledger_accounts_inr', sql`${t.currency} = 'INR'`),
  ],
);

/** One business event. The idempotency key makes re-posting a no-op. Append-only. */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    referenceType: text('reference_type'),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('ledger_transactions_idempotency_unique').on(t.idempotencyKey),
    index('ledger_transactions_reference_idx').on(t.referenceType, t.referenceId),
  ],
);

/** Debit/credit lines. Per transaction, debits must equal credits (deferred trigger). Append-only. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    transactionId: bigint('transaction_id', { mode: 'number' })
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => ledgerAccounts.id),
    direction: entryDirection('direction').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('ledger_entries_transaction_idx').on(t.transactionId),
    index('ledger_entries_account_idx').on(t.accountId),
    check(
      'ledger_entries_amount_range',
      sql`${t.amountPaise} > 0 and ${t.amountPaise} <= 9007199254740991`,
    ),
  ],
);
