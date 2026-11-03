import { eq, sql } from 'drizzle-orm';
import { auditLog } from '../../src/platform/audit/audit.schema';
import { LedgerService, tutorPayable } from '../../src/modules/ledger/ledger.service';
import {
  RazorpayRouteHoldProvider,
  type RazorpayRouteClient,
} from '../../src/modules/payments/hold-provider';
import { payments, refunds } from '../../src/modules/payments/payments.schema';
import { learningRequests } from '../../src/modules/requests/requests.schema';
import { sessions } from '../../src/modules/sessions/sessions.schema';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import {
  finished,
  goToStart,
  joined,
  paidSession,
  relogin,
  sendLivekit,
  type PaidSession,
} from '../fixtures/live';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 12: hold release, no-shows and disputes', () => {
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

  const payment = async (id: string) =>
    (await t.db.select().from(payments).where(eq(payments.id, id)))[0]!;
  const balance = (code: string) => t.app.get(LedgerService).balanceOf(code);

  /** Runs a session to completion through LiveKit webhooks. */
  async function completed(): Promise<PaidSession> {
    const s = await paidSession(t);
    await goToStart(t, s);
    await sendLivekit(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
    await sendLivekit(t, joined(s.sessionId, `student:${s.student.userId}`));
    t.clock.advanceMinutes(60);
    await sendLivekit(t, finished(s.sessionId));
    return relogin(t, s);
  }

  it('releases the right amount and fee 24 hours after the session, once', async () => {
    const s = await completed();
    const settlement = t.app.get(SettlementService);

    t.clock.advanceHours(23);
    expect(await settlement.releaseDue()).toBe(0);
    expect((await payment(s.paymentId)).status).toBe('HELD');

    t.clock.advanceHours(2);
    const [a, b] = await Promise.all([settlement.releaseDue(), settlement.releaseDue()]);
    expect(a + b).toBe(1);
    expect(await settlement.releaseDue()).toBe(0);

    expect((await payment(s.paymentId)).status).toBe('RELEASED');
    // ₹499 with a 10% fee: tutor ₹449.10, platform ₹49.90.
    expect(await balance(tutorPayable(s.tutor.userId).code)).toBe(44910);
    expect(await balance('platform_revenue')).toBe(4990);
    expect(await balance('held_funds')).toBe(0);

    const tutor = await login(t, 'tutor', s.tutor);
    const earnings = await t.http.get('/tutor/earnings').set(bearer(tutor)).expect(200);
    expect(earnings.body).toMatchObject({
      availablePaise: 44910,
      pendingGrossPaise: 0,
      releasedGrossPaise: 49900,
    });
  });

  it('a tutor no-show refunds in full and reopens the request; running twice is safe', async () => {
    const s = await paidSession(t);
    const settlement = t.app.get(SettlementService);
    await goToStart(t, s, t.config.env.NO_SHOW_GRACE_MINUTES - 1);
    expect((await settlement.processNoShows()).sessions).toBe(0);

    await goToStart(t, s, t.config.env.NO_SHOW_GRACE_MINUTES + 1);
    expect(await settlement.processNoShows()).toEqual({ sessions: 1, refunds: 1 });
    expect(await settlement.processNoShows()).toEqual({ sessions: 0, refunds: 0 });

    expect((await payment(s.paymentId)).status).toBe('REFUNDED');
    expect(
      (await t.db.select().from(sessions).where(eq(sessions.id, s.sessionId)))[0]!.status,
    ).toBe('NO_SHOW');
    expect(
      (await t.db.select().from(learningRequests).where(eq(learningRequests.id, s.requestId)))[0]!
        .status,
    ).toBe('OPEN');
    expect(await t.db.select().from(refunds).where(eq(refunds.paymentId, s.paymentId))).toEqual([
      expect.objectContaining({ reason: 'TUTOR_NO_SHOW', amountPaise: 49900 }),
    ]);
    expect(await balance('held_funds')).toBe(0);
    expect(await balance('gateway_clearing')).toBe(0);
  });

  it('a dispute freezes the money and prevents release until an admin decides', async () => {
    const s = await completed();
    const dispute = await t.http
      .post(`/student/sessions/${s.sessionId}/disputes`)
      .set(bearer(s.student))
      .send({ reason: 'POOR_QUALITY', details: 'The tutor read from slides for the whole hour.' })
      .expect(201);
    expect((await payment(s.paymentId)).status).toBe('FROZEN');
    await t.http
      .post(`/student/sessions/${s.sessionId}/disputes`)
      .set(bearer(s.student))
      .send({ reason: 'OTHER' })
      .expect(409);

    t.clock.advanceHours(48);
    expect(await t.app.get(SettlementService).releaseDue()).toBe(0);
    expect((await payment(s.paymentId)).status).toBe('FROZEN');

    const admin = await createStaff(t);
    const resolved = await t.http
      .post(`/admin/disputes/${dispute.body.id}/resolve`)
      .set(bearer(admin))
      .send({ outcome: 'REFUND', note: 'Attendance shows low engagement; refunding.' })
      .expect(200);
    expect(resolved.body.status).toBe('RESOLVED_REFUND');
    expect((await payment(s.paymentId)).status).toBe('REFUNDED');
    await t.http
      .post(`/admin/disputes/${dispute.body.id}/resolve`)
      .set(bearer(admin))
      .send({ outcome: 'RELEASE', note: 'Second decision' })
      .expect(409);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, dispute.body.id));
    expect(audits.map((x) => x.action)).toEqual(['dispute.resolved.refund']);
  });

  it('disputes are refused after the window closes', async () => {
    const s = await completed();
    t.clock.advanceHours(t.config.env.DISPUTE_WINDOW_HOURS + 1);
    const fresh = await login(t, 'student', s.student);
    const res = await t.http
      .post(`/student/sessions/${s.sessionId}/disputes`)
      .set(bearer(fresh))
      .send({ reason: 'OTHER' })
      .expect(409);
    expect(res.body.error.code).toBe('DISPUTE_WINDOW_CLOSED');
  });

  it('admins can release or refund, record payouts, and reconcile', async () => {
    const a = await completed();
    const b = await completed();
    const admin = await createStaff(t); // after the clock moved, so the token is fresh
    await t.http
      .post(`/admin/payments/${a.paymentId}/release`)
      .set(bearer(admin))
      .send({ note: 'Learner confirmed by email.' })
      .expect(200);
    await t.http
      .post(`/admin/payments/${a.paymentId}/refund`)
      .set(bearer(admin))
      .send({ note: 'Too late now' })
      .expect(409);

    await t.http
      .post(`/admin/payments/${b.paymentId}/refund`)
      .set(bearer(admin))
      .send({ note: 'Goodwill refund.' })
      .expect(200);
    expect((await payment(b.paymentId)).status).toBe('REFUNDED');

    const tooMuch = await t.http
      .post('/admin/payouts')
      .set(bearer(admin))
      .send({ tutorUserId: a.tutor.userId, amountPaise: 50000, reference: 'UTR000000001' })
      .expect(409);
    expect(tooMuch.body.error.code).toBe('PAYOUT_EXCEEDS_BALANCE');
    await t.http
      .post('/admin/payouts')
      .set(bearer(admin))
      .send({ tutorUserId: a.tutor.userId, amountPaise: 44910, reference: 'UTR000000002' })
      .expect(201);
    expect(await balance(tutorPayable(a.tutor.userId).code)).toBe(0);

    const rec = await t.http.get('/admin/reconciliation').set(bearer(admin)).expect(200);
    expect(rec.body).toMatchObject({ ok: true, mismatches: [], heldFundsPaise: 0 });
    expect(rec.body.providerChecked).toBe(2);
  });

  it('reconciliation reports a mismatch when the provider disagrees', async () => {
    const s = await paidSession(t);
    // Simulate the provider having refunded outside our system.
    await t.db.execute(
      sql`update fake_upi_orders set payment_status = 'refunded' where payment_id = (select provider_payment_id from payments where id = ${s.paymentId})`,
    );
    const rec = await t.app.get(SettlementService).reconciliation();
    expect(rec.ok).toBe(false);
    expect(rec.mismatches).toEqual([
      expect.objectContaining({ paymentId: s.paymentId, check: 'provider' }),
    ]);
  });
});

