/**
 * Provider-neutral UPI gateway. Implementations: FakeUpiGateway (local simulator) and
 * RazorpayUpiGateway (Razorpay Standard Checkout, TEST MODE ONLY).
 */

export type UpiProviderName = 'fake' | 'razorpay';

export interface CreateOrderInput {
  amountPaise: number;
  currency: 'INR';
  /** Our payment id; shows up in the provider dashboard. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreateOrderResult {
  providerOrderId: string;
  amountPaise: number;
  currency: 'INR';
}

/** What Standard Checkout returns to the client after payment. */
export interface CheckoutResponse {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

export interface ProviderPayment {
  providerPaymentId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  status: ProviderPaymentStatus;
  method?: string;
}

export interface RefundInput {
  providerPaymentId: string;
  amountPaise: number;
  /** Our idempotency reference for the refund. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'pending' | 'processed' | 'failed';
}

/** Normalized webhook event. Unknown event types keep `type` and are ignored safely. */
export interface ParsedWebhook {
  eventId: string;
  type: string;
  payment?: ProviderPayment;
  refund?: {
    providerRefundId: string;
    providerPaymentId: string;
    amountPaise: number;
    status: string;
  };
}

export interface UpiGateway {
  readonly name: UpiProviderName;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyCheckoutResponse(input: CheckoutResponse): boolean;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Extracts the event id (from headers or body) and normalized content. Call after verifyWebhook. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ParsedWebhook;
  /** Public data the client needs to open checkout (never secrets). */
  publicCheckoutConfig(): Record<string, unknown>;
}

/** Map of all configured gateways, keyed by provider name. */
export const UPI_GATEWAYS = Symbol('UPI_GATEWAYS');
export type UpiGateways = Partial<Record<UpiProviderName, UpiGateway>>;

/** The gateway new payments use (UPI_PROVIDER). */
export const ACTIVE_UPI_GATEWAY = Symbol('ACTIVE_UPI_GATEWAY');

export function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
