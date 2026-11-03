import { eq } from 'drizzle-orm';
import {
  contentFlags,
  moderationActions,
  moderationCases,
} from '../../src/modules/moderation/moderation.schema';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { RealtimeRouterModule } from '../../src/modules/realtime/realtime.router';
import { tutorProfiles } from '../../src/modules/tutors/tutors.schema';
import { RuleBasedScreeningProvider } from '../../src/providers/screening/screening.provider';
import { auditLog } from '../../src/platform/audit/audit.schema';
import { approvedTutor, publishOutbox } from '../fixtures/marketplace';
import {
  bearer,
  createStaff,
  createTestApp,
  registerMember,
  resetState,
  seedCatalog,
  skillId,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 3: screening rules', () => {
  const screen = (s: string) => new RuleBasedScreeningProvider().screen(s);

  it('masks phone numbers, emails, UPI IDs and social handles', () => {
    const r = screen(
      'Call +91 98765 43210 or 9876543210, mail me at a.b@gmail.com, UPI ravi@okaxis, whatsapp id ravi_trader, t.me/ravichat',
    );
    expect(r.text).not.toMatch(/98765|gmail|okaxis|ravi_trader|t\.me/);
    expect(new Set(r.hits.map((h) => h.rule))).toEqual(
      new Set(['CONTACT_PHONE', 'CONTACT_EMAIL', 'CONTACT_UPI', 'CONTACT_SOCIAL']),
    );
    expect(r.blocked).toBe(false);
  });

  it('flags off-platform payment and stock tips, blocks abuse', () => {
    expect(screen('Pay me directly and get 20% off').hits[0]).toMatchObject({
      rule: 'OFF_PLATFORM_PAYMENT',
      action: 'FLAG',
    });
    expect(
      screen('Sure shot multibagger tips with guaranteed returns').hits.map((h) => h.rule),
    ).toContain('FINANCIAL_TIP');
    expect(screen('Buy RELIANCE at 2500 with target 2800').hits[0]?.rule).toBe('FINANCIAL_TIP');
    expect(screen('you are a bastard').blocked).toBe(true);
  });

  it('leaves normal teaching text alone', () => {
    const text =
      'Session costs ₹499 for 60 minutes. We cover RSI(14), the 2008 crash, chapter 12 and 3.14159. Email-free!';
    expect(screen(text)).toEqual({ text, blocked: false, hits: [] });
  });
});

