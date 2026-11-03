import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { parseEnv } from '../../src/platform/config/app-config';
import { ledgerTransactions } from '../../src/modules/ledger/ledger.schema';
import { paymentWebhookEvents, payments } from '../../src/modules/payments/payments.schema';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { FakeUpiGateway } from '../../src/providers/upi/fake-upi.gateway';
import { RazorpayUpiGateway } from '../../src/providers/upi/razorpay-upi.gateway';
import {
  ACTIVE_UPI_GATEWAY,
  UPI_GATEWAYS,
  type UpiGateway,
} from '../../src/providers/upi/upi-gateway';
import { acceptedBooking, processWebhooks, startPayment } from '../fixtures/booking';
import {
  MockRazorpayClient,
  RZP_TEST_KEYS,
  checkoutSignature,
  razorpayWebhook,
} from '../fixtures/razorpay-mock';
import { bearer, createTestApp, resetState, seedCatalog, type TestApp } from '../fixtures/test-app';

const RZP_ENV = {
  UPI_PROVIDER: 'razorpay' as const,
  RAZORPAY_KEY_ID: RZP_TEST_KEYS.keyId,
  RAZORPAY_KEY_SECRET: RZP_TEST_KEYS.keySecret,
  RAZORPAY_WEBHOOK_SECRET: RZP_TEST_KEYS.webhookSecret,
};

describe('Part 10: Razorpay is test-mode only', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379/0',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'r',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    S3_BUCKET: 'bucket',
    LIVEKIT_URL: 'http://localhost:7880',
    LIVEKIT_API_KEY: 'k',
    LIVEKIT_API_SECRET: 's',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };

  it('refuses live keys and requires all three secrets', () => {
    expect(() => parseEnv({ ...base, ...RZP_ENV, RAZORPAY_KEY_ID: 'rzp_live_abc123' })).toThrow(
      /TEST key/,
    );
    expect(() =>
      parseEnv({ ...base, UPI_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: RZP_TEST_KEYS.keyId }),
    ).toThrow(/RAZORPAY_KEY_SECRET: is required when UPI_PROVIDER=razorpay/);
    expect(parseEnv({ ...base, ...RZP_ENV }).UPI_PROVIDER).toBe('razorpay');
    expect(
      () =>
        new RazorpayUpiGateway({ ...RZP_TEST_KEYS, keyId: 'rzp_live_x' }, new MockRazorpayClient()),
    ).toThrow();
  });
});

