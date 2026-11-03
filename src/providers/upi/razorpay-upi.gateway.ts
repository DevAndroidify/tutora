import { createHmac } from 'node:crypto';
import Razorpay from 'razorpay';
import { safeEqualHex } from './fake-upi.gateway';
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

/** The subset of the official SDK client we use; tests pass a mock with the same shape. */
export interface RazorpayClient {
  orders: {
    create(
      params: Record<string, unknown>,
    ): Promise<{ id: string; amount: number | string; currency: string }>;
    fetchPayments(orderId: string): Promise<{ items: RazorpayPaymentEntity[] }>;
  };
  payments: {
    fetch(paymentId: string): Promise<RazorpayPaymentEntity>;
    refund(
      paymentId: string,
      params: Record<string, unknown>,
    ): Promise<{ id: string; status: string }>;
  };
}

export interface RazorpayPaymentEntity {
  id: string;
  order_id: string | null;
  amount: number | string;
  currency: string;
  status: string;
  method?: string;
}

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

const hmac = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

/**
 * Razorpay Standard Checkout adapter (UPI Intent on mobile, QR on desktop; Collect hidden).
 * TEST MODE ONLY: refuses anything but rzp_test_ keys.
 */
export class RazorpayUpiGateway implements UpiGateway {
  readonly name = 'razorpay' as const;
  private readonly client: RazorpayClient;

  constructor(
    private readonly keys: RazorpayKeys,
    client?: RazorpayClient,
  ) {
    if (!/^rzp_test_/.test(keys.keyId)) {
      throw new Error('Razorpay adapter only runs with TEST keys (rzp_test_...).');
    }
    this.client =
      client ??
      (new Razorpay({
        key_id: keys.keyId,
        key_secret: keys.keySecret,
      }) as unknown as RazorpayClient);
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const order = await this.client.orders.create({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
    });
    return { providerOrderId: order.id, amountPaise: Number(order.amount), currency: 'INR' };
  }

  /** Signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
  verifyCheckoutResponse(input: CheckoutResponse): boolean {
    const expected = hmac(
      this.keys.keySecret,
      `${input.providerOrderId}|${input.providerPaymentId}`,
    );
    return typeof input.signature === 'string' && safeEqualHex(expected, input.signature);
  }

  /** X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret). Must use the raw bytes. */
  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    return (
      typeof signature === 'string' &&
      safeEqualHex(hmac(this.keys.webhookSecret, rawBody), signature)
    );
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
    return toPayment(await this.client.payments.fetch(providerPaymentId));
  }

  async fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]> {
    const res = await this.client.orders.fetchPayments(providerOrderId);
    return (res.items ?? []).map(toPayment);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const r = await this.client.payments.refund(input.providerPaymentId, {
      amount: input.amountPaise,
      speed: 'normal',
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
    });
    return {
      providerRefundId: r.id,
      status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'pending',
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ParsedWebhook {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload?: {
        payment?: { entity: RazorpayPaymentEntity };
        order?: { entity: { id: string } };
        refund?: {
          entity: { id: string; payment_id: string; amount: number | string; status: string };
        };
      };
    };
    const paymentEntity = body.payload?.payment?.entity;
    const refundEntity = body.payload?.refund?.entity;
    return {
      eventId: header(headers, 'x-razorpay-event-id') ?? '',
      type: body.event,
      payment: paymentEntity
        ? toPayment({
            ...paymentEntity,
            order_id: paymentEntity.order_id ?? body.payload?.order?.entity.id ?? null,
          })
        : undefined,
      refund: refundEntity
        ? {
            providerRefundId: refundEntity.id,
            providerPaymentId: refundEntity.payment_id,
            amountPaise: Number(refundEntity.amount),
            status: refundEntity.status,
          }
        : undefined,
    };
  }

  /** Only public data. The client opens Standard Checkout with these options. */
  publicCheckoutConfig(): Record<string, unknown> {
    return {
      provider: 'razorpay',
      keyId: this.keys.keyId,
      checkoutOptions: {
        // UPI Collect is deprecated (NPCI, 28 Feb 2026): never offer it. Intent on mobile, QR on desktop.
        config: { display: { hide: [{ method: 'upi', flows: ['collect'] }] } },
      },
    };
  }
}

function toPayment(p: RazorpayPaymentEntity): ProviderPayment {
  const status = (['created', 'authorized', 'captured', 'failed', 'refunded'] as const).find(
    (s) => s === p.status,
  );
  return {
    providerPaymentId: p.id,
    providerOrderId: p.order_id ?? '',
    amountPaise: Number(p.amount),
    currency: p.currency,
    status: status ?? 'created',
    method: p.method,
  };
}
