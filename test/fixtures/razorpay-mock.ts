import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  RazorpayClient,
  RazorpayPaymentEntity,
} from '../../src/providers/upi/razorpay-upi.gateway';

/** Test-mode credentials used only by tests. Not real keys. */
export const RZP_TEST_KEYS = {
  keyId: 'rzp_test_TutoraFixture01',
  keySecret: 'test_key_secret_not_real',
  webhookSecret: 'test_webhook_secret_not_real',
};

/**
 * In-memory stand-in for the official Razorpay SDK client (same method shapes),
 * so adapter tests never call Razorpay and never need a real account.
 */
export class MockRazorpayClient implements RazorpayClient {
  private n = 0;
  readonly ordersById = new Map<
    string,
    { id: string; amount: number; currency: string; receipt?: string }
  >();
  readonly paymentsById = new Map<string, RazorpayPaymentEntity>();
  readonly refunds: Array<{ paymentId: string; amount: number }> = [];

  orders = {
    create: async (params: Record<string, unknown>) => {
      const order = {
        id: `order_TEST${String(++this.n).padStart(10, '0')}`,
        amount: Number(params.amount),
        currency: String(params.currency),
        receipt: String(params.receipt),
      };
      this.ordersById.set(order.id, order);
      return order;
    },
    fetchPayments: async (orderId: string) => ({
      items: [...this.paymentsById.values()].filter((p) => p.order_id === orderId),
    }),
  };

  payments = {
    fetch: async (paymentId: string) => {
      const p = this.paymentsById.get(paymentId);
      if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400 });
      return p;
    },
    refund: async (paymentId: string, params: Record<string, unknown>) => {
      this.refunds.push({ paymentId, amount: Number(params.amount) });
      const p = this.paymentsById.get(paymentId);
      if (p) p.status = 'refunded';
      return { id: `rfnd_TEST${String(++this.n).padStart(10, '0')}`, status: 'processed' };
    },
  };

  /** Simulates the learner completing UPI payment in test mode. */
  capture(orderId: string, amount?: number): RazorpayPaymentEntity {
    const order = this.ordersById.get(orderId)!;
    const p: RazorpayPaymentEntity = {
      id: `pay_TEST${String(++this.n).padStart(10, '0')}`,
      order_id: orderId,
      amount: amount ?? order.amount,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
    };
    this.paymentsById.set(p.id, p);
    return p;
  }
}

/** Loads a recorded webhook fixture, fills the placeholders and signs it like Razorpay does. */
export function razorpayWebhook(
  name: string,
  values: { orderId: string; paymentId: string; amount: number },
  secret = RZP_TEST_KEYS.webhookSecret,
) {
  const raw = readFileSync(resolve(__dirname, 'razorpay', `${name}.json`), 'utf8')
    .replaceAll('{{ORDER_ID}}', values.orderId)
    .replaceAll('{{PAYMENT_ID}}', values.paymentId)
    .replaceAll('{{AMOUNT}}', String(values.amount));
  const body = JSON.stringify(JSON.parse(raw)); // compact, as Razorpay sends it
  return { body, signature: createHmac('sha256', secret).update(body).digest('hex') };
}

export const checkoutSignature = (
  orderId: string,
  paymentId: string,
  secret = RZP_TEST_KEYS.keySecret,
) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
