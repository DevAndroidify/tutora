import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from '../app/core.module';
import { LedgerModule, LedgerService } from '../modules/ledger/ledger.service';

@Module({ imports: [CoreModule, LedgerModule] })
class ReportModule {}

const rupees = (paise: number) => `Rs ${(paise / 100).toFixed(2)}`;

/** Prints every ledger account balance and the reconciliation check (`yarn ledger:report`). */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ReportModule, {
    logger: ['error', 'warn'],
  });
  try {
    const ledger = app.get(LedgerService);
    console.log('Ledger balances');
    for (const b of await ledger.balances()) {
      console.log(
        `  ${b.code.padEnd(52)} ${b.type.padEnd(9)} ${rupees(b.balancePaise).padStart(14)}`,
      );
    }
    const rec = await ledger.reconcile();
    const verdict = rec.balanced
      ? 'BALANCED'
      : `UNBALANCED: ${rec.unbalancedTransactions.join(', ')}`;
    console.log(
      `Reconciliation: ${rec.transactionCount} transactions, debits ${rupees(rec.totalDebitsPaise)}, credits ${rupees(rec.totalCreditsPaise)} -> ${verdict}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