/** The same contract, run against both adapters. */
describe.each([
  ['fake', null],
  ['razorpay', new MockRazorpayClient()],
] as const)('Part 10: UpiGateway contract (%s)', (name, mock) => {
  let t: TestApp;
  let gw: UpiGateway;
  /** Simulates the payer paying the order at the provider; returns the provider payment id. */
  let payAtProvider: (orderId: string) => Promise<string>;
  let sign: { checkout: (o: string, p: string) => string; webhook: (b: Buffer) => string };

  beforeAll(async () => {
    t = await createTestApp();
    if (name === 'fake') {
      const fake = t.app.get(FakeUpiGateway);
      gw = fake;
      payAtProvider = async (o) => (await fake.simulatePayment(o)).paymentId;
      sign = { checkout: (o, p) => fake.signCheckout(o, p), webhook: (b) => fake.signWebhook(b) };
    } else {
      gw = new RazorpayUpiGateway(RZP_TEST_KEYS, mock!);
      payAtProvider = async (o) => mock!.capture(o).id;
      sign = {
        checkout: (o, p) => checkoutSignature(o, p),
        webhook: (b) => createHmac('sha256', RZP_TEST_KEYS.webhookSecret).update(b).digest('hex'),
      };
    }
  });

  afterAll(async () => {
    await t.close();
  });

  it('creates orders, finds captured payments and refunds them', async () => {
    const order = await gw.createOrder({
      amountPaise: 49900,
      currency: 'INR',
      receipt: randomUUID(),
    });
    expect(order).toMatchObject({
      amountPaise: 49900,
      currency: 'INR',
      providerOrderId: expect.any(String),
    });
    expect(await gw.fetchOrderPayments(order.providerOrderId)).toEqual([]);

    const paymentId = await payAtProvider(order.providerOrderId);
    const [found] = await gw.fetchOrderPayments(order.providerOrderId);
    expect(found).toMatchObject({
      providerPaymentId: paymentId,
      status: 'captured',
      amountPaise: 49900,
      currency: 'INR',
    });
    expect(await gw.fetchPayment(paymentId)).toMatchObject({
      providerOrderId: order.providerOrderId,
    });

    const refund = await gw.refund({
      providerPaymentId: paymentId,
      amountPaise: 49900,
      receipt: 'r1',
    });
    expect(refund.providerRefundId).toEqual(expect.any(String));
  });

  it('verifies checkout signatures and webhook signatures, and rejects forgeries', async () => {
    expect(
      gw.verifyCheckoutResponse({
        providerOrderId: 'o1',
        providerPaymentId: 'p1',
        signature: sign.checkout('o1', 'p1'),
      }),
    ).toBe(true);
    expect(
      gw.verifyCheckoutResponse({
        providerOrderId: 'o1',
        providerPaymentId: 'p2',
        signature: sign.checkout('o1', 'p1'),
      }),
    ).toBe(false);
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(gw.verifyWebhook(body, sign.webhook(body))).toBe(true);
    expect(gw.verifyWebhook(Buffer.from('{"event":"payment.captured" }'), sign.webhook(body))).toBe(
      false,
    );
    expect(gw.verifyWebhook(body, 'deadbeef')).toBe(false);
  });

  it('never exposes secrets in the public checkout config', () => {
    const cfg = JSON.stringify(gw.publicCheckoutConfig());
    expect(cfg).not.toContain(RZP_TEST_KEYS.keySecret);
    expect(cfg).not.toContain(RZP_TEST_KEYS.webhookSecret);
    if (name === 'razorpay') {
      expect(gw.publicCheckoutConfig()).toMatchObject({
        keyId: RZP_TEST_KEYS.keyId,
        checkoutOptions: { config: { display: { hide: [{ method: 'upi', flows: ['collect'] }] } } },
      });
    }
  });
});

