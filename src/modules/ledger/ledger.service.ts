import { Injectable, Module } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  type EntryDirection,
  type LedgerAccountType,
} from './ledger.schema';

export const ACCOUNTS = {
  gatewayClearing: { code: 'gateway_clearing', type: 'ASSET' },
  heldFunds: { code: 'held_funds', type: 'LIABILITY' },
  platformRevenue: { code: 'platform_revenue', type: 'REVENUE' },
  payoutClearing: { code: 'payout_clearing', type: 'ASSET' },
} as const satisfies Record<string, { code: string; type: LedgerAccountType }>;

export const tutorPayable = (tutorId: string) =>
  ({ code: `tutor_payable:${tutorId}`, type: 'LIABILITY' }) as const;

export interface AccountRef {
  code: string;
  type: LedgerAccountType;
}

export interface LedgerLine {
  account: AccountRef;
  direction: EntryDirection;
  amountPaise: number;
}

export interface PostInput {
  idempotencyKey: string;
  kind: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  lines: LedgerLine[];
}

export interface AccountBalance {
  code: string;
  type: LedgerAccountType;
  debitsPaise: number;
  creditsPaise: number;
  /** Positive in the account's normal direction (debit for assets, credit otherwise). */
  balancePaise: number;
}

/** Splits a gross amount into platform fee and tutor share, in whole paise (fee rounds down). */
export function splitFee(
  grossPaise: number,
  feeBps: number,
): { feePaise: number; tutorPaise: number } {
  const feePaise = Math.floor((grossPaise * feeBps) / 10_000);
  return { feePaise, tutorPaise: grossPaise - feePaise };
}

function assertMoney(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `Ledger amounts must be positive whole paise within MAX_SAFE_INTEGER (got ${n}).`,
    );
  }
}

/**
 * Internal double-entry ledger (no gateway calls). Append-only: entries are never changed;
 * corrections are new transactions. Balance is enforced twice: here, and by a deferred
 * database constraint trigger at commit.
 */
