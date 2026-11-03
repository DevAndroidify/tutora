import { eq, inArray } from 'drizzle-orm';
import { payments } from '../../src/modules/payments/payments.schema';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { GroupBookingService } from '../../src/modules/group-booking/group-booking.service';
import { requestPools } from '../../src/modules/pooling/pooling.schema';
import { PoolingService } from '../../src/modules/pooling/pooling.service';
import { learningRequests } from '../../src/modules/requests/requests.schema';
import { sessionParticipants, sessions } from '../../src/modules/sessions/sessions.schema';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { FakeUpiGateway } from '../../src/providers/upi/fake-upi.gateway';
import { processWebhooks } from '../fixtures/booking';
import { finished, joined, sendLivekit } from '../fixtures/live';
import { approvedTutor, bidBody, openRequest } from '../fixtures/marketplace';
import {
  bearer,
  createTestApp,
  login,
  registerMember,
  resetState,
  seedCatalog,
  type Session,
  type TestApp,
} from '../fixtures/test-app';

const BASE = 'How do I identify a bullish engulfing candlestick pattern on daily charts';
const VARIANTS = [
  BASE,
  `${BASE} please`,
  `Identify a bullish engulfing candlestick pattern on daily charts`,
  `${BASE} quickly`,
  `Bullish engulfing candlestick pattern on daily charts, how do I identify it`,
];

