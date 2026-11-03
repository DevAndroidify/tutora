import { eq } from 'drizzle-orm';
import { auditLog } from '../../src/platform/audit/audit.schema';
import { bids } from '../../src/modules/bidding/bidding.schema';
import { ledgerTransactions } from '../../src/modules/ledger/ledger.schema';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { paymentWebhookEvents, payments } from '../../src/modules/payments/payments.schema';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { learningRequests } from '../../src/modules/requests/requests.schema';
import { BookingService } from '../../src/modules/sessions/booking.service';
import { sessionParticipants, sessions } from '../../src/modules/sessions/sessions.schema';
import { RealtimeRouterModule } from '../../src/modules/realtime/realtime.router';
import { FakeUpiGateway } from '../../src/providers/upi/fake-upi.gateway';
import { acceptedBooking, processWebhooks, startPayment, type Booked } from '../fixtures/booking';
import { publishOutbox } from '../fixtures/marketplace';
import {
  bearer,
  createTestApp,
  login,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 9: UPI payments with the fake gateway', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [RealtimeRouterModule] });
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const pay = (orderId: string, body: object = {}) =>
    t.http.post(`/dev/fake-upi/orders/${orderId}/pay`).send(body).expect(200);

  async function paymentRow(id: string) {
    const [row] = await t.db.select().from(payments).where(eq(payments.id, id));
    return row!;
  }

  async function bookingState(b: Booked) {
    const [p] = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, b.participantId));
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, b.sessionId));
    const [r] = await t.db
      .select()
      .from(learningRequests)
      .where(eq(learningRequests.id, b.requestId));
    const bidRows = await t.db.select().from(bids).where(eq(bids.requestId, b.requestId));
    return {
      participant: p!.status,
      session: s!.status,
      request: r!.status,
      bids: bidRows.map((x) => x.status).sort(),
    };
  }

  it('full flow: accepted bid -> order -> simulated UPI payment -> held money and a scheduled session', async () => {
    const b = await acceptedBooking(t, 2);
    const started = await startPayment(t, b);
    expect(started.body).toMatchObject({
      status: 'INITIATED',
      amountPaise: b.amountPaise,
      currency: 'INR',
      provider: 'fake',
      checkout: {
        orderId: expect.stringMatching(/^order_fake_/),
        amount: b.amountPaise,
        currency: 'INR',
      },
    });
    // Retrying with the same Idempotency-Key replays the first response.
    const replay = await startPayment(t, b);
    expect(replay.body.id).toBe(started.body.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const paid = await pay(started.body.providerOrderId);
    expect(paid.body).toMatchObject({ received: true, duplicate: false });
    expect((await paymentRow(started.body.id)).status).toBe('INITIATED'); // saved first, processed later
    await processWebhooks(t);

    expect((await paymentRow(started.body.id)).status).toBe('HELD');
    expect(await bookingState(b)).toEqual({
      participant: 'CONFIRMED',
      session: 'SCHEDULED',
      request: 'BOOKED',
      bids: ['ACCEPTED', 'REJECTED'],
    });
    const ledger = t.app.get(LedgerService);
    expect(await ledger.balanceOf('held_funds')).toBe(b.amountPaise);
    expect(await ledger.balanceOf('gateway_clearing')).toBe(b.amountPaise);

    const status = await t.http
      .get(`/student/payments/${started.body.id}`)
      .set(bearer(b.student))
      .expect(200);
    expect(status.body.status).toBe('HELD');
    await publishOutbox(t);
    const notes = await t.http.get('/student/notifications').set(bearer(b.student)).expect(200);
    expect(notes.body.map((n: { type: string }) => n.type)).toContain('session.scheduled');
  });

  it('repeated webhooks create one ledger transaction', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const fake = t.app.get(FakeUpiGateway);
    const hook = await fake.simulatePayment(started.body.providerOrderId);
    const headers = { 'x-fake-signature': hook.signature, 'x-fake-event-id': hook.eventId };
    const svc = t.app.get(PaymentsService);

    expect(await svc.ingestWebhook('fake', hook.rawBody, headers)).toEqual({
      received: true,
      duplicate: false,
    });
    expect(await svc.ingestWebhook('fake', hook.rawBody, headers)).toEqual({
      received: true,
      duplicate: true,
    });
    // A different event about the same payment (e.g. order.paid) is also harmless.
    const again = fake.buildWebhook('order.paid', await fake.fetchPayment(hook.paymentId));
    await svc.ingestWebhook('fake', again.rawBody, {
      'x-fake-signature': again.signature,
      'x-fake-event-id': again.eventId,
    });
    await processWebhooks(t);
    await processWebhooks(t);

    expect(await t.db.select().from(ledgerTransactions)).toHaveLength(1);
    expect((await paymentRow(started.body.id)).status).toBe('HELD');
  });

  it('rejects forged signatures and stores nothing', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const hook = await t.app.get(FakeUpiGateway).simulatePayment(started.body.providerOrderId);
    const res = await t.http
      .post('/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-fake-signature', 'f'.repeat(64))
      .set('x-fake-event-id', hook.eventId)
      .send(hook.rawBody.toString())
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await t.db.select().from(paymentWebhookEvents)).toHaveLength(0);

    // The same body with the right signature over HTTP is accepted (raw-body verification works).
    await t.http
      .post('/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-fake-signature', hook.signature)
      .set('x-fake-event-id', hook.eventId)
      .send(hook.rawBody.toString())
      .expect(200);
  });

  it('out-of-order events are safe: a late "failed" cannot undo a capture; a capture after "failed" still counts', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const fake = t.app.get(FakeUpiGateway);
    const svc = t.app.get(PaymentsService);
    const send = async (event: string, status: 'failed' | 'captured') => {
      const hook = fake.buildWebhook(event, {
        providerPaymentId: 'pay_fake_ooo',
        providerOrderId: started.body.providerOrderId,
        amountPaise: b.amountPaise,
        currency: 'INR',
        status,
      });
      await svc.ingestWebhook('fake', hook.rawBody, {
        'x-fake-signature': hook.signature,
        'x-fake-event-id': hook.eventId,
      });
      await processWebhooks(t);
    };
    await send('payment.failed', 'failed');
    expect((await paymentRow(started.body.id)).status).toBe('FAILED');
    await send('payment.captured', 'captured');
    expect((await paymentRow(started.body.id)).status).toBe('HELD');
    await send('payment.failed', 'failed');
    expect((await paymentRow(started.body.id)).status).toBe('HELD');
  });

  it('a payment after the window expired is refunded automatically and staff are alerted', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    t.clock.advanceMinutes(t.config.env.PAYMENT_WINDOW_MINUTES + 1);
    await t.app.get(BookingService).sweepExpiredPayments();

    await pay(started.body.providerOrderId);
    await processWebhooks(t);

    const row = await paymentRow(started.body.id);
    expect(row).toMatchObject({ status: 'REFUNDED', refundReason: 'BOOKING_NOT_PAYABLE' });
    expect(row.providerRefundId).toMatch(/^rfnd_fake_/);
    const ledger = t.app.get(LedgerService);
    expect(await ledger.balanceOf('held_funds')).toBe(0);
    expect(await ledger.balanceOf('gateway_clearing')).toBe(0);
    expect((await ledger.reconcile()).balanced).toBe(true);
    expect((await bookingState(b)).request).toBe('OPEN');

    const alerts = await t.db.select().from(auditLog).where(eq(auditLog.entityId, row.id));
    expect(alerts.map((a) => a.action).sort()).toEqual([
      'payment.alert.booking_not_payable',
      'payment.auto_refunded',
    ]);
    await publishOutbox(t);
    const fresh = await login(t, 'student', b.student);
    const notes = await t.http.get('/student/notifications').set(bearer(fresh)).expect(200);
    expect(notes.body.map((n: { type: string }) => n.type)).toContain('payment.refunded');
  });

  it('a wrong amount is refunded and does not confirm the booking', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    await pay(started.body.providerOrderId, { amountPaise: b.amountPaise - 100 });
    await processWebhooks(t);
    expect(await paymentRow(started.body.id)).toMatchObject({
      status: 'REFUNDED',
      refundReason: 'AMOUNT_MISMATCH',
    });
    expect((await bookingState(b)).participant).toBe('PENDING_PAYMENT');
  });

  it('a failed payment can be retried with a new order', async () => {
    const b = await acceptedBooking(t, 1);
    const first = await startPayment(t, b, 'attempt-1');
    await pay(first.body.providerOrderId, { fail: true });
    await processWebhooks(t);
    expect((await paymentRow(first.body.id)).status).toBe('FAILED');
    const second = await startPayment(t, b, 'attempt-2');
    expect(second.body.id).not.toBe(first.body.id);
    await pay(second.body.providerOrderId);
    await processWebhooks(t);
    expect((await paymentRow(second.body.id)).status).toBe('HELD');
  });

  it('the sweep recovers a payment whose webhook never arrived', async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    await t.app.get(FakeUpiGateway).simulatePayment(started.body.providerOrderId); // no webhook delivered
    t.clock.advanceMinutes(3);
    await t.app.get(PaymentsService).sweep();
    expect((await paymentRow(started.body.id)).status).toBe('HELD');
  });

  it('unknown events are saved and ignored', async () => {
    const fake = t.app.get(FakeUpiGateway);
    const hook = fake.buildWebhook('payment.dispute.created', {
      providerPaymentId: 'pay_x',
      providerOrderId: 'order_x',
      amountPaise: 1,
      currency: 'INR',
      status: 'captured',
    });
    await t.app.get(PaymentsService).ingestWebhook('fake', hook.rawBody, {
      'x-fake-signature': hook.signature,
      'x-fake-event-id': hook.eventId,
    });
    await processWebhooks(t);
    const [ev] = await t.db.select().from(paymentWebhookEvents);
    expect(ev).toMatchObject({ eventType: 'payment.dispute.created', status: 'IGNORED' });
  });

  it("other students can't pay for or read someone else's booking", async () => {
    const b = await acceptedBooking(t, 1);
    const started = await startPayment(t, b);
    const other = await login(t, 'student', b.tutors[0]!); // a different member, signed in as a learner
    await t.http
      .post(`/student/participants/${b.participantId}/payments`)
      .set(bearer(other))
      .set('Idempotency-Key', 'steal-0001')
      .expect(403);
    await t.http.get(`/student/payments/${started.body.id}`).set(bearer(other)).expect(403);
  });
});

describe('Part 9: the dev payment route is unavailable in production', () => {
  it('returns 404 and the fake provider is not configured', async () => {
    const t = await createTestApp({
      env: {
        NODE_ENV: 'production',
        UPI_PROVIDER: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_test_prodcheck123',
        RAZORPAY_KEY_SECRET: 'test_secret_value',
        RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
      },
    });
    try {
      await t.http.post('/dev/fake-upi/orders/order_fake_x/pay').send({}).expect(404);
      const hook = await t.http
        .post('/webhooks/fake')
        .set('Content-Type', 'application/json')
        .set('x-fake-signature', 'x')
        .send('{}')
        .expect(404);
      expect(hook.body.error.code).toBe('UNKNOWN_PROVIDER');
      await t.http.get('/docs/student').expect(404);
    } finally {
      await t.close();
    }
  });
});
