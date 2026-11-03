import { acceptedBooking } from '../fixtures/booking';
import {
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
  registerMember,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('Part 17: low-bandwidth support', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { WHITEBOARD_SNAPSHOT_LIMIT: 2 } });
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  async function live(): Promise<PaidSession> {
    const s = await paidSession(t);
    await goToStart(t, s);
    await sendLivekit(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
    return relogin(t, s);
  }

  async function upload(
    who: { accessToken: string },
    app: 'student' | 'tutor',
    sessionId: string,
    isFinal = false,
  ) {
    const presign = await t.http
      .post(`/${app}/sessions/${sessionId}/whiteboard-snapshots/presign`)
      .set(bearer(who))
      .send({ contentType: 'image/png', sizeBytes: PNG.length });
    if (presign.status !== 201) return presign;
    await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: presign.body.headers,
      body: PNG,
    });
    return t.http
      .post(`/${app}/sessions/${sessionId}/whiteboard-snapshots`)
      .set(bearer(who))
      .send({ objectKey: presign.body.objectKey, isFinal });
  }

  it('only the tutor and paid learners can post mode events', async () => {
    const s = await live();
    const ok = await t.http
      .post(`/student/sessions/${s.sessionId}/mode-events`)
      .set(bearer(s.student))
      .send({ mode: 'AUDIO_ONLY', downlinkKbps: 180, reason: 'poor-connection' })
      .expect(201);
    expect(ok.body.mode).toBe('AUDIO_ONLY');
    await t.http
      .post(`/tutor/sessions/${s.sessionId}/mode-events`)
      .set(bearer(s.tutor))
      .send({ mode: 'WHITEBOARD_ONLY' })
      .expect(201);

    const stranger = await registerMember(t, 'student');
    await t.http
      .post(`/student/sessions/${s.sessionId}/mode-events`)
      .set(bearer(stranger))
      .send({ mode: 'AUDIO_ONLY' })
      .expect(403);
    const unpaid = await acceptedBooking(t, 1);
    await t.http
      .post(`/student/sessions/${unpaid.sessionId}/mode-events`)
      .set(bearer(unpaid.student))
      .send({ mode: 'AUDIO_ONLY' })
      .expect(403);
    await t.http
      .post(`/student/sessions/${s.sessionId}/mode-events`)
      .set(bearer(s.student))
      .send({ mode: 'HD' })
      .expect(400);
  });

  it('saves whiteboard snapshots within limits and attaches the final one to the replay', async () => {
    const s = await live();
    await upload(s.tutor, 'tutor', s.sessionId).then((r) => expect(r.status).toBe(201));
    await upload(s.tutor, 'tutor', s.sessionId, true).then((r) => expect(r.status).toBe(201));
    const over = await upload(s.tutor, 'tutor', s.sessionId);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('SNAPSHOT_LIMIT');

    const big = await t.http
      .post(`/tutor/sessions/${s.sessionId}/whiteboard-snapshots/presign`)
      .set(bearer(s.tutor))
      .send({ contentType: 'image/png', sizeBytes: 3 * 1024 * 1024 });
    expect([400, 409]).toContain(big.status);
    const wrongType = await t.http
      .post(`/student/sessions/${s.sessionId}/whiteboard-snapshots/presign`)
      .set(bearer(s.student))
      .send({ contentType: 'video/mp4', sizeBytes: 100 })
      .expect(400);
    expect(wrongType.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');

    const stranger = await registerMember(t, 'tutor');
    await t.http
      .post(`/tutor/sessions/${s.sessionId}/whiteboard-snapshots/presign`)
      .set(bearer(stranger))
      .send({ contentType: 'image/png', sizeBytes: 10 })
      .expect(403);

    const replay = await t.http
      .get(`/student/sessions/${s.sessionId}/replay`)
      .set(bearer(s.student))
      .expect(200);
    expect(replay.body.whiteboard).toHaveLength(1);
    const img = await fetch(replay.body.whiteboard[0].url);
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('metrics count sessions correctly', async () => {
    // Each live() moves the clock to that session's start, so refresh tokens afterwards.
    const made: PaidSession[] = [];
    for (let i = 0; i < 3; i++) made.push(await live());
    const [a, b, c] = await Promise.all(made.map((s) => relogin(t, s)));
    const post = (s: PaidSession, mode: string, kbps: number) =>
      t.http
        .post(`/student/sessions/${s.sessionId}/mode-events`)
        .set(bearer(s.student))
        .send({ mode, downlinkKbps: kbps })
        .expect(201);
    await post(a!, 'AUDIO_ONLY', 100);
    await post(a!, 'FULL_VIDEO', 900); // a switched back; still counts as a low-bandwidth session
    await post(b!, 'FULL_VIDEO', 2000);
    await post(c!, 'WHITEBOARD_ONLY', 60);

    const admin = await createStaff(t);
    const res = await t.http
      .get('/admin/metrics/low-bandwidth')
      .query({
        from: new Date(t.clock.nowMs() - 3_600_000).toISOString(),
        to: new Date(t.clock.nowMs() + 3_600_000).toISOString(),
      })
      .set(bearer(admin))
      .expect(200);
    expect(res.body).toMatchObject({
      sessionsReporting: 3,
      lowBandwidthSessions: 2,
      lowBandwidthShare: 0.667,
      avgDownlinkKbps: 765,
    });
    expect(
      Object.fromEntries(
        res.body.byMode.map((m: { mode: string; sessions: number }) => [m.mode, m.sessions]),
      ),
    ).toEqual({
      FULL_VIDEO: 2,
      AUDIO_ONLY: 1,
      WHITEBOARD_ONLY: 1,
    });
  });
});
