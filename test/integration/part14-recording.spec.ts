import { eq } from 'drizzle-orm';
import { auditLog } from '../../src/platform/audit/audit.schema';
import { recordings } from '../../src/modules/recording/recording.schema';
import { RecordingService } from '../../src/modules/recording/recording.service';
import { RecordingProvider } from '../../src/providers/livekit/livekit.service';
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
  registerMember,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

/** Stands in for LiveKit Egress so tests don't need the Egress container. */
class FakeRecordingProvider extends RecordingProvider {
  started: Array<{ room: string; objectKey: string }> = [];
  stopped: string[] = [];
  async start(room: string, objectKey: string) {
    this.started.push({ room, objectKey });
    return { egressId: `EG_test_${this.started.length}` };
  }
  async stop(egressId: string) {
    this.stopped.push(egressId);
  }
}

describe('Part 14: recording and consent', () => {
  let t: TestApp;
  const provider = new FakeRecordingProvider();

  beforeAll(async () => {
    t = await createTestApp({ overrides: [{ provide: RecordingProvider, useValue: provider }] });
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
    provider.started = [];
    provider.stopped = [];
  });

  afterAll(async () => {
    await t.close();
  });

  async function liveSession(): Promise<PaidSession> {
    const s = await paidSession(t);
    await goToStart(t, s);
    await sendLivekit(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
    return relogin(t, s);
  }

  const consent = (
    who: { accessToken: string },
    app: 'student' | 'tutor',
    sessionId: string,
    granted: boolean,
  ) => t.http.post(`/${app}/sessions/${sessionId}/consent`).set(bearer(who)).send({ granted });

  it('does not record without everyone consenting', async () => {
    const s = await liveSession();
    const res = await consent(s.tutor, 'tutor', s.sessionId, true).expect(200);
    expect(res.body.status).toBe('NOT_RECORDED');
    expect(res.body.consents).toEqual([
      { userId: s.tutor.userId, role: 'TUTOR', granted: true },
      { userId: s.student.userId, role: 'STUDENT', granted: null },
    ]);
    await consent(s.student, 'student', s.sessionId, false).expect(200);
    expect(provider.started).toEqual([]);
    expect(await t.db.select().from(recordings)).toHaveLength(0);
  });

  it('starts once everyone consents, finishes from Egress events, and only members can watch', async () => {
    const s = await liveSession();
    await consent(s.student, 'student', s.sessionId, true).expect(200);
    const both = await consent(s.tutor, 'tutor', s.sessionId, true).expect(200);
    expect(both.body.status).toBe('RECORDING');
    expect(provider.started).toEqual([
      { room: `session-${s.sessionId}`, objectKey: expect.stringMatching(/^recordings\//) },
    ]);
    await consent(s.tutor, 'tutor', s.sessionId, true).expect(200);
    expect(provider.started).toHaveLength(1); // idempotent

    t.clock.advanceMinutes(45);
    await sendLivekit(t, finished(s.sessionId));
    expect(provider.stopped).toEqual(['EG_test_1']);
    await sendLivekit(t, {
      event: 'egress_ended',
      egressInfo: {
        egressId: 'EG_test_1',
        roomName: `session-${s.sessionId}`,
        status: 'EGRESS_COMPLETE',
        fileResults: [{ size: '1048576' }],
      },
    });

    const fresh = await relogin(t, s);
    const mine = await t.http
      .get(`/student/sessions/${s.sessionId}/recording`)
      .set(bearer(fresh.student))
      .expect(200);
    expect(mine.body).toMatchObject({
      status: 'COMPLETED',
      url: expect.stringContaining('X-Amz-Signature'),
    });
    await t.http
      .get(`/tutor/sessions/${s.sessionId}/recording`)
      .set(bearer(fresh.tutor))
      .expect(200);

    const stranger = await registerMember(t, 'student');
    await t.http
      .get(`/student/sessions/${s.sessionId}/recording`)
      .set(bearer(stranger))
      .expect(403);

    // Staff can open it only while a dispute is open, and it is audited.
    const admin = await createStaff(t);
    const denied = await t.http
      .get(`/admin/sessions/${s.sessionId}/recording`)
      .set(bearer(admin))
      .expect(403);
    expect(denied.body.error.code).toBe('NO_OPEN_DISPUTE');
    await t.http
      .post(`/student/sessions/${s.sessionId}/disputes`)
      .set(bearer(fresh.student))
      .send({ reason: 'MISCONDUCT' })
      .expect(201);
    const ok = await t.http
      .get(`/admin/sessions/${s.sessionId}/recording`)
      .set(bearer(admin))
      .expect(200);
    expect(ok.body.url).toBeTruthy();
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, s.sessionId));
    expect(audits.map((a) => a.action)).toEqual(['recording.viewed_by_staff']);
  });

  it('withdrawing consent stops the recording', async () => {
    const s = await liveSession();
    await consent(s.student, 'student', s.sessionId, true).expect(200);
    await consent(s.tutor, 'tutor', s.sessionId, true).expect(200);
    await consent(s.student, 'student', s.sessionId, false).expect(200);
    expect(provider.stopped).toEqual(['EG_test_1']);
  });

  it('deletes recordings after the retention period', async () => {
    const s = await liveSession();
    await consent(s.student, 'student', s.sessionId, true).expect(200);
    await consent(s.tutor, 'tutor', s.sessionId, true).expect(200);
    await sendLivekit(t, {
      event: 'egress_ended',
      egressInfo: { egressId: 'EG_test_1', status: 'EGRESS_COMPLETE' },
    });

    const svc = t.app.get(RecordingService);
    t.clock.advanceDays(t.config.env.RECORDING_RETENTION_DAYS - 1);
    expect(await svc.sweepRetention()).toBe(0);
    t.clock.advanceDays(2);
    expect(await svc.sweepRetention()).toBe(1);
    expect(await svc.sweepRetention()).toBe(0);
    const [row] = await t.db.select().from(recordings);
    expect(row!.status).toBe('DELETED');
    const fresh = await login(t, 'student', s.student);
    expect(
      (
        await t.http
          .get(`/student/sessions/${s.sessionId}/recording`)
          .set(bearer(fresh))
          .expect(200)
      ).body,
    ).toMatchObject({
      status: 'DELETED',
      url: null,
    });
  });
});
