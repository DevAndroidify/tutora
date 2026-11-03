import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * State of the simulated provider. Owned by the fake gateway only (development and tests);
 * it plays the role of the provider's own database.
 */
export const fakeUpiOrders = pgTable('fake_upi_orders', {
  id: text('id').primaryKey(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  currency: text('currency').notNull(),
  receipt: text('receipt').notNull(),
  paymentId: text('payment_id'),
  paidAmountPaise: bigint('paid_amount_paise', { mode: 'number' }),
  paymentStatus: text('payment_status'),
  refundId: text('refund_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