describe('Part 10: end-to-end with UPI_PROVIDER=razorpay (mocked SDK, test data only)', () => {
  let t: TestApp;
  let mock: MockRazorpayClient;

  beforeAll(async () => {
    mock = new MockRazorpayClient();
    const rzp = new RazorpayUpiGateway(RZP_TEST_KEYS, mock);
    t = await createTestApp({
      env: RZP_ENV,
      overrides: [
        { provide: UPI_GATEWAYS, useValue: { razorpay: rzp } },
        { provide: ACTIVE_UPI_GATEWAY, useValue: rzp },
      ],
    });
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const postWebhook = (body: string, signature: string, eventId: string) =>
    t.http
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', eventId)
      .send(body);

  it('returns only order id, amount, currency and the public key to the client', async () => {
    const b = await acceptedBooking(t, 1);
    const res = await startPayment(t, b);
    expect(res.body.checkout).toEqual({
      provider: 'razorpay',
      keyId: RZP_TEST_KEYS.keyId,
      orderId: expect.stringMatching(/^order_TEST/),
      amount: b.amountPaise,
      currency: 'INR',
      checkoutOptions: { config: { display: { hide: [{ method: 'upi', flows: ['collect'] }] } } },
    });
  });

  it('recorded webhooks: signature checked on the raw body, duplicates removed by event id', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const paymentId = mock.capture(started.body.providerOrderId).id;
    const hook = razorpayWebhook('payment.captured', {
      orderId: started.body.providerOrderId,
      paymentId,
      amount: b.amountPaise,
    });

    const forged = await postWebhook(hook.body, 'a'.repeat(64), 'evt_TEST_1').expect(400);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');

    expect((await postWebhook(hook.body, hook.signature, 'evt_TEST_1').expect(200)).body).toEqual({
      received: true,
      duplicate: false,
    });
    expect(
      (await postWebhook(hook.body, hook.signature, 'evt_TEST_1').expect(200)).body.duplicate,
    ).toBe(true);
    const paid = razorpayWebhook('order.paid', {
      orderId: started.body.providerOrderId,
      paymentId,
      amount: b.amountPaise,
    });
    await postWebhook(paid.body, paid.signature, 'evt_TEST_2').expect(200);
    await processWebhooks(t);

    const [row] = await t.db.select().from(payments).where(eq(payments.id, started.body.id));
    expect(row).toMatchObject({
      status: 'HELD',
      providerPaymentId: paymentId,
      provider: 'razorpay',
    });
    expect(await t.db.select().from(ledgerTransactions)).toHaveLength(1);
  });

  it('checkout confirm verifies the signature and checks status with the API', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const paymentId = mock.capture(started.body.providerOrderId).id;

    const bad = await t.http
      .post(`/student/payments/${started.body.id}/confirm`)
      .set(bearer(b.student))
      .send({
        razorpay_order_id: started.body.providerOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: 'nope',
      })
      .expect(400);
    expect(bad.body.error.code).toBe('INVALID_SIGNATURE');

    const ok = await t.http
      .post(`/student/payments/${started.body.id}/confirm`)
      .set(bearer(b.student))
      .send({
        razorpay_order_id: started.body.providerOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: checkoutSignature(started.body.providerOrderId, paymentId),
      })
      .expect(200);
    expect(ok.body.status).toBe('HELD');
  });

  it('handles payment.failed, refund.processed and wrong amounts', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const order = started.body.providerOrderId;

    const failed = razorpayWebhook('payment.failed', {
      orderId: order,
      paymentId: 'pay_TESTfailed01',
      amount: b.amountPaise,
    });
    await postWebhook(failed.body, failed.signature, 'evt_TEST_f').expect(200);
    await processWebhooks(t);
    expect(
      (await t.db.select().from(payments).where(eq(payments.id, started.body.id)))[0]!.status,
    ).toBe('FAILED');

    // A second attempt on the same order with the wrong amount gets refunded through the SDK.
    const wrong = mock.capture(order, b.amountPaise - 1000);
    const captured = razorpayWebhook('payment.captured', {
      orderId: order,
      paymentId: wrong.id,
      amount: b.amountPaise - 1000,
    });
    await postWebhook(captured.body, captured.signature, 'evt_TEST_c').expect(200);
    await processWebhooks(t);
    const [row] = await t.db.select().from(payments).where(eq(payments.id, started.body.id));
    expect(row).toMatchObject({ status: 'REFUNDED', refundReason: 'AMOUNT_MISMATCH' });
    expect(mock.refunds).toContainEqual({ paymentId: wrong.id, amount: b.amountPaise - 1000 });

    const refunded = razorpayWebhook('refund.processed', {
      orderId: order,
      paymentId: wrong.id,
      amount: b.amountPaise - 1000,
    });
    await postWebhook(refunded.body, refunded.signature, 'evt_TEST_r').expect(200);
    await processWebhooks(t);
    const events = await t.db.select().from(paymentWebhookEvents);
    expect(events.every((e) => e.status === 'PROCESSED')).toBe(true);
  });

  it('unknown events are saved and ignored safely', async () => {
    const hook = razorpayWebhook('payment.dispute.created', {
      orderId: 'order_x',
      paymentId: 'pay_x',
      amount: 100,
    });
    await postWebhook(hook.body, hook.signature, 'evt_TEST_u').expect(200);
    await processWebhooks(t);
    const [ev] = await t.db.select().from(paymentWebhookEvents);
    expect(ev).toMatchObject({
      provider: 'razorpay',
      eventType: 'payment.dispute.created',
      status: 'IGNORED',
    });
  });

  it('the sweep finds a captured payment through the API when the webhook was missed', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    mock.capture(started.body.providerOrderId);
    t.clock.advanceMinutes(3);
    await t.app.get(PaymentsService).sweep();
    expect(
      (await t.db.select().from(payments).where(eq(payments.id, started.body.id)))[0]!.status,
    ).toBe('HELD');
  });
});
