import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ledgerEntries, ledgerTransactions } from '../../src/modules/ledger/ledger.schema';
import {
  ACCOUNTS,
  LedgerService,
  splitFee,
  tutorPayable,
  type LedgerLine,
} from '../../src/modules/ledger/ledger.service';
import { createTestApp, resetState, type TestApp } from '../fixtures/test-app';

describe('Part 8: double-entry ledger', () => {
  let t: TestApp;
  let ledger: LedgerService;

  beforeAll(async () => {
    t = await createTestApp();
    ledger = t.app.get(LedgerService);
  });

  beforeEach(async () => {
    await resetState(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('randomized money flows always balance, and the books add up', async () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const tutors = [randomUUID(), randomUUID(), randomUUID()];
    let held = 0;
    for (let i = 0; i < 150; i++) {
      const amount = 100 + rand(500_000);
      const id = `p${i}`;
      await ledger.paymentVerified(id, amount);
      held += amount;
      const action = rand(3);
      if (action === 0) {
        await ledger.holdReleased(id, tutors[rand(3)]!, amount, t.config.env.PLATFORM_FEE_BPS);
        held -= amount;
      } else if (action === 1) {
        await ledger.refundSent(id, amount);
        held -= amount;
      }
    }
    for (const tutor of tutors) {
      const payable = await ledger.balanceOf(tutorPayable(tutor).code);
      if (payable > 0) await ledger.payoutRecorded(randomUUID(), tutor, payable);
    }

    const rec = await ledger.reconcile();
    expect(rec.balanced).toBe(true);
    expect(rec.totalDebitsPaise).toBe(rec.totalCreditsPaise);
    expect(rec.unbalancedTransactions).toEqual([]);

    const balances = Object.fromEntries(
      (await ledger.balances()).map((b) => [b.code, b.balancePaise]),
    );
    expect(balances.held_funds).toBe(held);
    for (const tutor of tutors) expect(balances[tutorPayable(tutor).code] ?? 0).toBe(0);
    // Assets = liabilities + revenue.
    const assets = (balances.gateway_clearing ?? 0) + (balances.payout_clearing ?? 0);
    expect(assets).toBe(balances.held_funds! + (balances.platform_revenue ?? 0));
  });

  it('splits the platform fee in whole paise', async () => {
    expect(splitFee(49900, 1000)).toEqual({ feePaise: 4990, tutorPaise: 44910 });
    expect(splitFee(999, 1000)).toEqual({ feePaise: 99, tutorPaise: 900 });
    const tutor = randomUUID();
    await ledger.paymentVerified('pay-1', 49900);
    await ledger.holdReleased('pay-1', tutor, 49900, 1000);
    expect(await ledger.balanceOf('platform_revenue')).toBe(4990);
    expect(await ledger.balanceOf(tutorPayable(tutor).code)).toBe(44910);
    expect(await ledger.balanceOf('held_funds')).toBe(0);
  });

  it('rejects unbalanced transactions in the service', async () => {
    const lines: LedgerLine[] = [
      { account: ACCOUNTS.gatewayClearing, direction: 'DEBIT', amountPaise: 1000 },
      { account: ACCOUNTS.heldFunds, direction: 'CREDIT', amountPaise: 999 },
    ];
    await expect(ledger.post({ idempotencyKey: 'bad', kind: 'TEST', lines })).rejects.toMatchObject(
      {
        code: 'LEDGER_UNBALANCED',
      },
    );
    await expect(
      ledger.post({
        idempotencyKey: 'float',
        kind: 'TEST',
        lines: [
          { account: ACCOUNTS.gatewayClearing, direction: 'DEBIT', amountPaise: 10.5 },
          { account: ACCOUNTS.heldFunds, direction: 'CREDIT', amountPaise: 10.5 },
        ],
      }),
    ).rejects.toThrow(/whole paise/);
    expect(await t.db.select().from(ledgerTransactions)).toHaveLength(0);
  });

  it('the database refuses an unbalanced transaction at commit (deferred trigger)', async () => {
    await ledger.paymentVerified('seed', 100); // creates the accounts
    const accounts = await t.db.execute<{ id: string }>(
      sql`select id from ledger_accounts order by code`,
    );
    await expect(
      t.db.transaction(async (tx) => {
        const [txn] = await tx
          .insert(ledgerTransactions)
          .values({ idempotencyKey: 'raw-bad', kind: 'TEST', createdAt: new Date() })
          .returning();
        await tx.insert(ledgerEntries).values([
          {
            transactionId: txn!.id,
            accountId: Number(accounts.rows[0]!.id),
            direction: 'DEBIT',
            amountPaise: 500,
            createdAt: new Date(),
          },
          {
            transactionId: txn!.id,
            accountId: Number(accounts.rows[1]!.id),
            direction: 'CREDIT',
            amountPaise: 400,
            createdAt: new Date(),
          },
        ]);
      }),
    ).rejects.toThrow();
    expect((await ledger.reconcile()).transactionCount).toBe(1);
  });

  it('repeated posting with the same key creates one transaction', async () => {
    const first = await ledger.paymentVerified('same', 5000);
    const results = await Promise.all([1, 2, 3].map(() => ledger.paymentVerified('same', 5000)));
    expect(first.created).toBe(true);
    expect(results.every((r) => !r.created && r.transactionId === first.transactionId)).toBe(true);
    expect(await t.db.select().from(ledgerTransactions)).toHaveLength(1);
    expect(await ledger.balanceOf('held_funds')).toBe(5000);
  });

  it('UPDATE and DELETE on ledger rows fail', async () => {
    await ledger.paymentVerified('immutable', 700);
    await expect(t.db.update(ledgerEntries).set({ amountPaise: 1 })).rejects.toThrow();
    await expect(t.db.delete(ledgerEntries)).rejects.toThrow();
    await expect(t.db.update(ledgerTransactions).set({ kind: 'X' })).rejects.toThrow();
    await expect(t.db.delete(ledgerTransactions)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from ledger_accounts`)).rejects.toThrow();
    expect(await ledger.balanceOf('held_funds')).toBe(700);
  });
});