describe('Part 12: Razorpay Route hold adapter (mocked, no Route account needed)', () => {
  function mockClient() {
    const calls: string[] = [];
    const client: RazorpayRouteClient = {
      payments: {
        transfer: async (paymentId, params) => {
          calls.push(
            `transfer ${paymentId} ${params.transfers[0]!.account} ${params.transfers[0]!.amount} hold=${params.transfers[0]!.on_hold}`,
          );
          return { items: [{ id: 'trf_TEST0001' }] };
        },
      },
      transfers: {
        edit: async (id, params) => {
          calls.push(`edit ${id} hold=${params.on_hold}`);
          return { id, on_hold: params.on_hold };
        },
        reverse: async (id, params) => {
          calls.push(`reverse ${id} ${params.amount}`);
          return { id: 'rvrsl_TEST0001' };
        },
      },
    };
    return { client, calls };
  }
  const target = {
    paymentId: 'p1',
    providerPaymentId: 'pay_TEST1',
    tutorLinkedAccountId: 'acc_TESTLINKED',
    tutorSharePaise: 44910,
    routeTransferId: null,
  };

  it('holds the tutor share on transfer, releases by clearing on_hold, reverses before refund', async () => {
    const { client, calls } = mockClient();
    const route = new RazorpayRouteHoldProvider(client);
    const { routeTransferId } = await route.hold(target);
    expect(routeTransferId).toBe('trf_TEST0001');
    await route.release({ ...target, routeTransferId });
    await route.reverse({ ...target, routeTransferId });
    expect(calls).toEqual([
      'transfer pay_TEST1 acc_TESTLINKED 44910 hold=true',
      'edit trf_TEST0001 hold=false',
      'reverse trf_TEST0001 44910',
    ]);
    // Holding twice does not create a second transfer.
    expect((await route.hold({ ...target, routeTransferId })).routeTransferId).toBe('trf_TEST0001');
    expect(calls).toHaveLength(3);
  });

  it('refuses to hold without a linked account', async () => {
    const route = new RazorpayRouteHoldProvider(mockClient().client);
    await expect(route.hold({ ...target, tutorLinkedAccountId: null })).rejects.toThrow(
      /linked account/,
    );
  });
});
