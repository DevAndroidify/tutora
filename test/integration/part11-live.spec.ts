import { eq } from 'drizzle-orm';
import { computeAttendance } from '../../src/modules/live/live-sessions.service';
import { learningRequests } from '../../src/modules/requests/requests.schema';
import { sessionParticipants, sessions } from '../../src/modules/sessions/sessions.schema';
import { quizAttempts } from '../../src/modules/mastery/mastery.schema';
import { acceptedBooking } from '../fixtures/booking';
import {
  finished,
  goToStart,
  joined,
  left,
  livekitWebhook,
  paidSession,
  relogin,
  sendLivekit,
} from '../fixtures/live';
import { approvedTutor } from '../fixtures/marketplace';
import {
  bearer,
  createTestApp,
  login,
  registerMember,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

const decode = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as {
    sub: string;
    exp: number;
    nbf: number;
    video: Record<string, unknown>;
  };

describe('Part 11: sessions and LiveKit', () => {
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

  const sessionRow = async (id: string) =>
    (await t.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;

  it('the assigned tutor and paid learner get short-lived tokens fixed to one room and identity', async () => {
    let s = await paidSession(t);
    await goToStart(t, s, -10);
    s = await relogin(t, s);

    const st = await t.http
      .post(`/student/sessions/${s.sessionId}/join-token`)
      .set(bearer(s.student))
      .expect(200);
    expect(st.body).toMatchObject({
      room: `session-${s.sessionId}`,
      identity: `student:${s.student.userId}`,
      url: 'ws://localhost:7880',
    });
    const claims = decode(st.body.token);
    expect(claims).toMatchObject({
      sub: `student:${s.student.userId}`,
      video: { room: `session-${s.sessionId}`, roomJoin: true },
    });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(t.config.env.SESSION_TOKEN_TTL_SECONDS);

    const tt = await t.http
      .post(`/tutor/sessions/${s.sessionId}/join-token`)
      .set(bearer(s.tutor))
      .expect(200);
    expect(decode(tt.body.token).sub).toBe(`tutor:${s.tutor.userId}`);
  });

  it('an unpaid learner gets no token, and nobody else does either', async () => {
    const b = await acceptedBooking(t, 1); // accepted but not paid
    const unpaid = await t.http
      .post(`/student/sessions/${b.sessionId}/join-token`)
      .set(bearer(b.student))
      .expect(403);
    expect(unpaid.body.error.code).toBe('NOT_PAID');

    const s = await paidSession(t);
    const stranger = await registerMember(t, 'student');
    expect(
      (
        await t.http
          .post(`/student/sessions/${s.sessionId}/join-token`)
          .set(bearer(stranger))
          .expect(403)
      ).body.error.code,
    ).toBe('NOT_IN_SESSION');
    const otherTutor = await approvedTutor(t, ['technical-analysis'], 'Other');
    await t.http
      .post(`/tutor/sessions/${s.sessionId}/join-token`)
      .set(bearer(otherTutor))
      .expect(403);
    // The learner can't use the tutor route with a tutor-app login either.
    const studentAsTutor = await login(t, 'tutor', s.student);
    await t.http
      .post(`/tutor/sessions/${s.sessionId}/join-token`)
      .set(bearer(studentAsTutor))
      .expect(403);
  });

  it('tokens are only issued around the session time', async () => {
    const s = await paidSession(t);
    const early = await t.http
      .post(`/student/sessions/${s.sessionId}/join-token`)
      .set(bearer(s.student))
      .expect(409);
    expect(early.body.error.code).toBe('OUTSIDE_SESSION_WINDOW');
  });

  it('webhooks drive LIVE and ENDED; duplicates and forged signatures are safe', async () => {
    const s = await paidSession(t);
    await goToStart(t, s);

    const forged = await livekitWebhook(
      t,
      joined(s.sessionId, `tutor:${s.tutor.userId}`),
      'wrong-secret',
    );
    await t.http
      .post('/webhooks/livekit')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', forged.auth)
      .send(forged.body)
      .expect(401);
    expect((await sessionRow(s.sessionId)).status).toBe('SCHEDULED');

    const hook = await livekitWebhook(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
    const send = () =>
      t.http
        .post('/webhooks/livekit')
        .set('Content-Type', 'application/webhook+json')
        .set('Authorization', hook.auth)
        .send(hook.body)
        .expect(200);
    expect((await send()).body).toEqual({ received: true, duplicate: false });
    expect((await send()).body).toEqual({ received: true, duplicate: true });
    const live = await sessionRow(s.sessionId);
    expect(live.status).toBe('LIVE');
    expect(live.tutorJoinedAt).not.toBeNull();

    await sendLivekit(t, joined(s.sessionId, `student:${s.student.userId}`));
    const [p] = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, s.participantId));
    expect(p!.status).toBe('JOINED');

    t.clock.advanceMinutes(60);
    await sendLivekit(t, finished(s.sessionId));
    await sendLivekit(t, finished(s.sessionId)); // a second, different room_finished is harmless
    expect((await sessionRow(s.sessionId)).status).toBe('ENDED');
    const [after] = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, s.participantId));
    expect(after!.status).toBe('ATTENDED');
    const [req] = await t.db
      .select()
      .from(learningRequests)
      .where(eq(learningRequests.id, s.requestId));
    expect(req!.status).toBe('COMPLETED');
    // Exit quiz + 7-day recheck were created for the attendee (Part 13).
    expect(
      await t.db.select().from(quizAttempts).where(eq(quizAttempts.participantId, s.participantId)),
    ).toHaveLength(2);
  });

  it('a learner who never joins is marked ABSENT', async () => {
    const s = await paidSession(t);
    await goToStart(t, s);
    await sendLivekit(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
    await sendLivekit(t, finished(s.sessionId));
    const [p] = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, s.participantId));
    expect(p!.status).toBe('ABSENT');
  });

  it('attendance adds up joined-to-left time per person, merging reconnects', async () => {
    const t0 = new Date('2026-11-05T10:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const totals = computeAttendance(
      [
        { type: 'participant_joined', identity: 'tutor:a', at: at(0) },
        { type: 'participant_joined', identity: 'student:b', at: at(5) },
        { type: 'participant_left', identity: 'student:b', at: at(15) },
        { type: 'participant_joined', identity: 'student:b', at: at(20) },
        { type: 'participant_joined', identity: 'student:b', at: at(21) }, // second device
        { type: 'participant_left', identity: 'student:b', at: at(30) },
        { type: 'participant_left', identity: 'student:b', at: at(40) },
      ],
      at(60),
    );
    expect(totals.get('tutor:a')).toEqual({ seconds: 3600, firstJoinedAt: at(0) });
    expect(totals.get('student:b')).toEqual({ seconds: (10 + 20) * 60, firstJoinedAt: at(5) });
  });

  it('attendance through the API matches the LiveKit events', async () => {
    let s = await paidSession(t);
    await goToStart(t, s);
    const base = Math.floor(t.clock.nowMs() / 1000);
    await sendLivekit(
      t,
      joined(s.sessionId, `tutor:${s.tutor.userId}`, { createdAt: String(base) }),
    );
    await sendLivekit(
      t,
      joined(s.sessionId, `student:${s.student.userId}`, { createdAt: String(base + 60) }),
    );
    await sendLivekit(
      t,
      left(s.sessionId, `student:${s.student.userId}`, { createdAt: String(base + 60 + 1500) }),
    );
    t.clock.set(new Date((base + 1800) * 1000));
    await sendLivekit(t, finished(s.sessionId, { createdAt: String(base + 1800) }));
    s = await relogin(t, s);

    const res = await t.http
      .get(`/tutor/sessions/${s.sessionId}/attendance`)
      .set(bearer(s.tutor))
      .expect(200);
    const byRole = Object.fromEntries(
      res.body.map((r: { role: string; seconds: number }) => [r.role, r.seconds]),
    );
    expect(byRole).toEqual({ TUTOR: 1800, STUDENT: 1500 });
  });
});