describe('Part 3: trust & safety flows', () => {
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

  it('screens tutor bios: contacts masked and recorded, payment-dodging opens a case', async () => {
    const tutor = await registerMember(t, 'tutor');
    const res = await t.http
      .put('/tutor/profile')
      .set(bearer(tutor))
      .send({
        bio: 'Experienced trader. WhatsApp me on 9876543210 and pay me directly for a discount.',
      })
      .expect(200);
    expect(res.body.bio).not.toContain('9876543210');
    expect(res.body.bio).toContain('[hidden]');

    const flags = await t.db
      .select()
      .from(contentFlags)
      .where(eq(contentFlags.userId, tutor.userId));
    expect(flags.map((f) => f.rule).sort()).toEqual([
      'CONTACT_PHONE',
      'CONTACT_SOCIAL',
      'OFF_PLATFORM_PAYMENT',
    ]);
    const [c] = await t.db
      .select()
      .from(moderationCases)
      .where(eq(moderationCases.subjectUserId, tutor.userId));
    expect(c).toMatchObject({ status: 'OPEN' });
  });

  it('blocks abusive text with 422 but keeps the evidence', async () => {
    const tutor = await registerMember(t, 'tutor');
    const res = await t.http
      .put('/tutor/profile')
      .set(bearer(tutor))
      .send({ bio: 'Learners who fail are chutiya' })
      .expect(422);
    expect(res.body.error).toMatchObject({
      code: 'CONTENT_BLOCKED',
      details: { rules: ['ABUSIVE_LANGUAGE'] },
    });
    expect(await t.db.select().from(tutorProfiles)).toHaveLength(0);
    const flags = await t.db
      .select()
      .from(contentFlags)
      .where(eq(contentFlags.userId, tutor.userId));
    expect(flags[0]).toMatchObject({ rule: 'ABUSIVE_LANGUAGE', severity: 'HIGH', action: 'BLOCK' });
  });

  it('members report each other; moderators see one case per member, highest priority first', async () => {
    const tutor = await approvedTutor(t);
    const s1 = await registerMember(t, 'student');
    const s2 = await registerMember(t, 'student');

    await t.http
      .post('/student/reports')
      .set(bearer(s1))
      .send({
        subjectUserId: tutor.userId,
        reason: 'OFF_PLATFORM_PAYMENT',
        details: 'Asked for GPay outside the app.',
      })
      .expect(201);
    await t.http
      .post('/student/reports')
      .set(bearer(s2))
      .send({ subjectUserId: tutor.userId, reason: 'HARASSMENT' })
      .expect(201);
    await t.http
      .post('/tutor/reports')
      .set(bearer(tutor))
      .send({ subjectUserId: s1.userId, reason: 'SPAM' })
      .expect(201);

    const self = await t.http
      .post('/student/reports')
      .set(bearer(s1))
      .send({ subjectUserId: s1.userId, reason: 'SPAM' })
      .expect(400);
    expect(self.body.error.code).toBe('CANNOT_REPORT_SELF');

    const moderator = await createStaff(t, 'MODERATOR');
    const queue = await t.http.get('/admin/moderation/cases').set(bearer(moderator)).expect(200);
    expect(queue.body.map((c: { subjectUserId: string }) => c.subjectUserId)).toEqual([
      tutor.userId,
      s1.userId,
    ]);
    expect(queue.body[0]).toMatchObject({ reportCount: 2, priority: 13 });

    const detail = await t.http
      .get(`/admin/moderation/cases/${queue.body[0].id}`)
      .set(bearer(moderator))
      .expect(200);
    expect(detail.body.reports.map((r: { reason: string }) => r.reason)).toEqual([
      'OFF_PLATFORM_PAYMENT',
      'HARASSMENT',
    ]);
    expect(detail.body.subject).toMatchObject({ id: tutor.userId, status: 'ACTIVE' });

    // Members can't reach the admin portal.
    await t.http.get('/admin/moderation/cases').set(bearer(s1)).expect(401);
  });

  it('suspension signs the member out, notifies them, and the sweep reinstates them when it ends', async () => {
    const student = await registerMember(t, 'student');
    const reporter = await registerMember(t, 'tutor');
    const report = await t.http
      .post('/tutor/reports')
      .set(bearer(reporter))
      .send({ subjectUserId: student.userId, reason: 'HARASSMENT' })
      .expect(201);

    const moderator = await createStaff(t, 'MODERATOR');
    const acted = await t.http
      .post(`/admin/moderation/cases/${report.body.caseId}/actions`)
      .set(bearer(moderator))
      .send({ action: 'SUSPEND', reason: 'Abusive messages to a tutor.', durationDays: 7 })
      .expect(200);
    expect(acted.body.case.status).toBe('ACTIONED');
    expect(acted.body.subject.status).toBe('SUSPENDED');

    await t.http.get('/student/me').set(bearer(student)).expect(401);
    await t.http
      .post('/student/auth/refresh')
      .send({ refreshToken: student.refreshToken })
      .expect(401);
    const login = await t.http
      .post('/student/auth/login')
      .send({ email: student.email, password: student.password });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const again = await t.http
      .post(`/admin/moderation/cases/${report.body.caseId}/actions`)
      .set(bearer(moderator))
      .send({ action: 'BAN', reason: 'Second decision' })
      .expect(409);
    expect(again.body.error.code).toBe('CASE_NOT_OPEN');

    const moderation = t.app.get(ModerationService);
    t.clock.advanceDays(6);
    expect(await moderation.sweepExpiredSanctions()).toBe(0);
    t.clock.advanceDays(2);
    expect(await moderation.sweepExpiredSanctions()).toBe(1);
    expect(await moderation.sweepExpiredSanctions()).toBe(0);

    const back = await t.http
      .post('/student/auth/login')
      .send({ email: student.email, password: student.password })
      .expect(200);
    await publishOutbox(t);
    const notes = await t.http.get('/student/notifications').set(bearer(back.body)).expect(200);
    expect(notes.body[0]).toMatchObject({
      type: 'moderation.action',
      body: 'Abusive messages to a tutor.',
    });

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, report.body.caseId));
    expect(audits.map((a) => a.action)).toEqual(['moderation.case.suspend']);
    await expect(t.db.delete(moderationActions)).rejects.toThrow();
  });

  it('posting restrictions block publishing; lifting restores it', async () => {
    const student = await registerMember(t, 'student');
    const admin = await createStaff(t, 'ADMIN');
    const opened = await t.http
      .post('/admin/moderation/cases')
      .set(bearer(admin))
      .send({ subjectUserId: student.userId, note: 'Spam requests reported by email.' })
      .expect(201);
    await t.http
      .post(`/admin/moderation/cases/${opened.body.case.id}/actions`)
      .set(bearer(admin))
      .send({ action: 'RESTRICT_POSTING', reason: 'Spam requests.', durationDays: 3 })
      .expect(200);

    const draft = await t.http
      .post('/student/requests')
      .set(bearer(student))
      .send({
        skillId: await skillId(t, 'calculus'),
        level: 'BEGINNER',
        title: 'Integrals help',
        description: 'Need help with integration by parts.',
      })
      .expect(201);
    const blocked = await t.http
      .post(`/student/requests/${draft.body.id}/publish`)
      .set(bearer(student))
      .expect(403);
    expect(blocked.body.error.code).toBe('RESTRICTED_FROM_POSTING');

    const sanctions = await t.http
      .get(`/admin/moderation/users/${student.userId}/sanctions`)
      .set(bearer(admin))
      .expect(200);
    await t.http
      .post(`/admin/moderation/sanctions/${sanctions.body[0].id}/lift`)
      .set(bearer(admin))
      .send({ reason: 'Appeal accepted.' })
      .expect(204);
    await t.http
      .post(`/student/requests/${draft.body.id}/publish`)
      .set(bearer(student))
      .expect(200);
  });

  it('suspended durations are required, and dismissing leaves no sanction', async () => {
    const student = await registerMember(t, 'student');
    const admin = await createStaff(t);
    const c = await t.http
      .post('/admin/moderation/cases')
      .set(bearer(admin))
      .send({ subjectUserId: student.userId, note: 'Check this member.' })
      .expect(201);
    const noDuration = await t.http
      .post(`/admin/moderation/cases/${c.body.case.id}/actions`)
      .set(bearer(admin))
      .send({ action: 'SUSPEND', reason: 'Missing duration' })
      .expect(400);
    expect(noDuration.body.error.code).toBe('DURATION_REQUIRED');
    const dismissed = await t.http
      .post(`/admin/moderation/cases/${c.body.case.id}/actions`)
      .set(bearer(admin))
      .send({ action: 'DISMISS', reason: 'Nothing wrong here.' })
      .expect(200);
    expect(dismissed.body).toMatchObject({
      case: { status: 'DISMISSED' },
      sanctions: [],
      history: { strikes: 0, dismissed: 1 },
    });
  });
});
