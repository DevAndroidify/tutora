import { approvedTutor, bidBody, openRequest } from '../fixtures/marketplace';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  registerMember,
  resetState,
  seedCatalog,
  type Session,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 5: sealed bids', () => {
  let t: TestApp;
  let admin: Session;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
    admin = await createStaff(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const placeBid = (tutor: Session, requestId: string, body: object) =>
    t.http.post(`/tutor/requests/${requestId}/bids`).set(bearer(tutor)).send(body);

  it('allows one active bid per tutor and request', async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const tutor = await approvedTutor(t, ['technical-analysis'], 'T', admin);

    const first = await placeBid(tutor, requestId, bidBody(t)).expect(201);
    expect(first.body).toMatchObject({
      status: 'SUBMITTED',
      seatPricePaise: 49900,
      currency: 'INR',
    });
    const dup = await placeBid(tutor, requestId, bidBody(t, { seatPricePaise: 39900 })).expect(409);
    expect(dup.body.error.code).toBe('BID_EXISTS');

    // After withdrawing, a new bid is allowed.
    await t.http.post(`/tutor/bids/${first.body.id}/withdraw`).set(bearer(tutor)).expect(200);
    await placeBid(tutor, requestId, bidBody(t, { seatPricePaise: 39900 })).expect(201);
  });

  it("tutors can't read rival prices: they see the count and their own bid only", async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const a = await approvedTutor(t, ['technical-analysis'], 'Tutor A', admin);
    const b = await approvedTutor(t, ['technical-analysis'], 'Tutor B', admin);
    await placeBid(a, requestId, bidBody(t, { seatPricePaise: 77700 })).expect(201);
    await placeBid(b, requestId, bidBody(t, { seatPricePaise: 33300 })).expect(201);

    const view = await t.http.get(`/tutor/requests/${requestId}`).set(bearer(b)).expect(200);
    expect(view.body).toMatchObject({ bidCount: 2, myBid: { seatPricePaise: 33300 } });
    expect(JSON.stringify(view.body)).not.toContain('77700');

    const list = await t.http.get('/tutor/requests').set(bearer(b)).expect(200);
    expect(list.body.items[0].bidCount).toBe(2);
    expect(JSON.stringify(list.body)).not.toContain('77700');

    // The learner-only bid list is in another app; a tutor token can't call it.
    await t.http.get(`/student/requests/${requestId}/bids`).set(bearer(b)).expect(401);
    const bAsStudent = await login(t, 'student', b);
    await t.http.get(`/student/requests/${requestId}/bids`).set(bearer(bAsStudent)).expect(403);
  });

  it('unverified, unapproved, restricted or self-bidding tutors are refused', async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);

    const unverified = await registerMember(t, 'tutor');
    expect((await placeBid(unverified, requestId, bidBody(t)).expect(403)).body.error.code).toBe(
      'TUTOR_NOT_VERIFIED',
    );

    const wrongSkill = await approvedTutor(t, ['video-editing'], 'Editor', admin);
    expect((await placeBid(wrongSkill, requestId, bidBody(t)).expect(403)).body.error.code).toBe(
      'SKILL_NOT_APPROVED',
    );

    // A verified tutor who is also the learner can't bid on their own request.
    const dual = await approvedTutor(t, ['technical-analysis'], 'Dual', admin);
    const dualStudent = await login(t, 'student', dual);
    const ownRequest = await openRequest(t, dualStudent);
    expect((await placeBid(dual, ownRequest, bidBody(t)).expect(403)).body.error.code).toBe(
      'OWN_REQUEST',
    );

    const restricted = await approvedTutor(t, ['technical-analysis'], 'Restricted', admin);
    const c = await t.http
      .post('/admin/moderation/cases')
      .set(bearer(admin))
      .send({ subjectUserId: restricted.userId, note: 'Lowball spam bids.' })
      .expect(201);
    await t.http
      .post(`/admin/moderation/cases/${c.body.case.id}/actions`)
      .set(bearer(admin))
      .send({ action: 'RESTRICT_BIDDING', reason: 'Spam bids.', durationDays: 2 })
      .expect(200);
    expect((await placeBid(restricted, requestId, bidBody(t)).expect(403)).body.error.code).toBe(
      'RESTRICTED_FROM_BIDDING',
    );
  });

  it('validates price, start time and approach; screens the approach text', async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const tutor = await approvedTutor(t, ['technical-analysis'], 'T', admin);

    await placeBid(tutor, requestId, bidBody(t, { seatPricePaise: 0 })).expect(400);
    await placeBid(tutor, requestId, bidBody(t, { seatPricePaise: 12.5 })).expect(400);
    const soon = await placeBid(
      tutor,
      requestId,
      bidBody(t, { proposedStartAt: new Date(t.clock.nowMs() + 60_000).toISOString() }),
    ).expect(400);
    expect(soon.body.error.code).toBe('INVALID_START_TIME');
    const noApproach = await placeBid(
      tutor,
      requestId,
      bidBody(t, { approachText: undefined }),
    ).expect(400);
    expect(noApproach.body.error.code).toBe('APPROACH_REQUIRED');

    const masked = await placeBid(
      tutor,
      requestId,
      bidBody(t, { approachText: 'Great plan. Message me at tutor@gmail.com instead.' }),
    ).expect(201);
    expect(masked.body.approachText).toBe('Great plan. Message me at [hidden] instead.');
  });

  it('students see every bid and can sort by score, price and time, with an explanation', async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const hour = 3_600_000;
    const tutors = await Promise.all(
      ['Cheap Late', 'Mid Mid', 'Pricey Early'].map((n) =>
        approvedTutor(t, ['technical-analysis'], n, admin),
      ),
    );
    const plans = [
      {
        seatPricePaise: 30000,
        proposedStartAt: new Date(t.clock.nowMs() + 30 * hour).toISOString(),
      },
      {
        seatPricePaise: 50000,
        proposedStartAt: new Date(t.clock.nowMs() + 10 * hour).toISOString(),
      },
      {
        seatPricePaise: 90000,
        proposedStartAt: new Date(t.clock.nowMs() + 2 * hour).toISOString(),
      },
    ];
    for (const [i, tutor] of tutors.entries())
      await placeBid(tutor, requestId, bidBody(t, plans[i])).expect(201);

    const get = (sort: string) =>
      t.http
        .get(`/student/requests/${requestId}/bids?sort=${sort}`)
        .set(bearer(student))
        .expect(200);
    const names = (res: { body: Array<{ tutor: { fullName: string } }> }) =>
      res.body.map((b) => b.tutor.fullName);

    expect(names(await get('price'))).toEqual(['Cheap Late', 'Mid Mid', 'Pricey Early']);
    expect(names(await get('time'))).toEqual(['Pricey Early', 'Mid Mid', 'Cheap Late']);

    const byScore = await get('score');
    // M and R are neutral (0.5). Mid: S=20/28, P=40/60 -> 0.579; Early: S=1, P=0 -> 0.55; Late: 0.45.
    expect(names(byScore)).toEqual(['Mid Mid', 'Pricey Early', 'Cheap Late']);
    const top = byScore.body[0];
    expect(top.score.total).toBeCloseTo(0.2 + 0.1 + 0.25 * (20 / 28) + 0.15 * (40 / 60), 2);
    expect(top.score.components.map((c: { key: string }) => c.key)).toEqual(['M', 'S', 'R', 'P']);
    expect(top.score.components[0]).toMatchObject({ placeholder: true, value: 0.5 });
    expect(top.tutor).toMatchObject({ badge: 'VERIFIED' });
  });

  it('editing and withdrawing follow the bid state machine', async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const tutor = await approvedTutor(t, ['technical-analysis'], 'T', admin);
    const bid = (await placeBid(tutor, requestId, bidBody(t)).expect(201)).body;

    const edited = await t.http
      .patch(`/tutor/bids/${bid.id}`)
      .set(bearer(tutor))
      .send({ seatPricePaise: 45000 })
      .expect(200);
    expect(edited.body.seatPricePaise).toBe(45000);
    await t.http.post(`/tutor/bids/${bid.id}/withdraw`).set(bearer(tutor)).expect(200);
    const again = await t.http
      .post(`/tutor/bids/${bid.id}/withdraw`)
      .set(bearer(tutor))
      .expect(409);
    expect(again.body.error).toMatchObject({
      code: 'INVALID_BID_STATE',
      details: { status: 'WITHDRAWN' },
    });
    await t.http
      .patch(`/tutor/bids/${bid.id}`)
      .set(bearer(tutor))
      .send({ seatPricePaise: 1000 })
      .expect(409);

    const other = await approvedTutor(t, ['technical-analysis'], 'Other', admin);
    await t.http.post(`/tutor/bids/${bid.id}/withdraw`).set(bearer(other)).expect(403);
  });

  it('cancelling a request expires its bids and stops new ones', async () => {
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const tutor = await approvedTutor(t, ['technical-analysis'], 'T', admin);
    await placeBid(tutor, requestId, bidBody(t)).expect(201);

    await t.http.post(`/student/requests/${requestId}/cancel`).set(bearer(student)).expect(200);
    const mine = await t.http.get('/tutor/bids').set(bearer(tutor)).expect(200);
    expect(mine.body[0].status).toBe('EXPIRED');
    const late = await approvedTutor(t, ['technical-analysis'], 'Late', admin);
    expect((await placeBid(late, requestId, bidBody(t)).expect(409)).body.error.code).toBe(
      'REQUEST_NOT_OPEN',
    );
  });
});