@Injectable()
export class LedgerService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /**
   * Posts a balanced transaction. Re-posting the same idempotency key is a no-op and returns
   * the original transaction id with `created: false`.
   */
  async post(
    input: PostInput,
    tx?: DbExecutor,
  ): Promise<{ transactionId: number; created: boolean }> {
    if (input.lines.length < 2) throw new Error('A ledger transaction needs at least two lines.');
    let debits = 0;
    let credits = 0;
    for (const line of input.lines) {
      assertMoney(line.amountPaise);
      if (line.direction === 'DEBIT') debits += line.amountPaise;
      else credits += line.amountPaise;
    }
    if (debits !== credits || !Number.isSafeInteger(debits)) {
      throw AppError.badRequest('LEDGER_UNBALANCED', 'Debits must equal credits.', {
        debits,
        credits,
      });
    }

    const run = async (t: DbExecutor) => {
      const now = this.clock.now();
      const [created] = await t
        .insert(ledgerTransactions)
        .values({
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          metadata: input.metadata ?? {},
          createdAt: now,
        })
        .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
        .returning({ id: ledgerTransactions.id });
      if (!created) {
        const [existing] = await t
          .select({ id: ledgerTransactions.id })
          .from(ledgerTransactions)
          .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey));
        return { transactionId: existing!.id, created: false };
      }
      const rows = [];
      for (const line of input.lines) {
        rows.push({
          transactionId: created.id,
          accountId: await this.accountId(t, line.account),
          direction: line.direction,
          amountPaise: line.amountPaise,
          createdAt: now,
        });
      }
      await t.insert(ledgerEntries).values(rows);
      return { transactionId: created.id, created: true };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  // ---------- The four business postings ----------

  /** Payment verified: Dr gateway_clearing / Cr held_funds. */
  paymentVerified(paymentId: string, amountPaise: number, tx?: DbExecutor) {
    return this.post(
      {
        idempotencyKey: `payment:${paymentId}:verified`,
        kind: 'PAYMENT_VERIFIED',
        referenceType: 'payment',
        referenceId: paymentId,
        lines: [
          { account: ACCOUNTS.gatewayClearing, direction: 'DEBIT', amountPaise },
          { account: ACCOUNTS.heldFunds, direction: 'CREDIT', amountPaise },
        ],
      },
      tx,
    );
  }

  /** Hold released: Dr held_funds / Cr tutor_payable + platform_revenue. */
  holdReleased(
    paymentId: string,
    tutorId: string,
    amountPaise: number,
    feeBps: number,
    tx?: DbExecutor,
  ) {
    const { feePaise, tutorPaise } = splitFee(amountPaise, feeBps);
    const lines: LedgerLine[] = [
      { account: ACCOUNTS.heldFunds, direction: 'DEBIT', amountPaise },
      { account: tutorPayable(tutorId), direction: 'CREDIT', amountPaise: tutorPaise },
    ];
    if (feePaise > 0)
      lines.push({ account: ACCOUNTS.platformRevenue, direction: 'CREDIT', amountPaise: feePaise });
    return this.post(
      {
        idempotencyKey: `payment:${paymentId}:released`,
        kind: 'HOLD_RELEASED',
        referenceType: 'payment',
        referenceId: paymentId,
        metadata: { tutorId, feeBps, feePaise, tutorPaise },
        lines,
      },
      tx,
    );
  }

  /** Refund sent: Dr held_funds / Cr gateway_clearing. */
  refundSent(paymentId: string, amountPaise: number, tx?: DbExecutor) {
    return this.post(
      {
        idempotencyKey: `payment:${paymentId}:refunded`,
        kind: 'REFUND_SENT',
        referenceType: 'payment',
        referenceId: paymentId,
        lines: [
          { account: ACCOUNTS.heldFunds, direction: 'DEBIT', amountPaise },
          { account: ACCOUNTS.gatewayClearing, direction: 'CREDIT', amountPaise },
        ],
      },
      tx,
    );
  }

  /** Payout recorded: Dr tutor_payable / Cr payout_clearing. */
  payoutRecorded(payoutId: string, tutorId: string, amountPaise: number, tx?: DbExecutor) {
    return this.post(
      {
        idempotencyKey: `payout:${payoutId}`,
        kind: 'PAYOUT_RECORDED',
        referenceType: 'payout',
        referenceId: payoutId,
        lines: [
          { account: tutorPayable(tutorId), direction: 'DEBIT', amountPaise },
          { account: ACCOUNTS.payoutClearing, direction: 'CREDIT', amountPaise },
        ],
      },
      tx,
    );
  }

  // ---------- Queries ----------

  async balances(): Promise<AccountBalance[]> {
    const rows = await this.db
      .select({
        code: ledgerAccounts.code,
        type: ledgerAccounts.type,
        debits: sql<string>`coalesce(sum(${ledgerEntries.amountPaise}) filter (where ${ledgerEntries.direction} = 'DEBIT'), 0)`,
        credits: sql<string>`coalesce(sum(${ledgerEntries.amountPaise}) filter (where ${ledgerEntries.direction} = 'CREDIT'), 0)`,
      })
      .from(ledgerAccounts)
      .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .groupBy(ledgerAccounts.id)
      .orderBy(ledgerAccounts.code);
    return rows.map((r) => {
      const debitsPaise = toSafe(r.debits);
      const creditsPaise = toSafe(r.credits);
      return {
        code: r.code,
        type: r.type,
        debitsPaise,
        creditsPaise,
        balancePaise: r.type === 'ASSET' ? debitsPaise - creditsPaise : creditsPaise - debitsPaise,
      };
    });
  }

  /** Posting kinds recorded for each payment id (reference_type = payment). */
  async kindsByReference(paymentIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (paymentIds.length === 0) return out;
    const rows = await this.db
      .select({ ref: ledgerTransactions.referenceId, kind: ledgerTransactions.kind })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.referenceType, 'payment'),
          inArray(ledgerTransactions.referenceId, paymentIds),
        ),
      );
    for (const r of rows) {
      if (!r.ref) continue;
      out.set(r.ref, [...(out.get(r.ref) ?? []), r.kind]);
    }
    return out;
  }

  async balanceOf(code: string): Promise<number> {
    return (await this.balances()).find((b) => b.code === code)?.balancePaise ?? 0;
  }

  /** Reconciliation: whole-ledger totals and any transaction that doesn't balance (should be none). */
  async reconcile(): Promise<{
    totalDebitsPaise: number;
    totalCreditsPaise: number;
    balanced: boolean;
    unbalancedTransactions: number[];
    transactionCount: number;
  }> {
    const [totals] = await this.db
      .select({
        debits: sql<string>`coalesce(sum(${ledgerEntries.amountPaise}) filter (where ${ledgerEntries.direction} = 'DEBIT'), 0)`,
        credits: sql<string>`coalesce(sum(${ledgerEntries.amountPaise}) filter (where ${ledgerEntries.direction} = 'CREDIT'), 0)`,
        txCount: sql<string>`count(distinct ${ledgerEntries.transactionId})`,
      })
      .from(ledgerEntries);
    const bad = await this.db.execute<{ transaction_id: string }>(sql`
      select transaction_id from ledger_entries
      group by transaction_id
      having sum(case when direction = 'DEBIT' then amount_paise else -amount_paise end) <> 0`);
    const d = toSafe(totals?.debits ?? '0');
    const c = toSafe(totals?.credits ?? '0');
    return {
      totalDebitsPaise: d,
      totalCreditsPaise: c,
      balanced: d === c && bad.rows.length === 0,
      unbalancedTransactions: bad.rows.map((r) => Number(r.transaction_id)),
      transactionCount: Number(totals?.txCount ?? 0),
    };
  }

  private async accountId(tx: DbExecutor, account: AccountRef): Promise<number> {
    const [row] = await tx
      .insert(ledgerAccounts)
      .values({ code: account.code, type: account.type, createdAt: this.clock.now() })
      .onConflictDoUpdate({ target: ledgerAccounts.code, set: { code: sql`excluded.code` } })
      .returning({ id: ledgerAccounts.id, type: ledgerAccounts.type });
    if (row!.type !== account.type) {
      throw new Error(`Ledger account ${account.code} is ${row!.type}, not ${account.type}.`);
    }
    return row!.id;
  }
}

function toSafe(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('Ledger total exceeds MAX_SAFE_INTEGER.');
  return n;
}

@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
