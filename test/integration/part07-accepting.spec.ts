import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { bids } from '../../src/modules/bidding/bidding.schema';
import { learningRequests } from '../../src/modules/requests/requests.schema';
import { BOOKING_QUEUE, BookingService } from '../../src/modules/sessions/booking.service';
import { sessionParticipants, sessions } from '../../src/modules/sessions/sessions.schema';
import { acceptedBooking } from '../fixtures/booking';
import { approvedTutor, bidBody, openRequest } from '../fixtures/marketplace';
import {
  bearer,
  createStaff,
  createTestApp,
  registerMember,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 7: accepting bids', () => {
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

  const statuses = async (requestId: string) => {
    const [req] = await t.db
      .select()
      .from(learningRequests)
      .where(eq(learningRequests.id, requestId));
    const bidRows = await t.db.select().from(bids).where(eq(bids.requestId, requestId));
    const parts = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.requestId, requestId));
    return {
      request: req!.status,
      bids: bidRows.map((b) => [b.id, b.status]),
      participants: parts,
    };
  };

  it('reserves the request: bid ACCEPTED, others HELD, session and participant PENDING_PAYMENT', async () => {
    const b = await acceptedBooking(t, 3);
    const s = await statuses(b.requestId);
    expect(s.request).toBe('RESERVED');
    expect(Object.fromEntries(s.bids)).toEqual({
      [b.bidIds[0]!]: 'ACCEPTED',
      [b.bidIds[1]!]: 'HELD',
      [b.bidIds[2]!]: 'HELD',
    });
    expect(s.participants).toHaveLength(1);
    expect(s.participants[0]).toMatchObject({ status: 'PENDING_PAYMENT', amountPaise: 49900 });
    const due = s.participants[0]!.paymentDueAt.getTime() - t.clock.nowMs();
    expect(due).toBe(t.config.env.PAYMENT_WINDOW_MINUTES * 60_000);

    const mine = await t.http.get('/student/sessions').set(bearer(b.student)).expect(200);
    expect(mine.body[0]).toMatchObject({
      sessionStatus: 'PENDING_PAYMENT',
      participantStatus: 'PENDING_PAYMENT',
    });
    const tutorView = await t.http.get('/tutor/sessions').set(bearer(b.tutors[0]!)).expect(200);
    expect(tutorView.body).toHaveLength(1);

    // The delayed expiry job was scheduled after commit.
    const queue = t.app.get<Queue>(getQueueToken(BOOKING_QUEUE));
    expect(await queue.getJob(`expiry-${b.participantId}`)).toBeTruthy();
  });

  it('returns 409 for invalid accepts and 403 for other students', async () => {
    const b = await acceptedBooking(t, 2);
    const again = await t.http
      .post(`/student/bids/${b.bidIds[1]}/accept`)
      .set(bearer(b.student))
      .expect(409);
    expect(again.body.error.code).toBe('REQUEST_NOT_OPEN');

    const other = await registerMember(t, 'student');
    const admin = await createStaff(t);
    const requestId = await openRequest(t, b.student);
    const tutor = await approvedTutor(t, ['technical-analysis'], 'X', admin);
    const bid = await t.http
      .post(`/tutor/requests/${requestId}/bids`)
      .set(bearer(tutor))
      .send(bidBody(t))
      .expect(201);
    expect(
      (await t.http.post(`/student/bids/${bid.body.id}/accept`).set(bearer(other)).expect(403)).body
        .error.code,
    ).toBe('NOT_OWNER');
    await t.http.post(`/tutor/bids/${bid.body.id}/withdraw`).set(bearer(tutor)).expect(200);
    expect(
      (await t.http.post(`/student/bids/${bid.body.id}/accept`).set(bearer(b.student)).expect(409))
        .body.error.code,
    ).toBe('BID_ALREADY_ACCEPTED');
  });

  it('50 concurrent accepts create exactly one reservation', async () => {
    const admin = await createStaff(t);
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const bidIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tutor = await approvedTutor(t, ['technical-analysis'], `T${i}`, admin);
      bidIds.push(
        (
          await t.http
            .post(`/tutor/requests/${requestId}/bids`)
            .set(bearer(tutor))
            .send(bidBody(t))
            .expect(201)
        ).body.id,
      );
    }

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        t.http.post(`/student/bids/${bidIds[i % 5]}/accept`).set(bearer(student)),
      ),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(49);

    const s = await statuses(requestId);
    expect(s.request).toBe('RESERVED');
    expect(s.bids.filter(([, st]) => st === 'ACCEPTED')).toHaveLength(1);
    expect(s.bids.filter(([, st]) => st === 'HELD')).toHaveLength(4);
    expect(s.participants).toHaveLength(1);
    expect(await t.db.select().from(sessions)).toHaveLength(1);
  });

  it('expiry reopens the request, and running it twice is safe', async () => {
    const b = await acceptedBooking(t, 2);
    const booking = t.app.get(BookingService);

    expect(await booking.expireParticipant(b.participantId)).toBe(false); // not due yet
    t.clock.advanceMinutes(t.config.env.PAYMENT_WINDOW_MINUTES + 1);
    const [first, second] = await Promise.all([
      booking.expireParticipant(b.participantId),
      booking.expireParticipant(b.participantId),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    expect(await booking.expireParticipant(b.participantId)).toBe(false);
    expect(await booking.sweepExpiredPayments()).toBe(0);

    const s = await statuses(b.requestId);
    expect(s.request).toBe('OPEN');
    expect(Object.fromEntries(s.bids)).toEqual({
      [b.bidIds[0]!]: 'EXPIRED',
      [b.bidIds[1]!]: 'SUBMITTED',
    });
    expect(s.participants[0]!.status).toBe('CANCELLED');
    const [session] = await t.db.select().from(sessions).where(eq(sessions.id, b.sessionId));
    expect(session!.status).toBe('CANCELLED');

    // The learner can accept the other bid now.
    const fresh = await t.http
      .post('/student/auth/login')
      .send({ email: b.student.email, password: b.student.password });
    await t.http.post(`/student/bids/${b.bidIds[1]}/accept`).set(bearer(fresh.body)).expect(201);
  });

  it('the sweep catches expiries the delayed job missed', async () => {
    await acceptedBooking(t, 1);
    t.clock.advanceMinutes(t.config.env.PAYMENT_WINDOW_MINUTES + 1);
    expect(await t.app.get(BookingService).sweepExpiredPayments()).toBe(1);
  });
});
