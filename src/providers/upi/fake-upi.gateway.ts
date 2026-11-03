import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import {
  header,
  type CheckoutResponse,
  type CreateOrderInput,
  type CreateOrderResult,
  type ParsedWebhook,
  type ProviderPayment,
  type RefundInput,
  type RefundResult,
  type UpiGateway,
} from './upi-gateway';
import { fakeUpiOrders } from './fake-upi.schema';

const id = (prefix: string) => `${prefix}_fake_${randomBytes(9).toString('hex')}`;
const hmac = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Local UPI simulator with the same contract and signature rules as a real provider. */
@Injectable()
export class FakeUpiGateway implements UpiGateway {
  readonly name = 'fake' as const;

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  private get secret(): string {
    return this.config.env.FAKE_UPI_WEBHOOK_SECRET;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const orderId = id('order');
    await this.db.insert(fakeUpiOrders).values({
      id: orderId,
      amountPaise: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      createdAt: this.clock.now(),
    });
    return { providerOrderId: orderId, amountPaise: input.amountPaise, currency: input.currency };
  }

  /** Same scheme as Razorpay: HMAC-SHA256(order_id|payment_id). */
  signCheckout(orderId: string, paymentId: string): string {
    return hmac(this.secret, `${orderId}|${paymentId}`);
  }

  verifyCheckoutResponse(input: CheckoutResponse): boolean {
    return safeEqualHex(
      this.signCheckout(input.providerOrderId, input.providerPaymentId),
      input.signature,
    );
  }

  signWebhook(rawBody: Buffer | string): string {
    return hmac(this.secret, rawBody);
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    return typeof signature === 'string' && safeEqualHex(this.signWebhook(rawBody), signature);
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const [o] = await this.db
      .select()
      .from(fakeUpiOrders)
      .where(eq(fakeUpiOrders.paymentId, providerPaymentId));
    if (!o) throw AppError.notFound('PROVIDER_PAYMENT_NOT_FOUND', 'Payment not found at provider.');
    return this.toPayment(o);
  }

  async fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]> {
    const [o] = await this.db
      .select()
      .from(fakeUpiOrders)
      .where(eq(fakeUpiOrders.id, providerOrderId));
    return o?.paymentId ? [this.toPayment(o)] : [];
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refundId = id('rfnd');
    const rows = await this.db
      .update(fakeUpiOrders)
      .set({ refundId, paymentStatus: 'refunded' })
      .where(eq(fakeUpiOrders.paymentId, input.providerPaymentId))
      .returning({ id: fakeUpiOrders.id });
    if (rows.length === 0) throw new Error('Fake gateway: payment to refund not found');
    return { providerRefundId: refundId, status: 'processed' };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ParsedWebhook {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      event: string;
      payment?: ProviderPayment;
    };
    return {
      eventId: header(headers, 'x-fake-event-id') ?? body.id ?? '',
      type: body.event,
      payment: body.payment,
    };
  }

  publicCheckoutConfig(): Record<string, unknown> {
    return { provider: 'fake', simulatePaymentUrl: '/dev/fake-upi/orders/{orderId}/pay' };
  }

  // ---------- Simulator controls (dev route and tests) ----------

  /**
   * Simulates the learner paying. Records the payment and returns a signed webhook
   * (`payment.captured`) exactly as a provider would send it.
   */
  async simulatePayment(
    orderId: string,
    opts: { amountPaise?: number; fail?: boolean } = {},
  ): Promise<{ rawBody: Buffer; signature: string; eventId: string; paymentId: string }> {
    const [o] = await this.db.select().from(fakeUpiOrders).where(eq(fakeUpiOrders.id, orderId));
    if (!o) throw AppError.notFound('ORDER_NOT_FOUND', 'Fake order not found.');
    const paymentId = o.paymentId ?? id('pay');
    const amountPaise = opts.amountPaise ?? o.amountPaise;
    const status = opts.fail ? 'failed' : 'captured';
    await this.db
      .update(fakeUpiOrders)
      .set({ paymentId, paidAmountPaise: amountPaise, paymentStatus: status })
      .where(eq(fakeUpiOrders.id, orderId));
    return this.buildWebhook(opts.fail ? 'payment.failed' : 'payment.captured', {
      providerPaymentId: paymentId,
      providerOrderId: orderId,
      amountPaise,
      currency: o.currency,
      status,
      method: 'upi',
    });
  }

  buildWebhook(event: string, payment: ProviderPayment) {
    const eventId = id('evt');
    const rawBody = Buffer.from(JSON.stringify({ id: eventId, event, payment }));
    return {
      rawBody,
      signature: this.signWebhook(rawBody),
      eventId,
      paymentId: payment.providerPaymentId,
    };
  }

  private toPayment(o: typeof fakeUpiOrders.$inferSelect): ProviderPayment {
    return {
      providerPaymentId: o.paymentId!,
      providerOrderId: o.id,
      amountPaise: o.paidAmountPaise ?? o.amountPaise,
      currency: o.currency,
      status: (o.paymentStatus ?? 'created') as ProviderPayment['status'],
      method: 'upi',
    };
  }
}