describe('Part 19: pool bids and group payments', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  /** N learners with near-identical requests, all of whom accepted the pool invitation. */
  async function formedPool(
    n: number,
  ): Promise<{ poolId: string; members: Session[]; requestIds: string[] }> {
    const members: Session[] = [];
    const requestIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const s = await registerMember(t, 'student', { fullName: `Member ${i}` });
      const id = await openRequest(t, s, 'technical-analysis', {
        title: VARIANTS[i]!,
        description: VARIANTS[i]!,
      });
      await t.app.get(PoolingService).processRequest(id);
      members.push(s);
      requestIds.push(id);
    }
    let poolId = '';
    for (const m of members) {
      const [inv] = (await t.http.get('/student/pools/invites').set(bearer(m)).expect(200)).body;
      poolId = inv.pool.id;
      await t.http.post(`/student/pools/invites/${inv.id}/accept`).set(bearer(m)).expect(200);
    }
    return { poolId, members, requestIds };
  }

  async function groupBid(poolId: string, seats: { minSeats: number; maxSeats: number }) {
    const tutor = await approvedTutor(t, ['technical-analysis'], 'Group Tutor');
    const bid = await t.http
      .post(`/tutor/pools/${poolId}/bids`)
      .set(bearer(tutor))
      .send({ ...bidBody(t, { seatPricePaise: 19900 }), ...seats })
      .expect(201);
    return { tutor, bidId: bid.body.id as string };
  }

  async function acceptAndPay(m: Session, poolId: string, bidId: string, pay = true) {
    const acc = await t.http
      .post(`/student/pools/${poolId}/bids/${bidId}/accept`)
      .set(bearer(m))
      .expect(200);
    const order = await t.http
      .post(`/student/participants/${acc.body.participantId}/payments`)
      .set(bearer(m))
      .set('Idempotency-Key', `group-${acc.body.participantId}`)
      .expect(201);
    if (pay)
      await t.http
        .post(`/dev/fake-upi/orders/${order.body.providerOrderId}/pay`)
        .send({})
        .expect(200);
    return {
      participantId: acc.body.participantId as string,
      paymentId: order.body.id as string,
      orderId: order.body.providerOrderId as string,
      sessionId: acc.body.sessionId as string,
    };
  }

  const poolRow = async (id: string) =>
    (await t.db.select().from(requestPools).where(eq(requestPools.id, id)))[0]!;
  const payStatus = async (id: string) =>
    (await t.db.select().from(payments).where(eq(payments.id, id)))[0]!.status;

  it('tutors bid with seat limits; members see the offers; POOL_MAX_SEATS is enforced', async () => {
    const { poolId, members } = await formedPool(2);
    const tutor = await approvedTutor(t, ['technical-analysis'], 'Group Tutor');
    const open = await t.http.get('/tutor/pools').set(bearer(tutor)).expect(200);
    expect(open.body).toEqual([expect.objectContaining({ id: poolId, members: 2 })]);
    expect(JSON.stringify(open.body)).not.toContain(members[0]!.userId);

    const tooMany = await t.http
      .post(`/tutor/pools/${poolId}/bids`)
      .set(bearer(tutor))
      .send({ ...bidBody(t), minSeats: 2, maxSeats: t.config.env.POOL_MAX_SEATS + 1 })
      .expect(400);
    expect(tooMany.body.error.code).toBe('INVALID_SEATS');
    await t.http
      .post(`/tutor/pools/${poolId}/bids`)
      .set(bearer(tutor))
      .send({ ...bidBody(t, { seatPricePaise: 19900 }), minSeats: 2, maxSeats: 4 })
      .expect(201);
    expect((await poolRow(poolId)).status).toBe('BIDDING');

    const offers = await t.http
      .get(`/student/pools/${poolId}/bids`)
      .set(bearer(members[0]!))
      .expect(200);
    expect(offers.body.bids[0]).toMatchObject({ seatPricePaise: 19900, minSeats: 2, maxSeats: 4 });
    const outsider = await registerMember(t, 'student');
    await t.http.get(`/student/pools/${poolId}/bids`).set(bearer(outsider)).expect(403);
  });

  it('enough payments create one session; each member pays separately', async () => {
    const { poolId, members, requestIds } = await formedPool(3);
    const { bidId } = await groupBid(poolId, { minSeats: 2, maxSeats: 3 });
    const a = await acceptAndPay(members[0]!, poolId, bidId);
    const b = await acceptAndPay(members[1]!, poolId, bidId);
    await processWebhooks(t);
    expect(a.sessionId).toBe(b.sessionId);
    expect((await t.db.select().from(sessions)).map((s) => s.status)).toEqual(['SCHEDULED']);
    expect([await payStatus(a.paymentId), await payStatus(b.paymentId)]).toEqual(['HELD', 'HELD']);
    expect((await poolRow(poolId)).status).toBe('AWAITING_PAYMENTS');

    // Member 3 accepted but never paid; the deadline passes.
    await t.http
      .post(`/student/pools/${poolId}/bids/${bidId}/accept`)
      .set(bearer(members[2]!))
      .expect(200);
    t.clock.advanceMinutes(t.config.env.POOL_PAYMENT_WINDOW_MINUTES + 1);
    expect(await t.app.get(GroupBookingService).sweep()).toMatchObject({
      confirmed: 1,
      expired: 0,
    });
    expect((await poolRow(poolId)).status).toBe('CONFIRMED');
    const reqs = await t.db
      .select()
      .from(learningRequests)
      .where(inArray(learningRequests.id, requestIds));
    expect(Object.fromEntries(reqs.map((r) => [r.id, r.status]))).toEqual({
      [requestIds[0]!]: 'BOOKED',
      [requestIds[1]!]: 'BOOKED',
      [requestIds[2]!]: 'OPEN',
    });
  });

  it('too few payments refund everyone, expire the pool and reopen each request', async () => {
    const { poolId, members, requestIds } = await formedPool(3);
    const { bidId } = await groupBid(poolId, { minSeats: 3, maxSeats: 3 });
    const a = await acceptAndPay(members[0]!, poolId, bidId);
    await acceptAndPay(members[1]!, poolId, bidId, false);
    await processWebhooks(t);
    expect(await payStatus(a.paymentId)).toBe('HELD');

    t.clock.advanceMinutes(t.config.env.POOL_PAYMENT_WINDOW_MINUTES + 1);
    const groups = t.app.get(GroupBookingService);
    expect(await groups.sweep()).toEqual({ confirmed: 0, expired: 1, refunds: 1 });
    expect(await groups.sweep()).toEqual({ confirmed: 0, expired: 0, refunds: 0 });
    expect(await payStatus(a.paymentId)).toBe('REFUNDED');
    expect((await poolRow(poolId)).status).toBe('EXPIRED');
    expect((await t.db.select().from(sessions))[0]!.status).toBe('CANCELLED');
    const reqs = await t.db
      .select()
      .from(learningRequests)
      .where(inArray(learningRequests.id, requestIds));
    expect(reqs.every((r) => r.status === 'OPEN')).toBe(true);
  });

  it("one member's dispute freezes only their money", async () => {
    const { poolId, members } = await formedPool(2);
    const { tutor, bidId } = await groupBid(poolId, { minSeats: 2, maxSeats: 2 });
    const a = await acceptAndPay(members[0]!, poolId, bidId);
    const b = await acceptAndPay(members[1]!, poolId, bidId);
    await processWebhooks(t);

    const session = (await t.db.select().from(sessions).where(eq(sessions.id, a.sessionId)))[0]!;
    t.clock.set(session.startsAt);
    await sendLivekit(t, joined(session.id, `tutor:${tutor.userId}`));
    for (const m of members) await sendLivekit(t, joined(session.id, `student:${m.userId}`));
    t.clock.advanceMinutes(60);
    await sendLivekit(t, finished(session.id));

    const first = await login(t, 'student', members[0]!);
    await t.http
      .post(`/student/sessions/${session.id}/disputes`)
      .set(bearer(first))
      .send({ reason: 'POOR_QUALITY' })
      .expect(201);
    expect([await payStatus(a.paymentId), await payStatus(b.paymentId)]).toEqual([
      'FROZEN',
      'HELD',
    ]);

    t.clock.advanceHours(t.config.env.DISPUTE_WINDOW_HOURS + 1);
    expect(await t.app.get(SettlementService).releaseDue()).toBe(1);
    expect([await payStatus(a.paymentId), await payStatus(b.paymentId)]).toEqual([
      'FROZEN',
      'RELEASED',
    ]);
  });

  it('20 concurrent payments cannot exceed maximum seats', async () => {
    const { poolId, members } = await formedPool(5);
    const { bidId } = await groupBid(poolId, { minSeats: 2, maxSeats: 3 });
    const seats: Array<Awaited<ReturnType<typeof acceptAndPay>>> = [];
    for (const m of members) seats.push(await acceptAndPay(m, poolId, bidId, false));

    const fake = t.app.get(FakeUpiGateway);
    const paid = await Promise.all(seats.map((s) => fake.simulatePayment(s.orderId)));
    const svc = t.app.get(PaymentsService);
    // 5 learners x 4 deliveries of their capture, all at once.
    await Promise.all(
      paid.flatMap((p, i) =>
        Array.from({ length: 4 }, () =>
          svc.applyCaptured(fake, {
            providerPaymentId: p.paymentId,
            providerOrderId: seats[i]!.orderId,
            amountPaise: 19900,
            currency: 'INR',
            status: 'captured',
          }),
        ),
      ),
    );

    const parts = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, seats[0]!.sessionId));
    expect(parts.filter((p) => p.status === 'CONFIRMED')).toHaveLength(3);
    const rows = await t.db
      .select()
      .from(payments)
      .where(
        inArray(
          payments.id,
          seats.map((s) => s.paymentId),
        ),
      );
    expect(rows.filter((r) => r.status === 'HELD')).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'REFUNDED')).toHaveLength(2);
    expect(
      rows.every((r) => r.refundReason === null || r.refundReason === 'BOOKING_NOT_PAYABLE'),
    ).toBe(true);
  });
});
