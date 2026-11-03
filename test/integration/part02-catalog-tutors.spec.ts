import { eq, sql } from 'drizzle-orm';
import { users } from '../../src/modules/identity/identity.schema';
import { TutorsService } from '../../src/modules/tutors/tutors.service';
import { auditLog } from '../../src/platform/audit/audit.schema';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  registerMember,
  resetState,
  seedCatalog,
  skillId,
  type Session,
  type TestApp,
} from '../fixtures/test-app';
import { TestRoutesModule } from '../fixtures/test-routes.module';

const PROFILE = {
  headline: 'Chartist and YouTube educator',
  bio: 'I have taught technical analysis and video editing to over 2,000 learners online.',
  experienceYears: 6,
  languages: ['English', 'Hindi'],
  payoutUpiId: 'tutor.one@okaxis',
};

const SKILL_CLAIM = {
  experienceYears: 5,
  summary: 'Candlesticks, support and resistance, and risk management for beginners.',
  evidenceLinks: ['https://example.com/portfolio', 'https://example.com/nism-certificate.pdf'],
};

describe('Part 2: skill catalog and tutor verification', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [TestRoutesModule] });
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  /** A tutor-app session with a complete profile, two skill claims, submitted for review. */
  async function pendingTutor(fullName = 'Ravi Kumar'): Promise<Session> {
    const tutor = await registerMember(t, 'tutor', { fullName });
    await t.http.put('/tutor/profile').set(bearer(tutor)).send(PROFILE).expect(200);
    for (const slug of ['technical-analysis', 'video-editing']) {
      await t.http
        .put(`/tutor/skills/${await skillId(t, slug)}`)
        .set(bearer(tutor))
        .send(SKILL_CLAIM)
        .expect(200);
    }
    const res = await t.http.post('/tutor/profile/verification').set(bearer(tutor)).expect(200);
    expect(res.body.verificationStatus).toBe('PENDING');
    return tutor;
  }

  async function approveProfile(admin: Session, tutor: Session, badge = 'VERIFIED') {
    return t.http
      .post(`/admin/tutors/${tutor.userId}/verification/approve`)
      .set(bearer(admin))
      .send({ badge })
      .expect(200);
  }

  async function approveSkill(admin: Session, tutor: Session, slug: string) {
    return t.http
      .post(`/admin/tutors/${tutor.userId}/skills/${await skillId(t, slug)}/approve`)
      .set(bearer(admin))
      .expect(200);
  }

  // ======================= Catalog =======================

  describe('public catalog', () => {
    it('seeds categories across domains, with sub-categories, and seeding twice changes nothing', async () => {
      await seedCatalog(t);
      const res = await t.http.get('/public/categories').expect(200);
      expect(res.body.map((c: { slug: string }) => c.slug)).toEqual([
        'academics',
        'finance-investing',
        'content-creation',
        'technology',
        'design',
        'languages-communication',
      ]);
      const academics = res.body.find((c: { slug: string }) => c.slug === 'academics');
      expect(academics.children.map((c: { slug: string }) => c.slug)).toEqual([
        'school-mathematics',
      ]);

      const counts = await t.db.execute<{ c: number; s: number; tp: number }>(
        sql`select (select count(*) from categories)::int c, (select count(*) from skills)::int s, (select count(*) from topics)::int tp`,
      );
      expect(counts.rows[0]).toEqual({ c: 7, s: 19, tp: 26 });
    });

    it('searches skills by text and by category (top-level includes sub-categories)', async () => {
      const byText = await t.http.get('/public/skills?q=video').expect(200);
      expect(byText.body.items.map((s: { slug: string }) => s.slug).sort()).toEqual([
        'short-form-video',
        'video-editing',
      ]);

      const cats = (await t.http.get('/public/categories').expect(200)).body;
      const academics = cats.find((c: { slug: string }) => c.slug === 'academics');
      const byCategory = await t.http
        .get(`/public/skills?categoryId=${academics.id}&limit=50`)
        .expect(200);
      expect(byCategory.body.total).toBe(4);
      expect(byCategory.body.items.map((s: { slug: string }) => s.slug)).toContain('calculus');

      const paged = await t.http.get('/public/skills?limit=5&offset=5').expect(200);
      expect(paged.body).toMatchObject({ total: 19, limit: 5, offset: 5 });
      expect(paged.body.items).toHaveLength(5);
    });

    it('treats LIKE wildcards in search text literally', async () => {
      const res = await t.http.get('/public/skills?q=%25').expect(200);
      expect(res.body.total).toBe(0);
    });

    it('returns a skill with category, topics and its learner notice', async () => {
      const res = await t.http.get('/public/skills/technical-analysis').expect(200);
      expect(res.body).toMatchObject({
        slug: 'technical-analysis',
        category: { slug: 'finance-investing' },
        learnerNotice: expect.stringContaining('not investment advice'),
      });
      expect(res.body.topics.map((x: { slug: string }) => x.slug)).toContain(
        'candlestick-patterns',
      );
      await t.http.get(`/public/skills/${res.body.id}`).expect(200);
      expect((await t.http.get('/public/skills/astrology').expect(404)).body.error.code).toBe(
        'SKILL_NOT_FOUND',
      );
    });
  });

  describe('admin catalog management', () => {
    it('creates categories, sub-categories, skills and topics, all audited', async () => {
      const admin = await createStaff(t);
      const fitness = await t.http
        .post('/admin/catalog/categories')
        .set(bearer(admin))
        .send({ name: 'Fitness & Wellness' })
        .expect(201);
      expect(fitness.body.slug).toBe('fitness-and-wellness');

      const yoga = await t.http
        .post('/admin/catalog/categories')
        .set(bearer(admin))
        .send({ name: 'Yoga', parentId: fitness.body.id })
        .expect(201);
      const tooDeep = await t.http
        .post('/admin/catalog/categories')
        .set(bearer(admin))
        .send({ name: 'Hatha', parentId: yoga.body.id })
        .expect(400);
      expect(tooDeep.body.error.code).toBe('CATEGORY_TOO_DEEP');

      const skill = await t.http
        .post('/admin/catalog/skills')
        .set(bearer(admin))
        .send({ categoryId: yoga.body.id, name: 'Beginner Yoga' })
        .expect(201);
      await t.http
        .post(`/admin/catalog/skills/${skill.body.id}/topics`)
        .set(bearer(admin))
        .send({ name: 'Breathing (Pranayama)' })
        .expect(201);

      const detail = await t.http.get('/public/skills/beginner-yoga').expect(200);
      expect(detail.body.topics.map((x: { slug: string }) => x.slug)).toEqual([
        'breathing-pranayama',
      ]);

      const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
      expect(actions).toEqual([
        'catalog.category.created',
        'catalog.category.created',
        'catalog.skill.created',
        'catalog.topic.created',
      ]);
    });

    it('rejects duplicate slugs with 409', async () => {
      const admin = await createStaff(t);
      const cats = (await t.http.get('/public/categories').expect(200)).body;
      const res = await t.http
        .post('/admin/catalog/skills')
        .set(bearer(admin))
        .send({ categoryId: cats[0].id, name: 'Calculus' })
        .expect(409);
      expect(res.body.error.code).toBe('SLUG_TAKEN');
    });

    it('deactivating a skill hides it publicly but keeps it in the admin list', async () => {
      const admin = await createStaff(t);
      const id = await skillId(t, 'podcasting');
      await t.http
        .patch(`/admin/catalog/skills/${id}`)
        .set(bearer(admin))
        .send({ isActive: false })
        .expect(200);
      await t.http.get('/public/skills/podcasting').expect(404);
      const pub = await t.http.get('/public/skills?q=podcast').expect(200);
      expect(pub.body.total).toBe(0);
      const adminList = await t.http
        .get('/admin/catalog/skills?q=podcast')
        .set(bearer(admin))
        .expect(200);
      expect(adminList.body.items[0]).toMatchObject({ slug: 'podcasting', isActive: false });
    });

    it('is ADMIN only: moderators and members are refused', async () => {
      const moderator = await createStaff(t, 'MODERATOR');
      await t.http
        .post('/admin/catalog/categories')
        .set(bearer(moderator))
        .send({ name: 'X Category' })
        .expect(403);
      const tutor = await registerMember(t, 'tutor');
      await t.http
        .post('/admin/catalog/categories')
        .set(bearer(tutor))
        .send({ name: 'X Category' })
        .expect(401);
    });
  });

  describe('skill suggestions', () => {
    it('a tutor suggests a missing skill; an admin approves it and the skill goes live', async () => {
      const tutor = await registerMember(t, 'tutor');
      const cats = (await t.http.get('/public/categories').expect(200)).body;
      const finance = cats.find((c: { slug: string }) => c.slug === 'finance-investing');

      const suggestion = await t.http
        .post('/tutor/skill-suggestions')
        .set(bearer(tutor))
        .send({
          categoryId: finance.id,
          name: 'Options Trading Basics',
          description: 'Calls, puts, greeks.',
        })
        .expect(201);
      expect(suggestion.body.status).toBe('PENDING');

      const admin = await createStaff(t);
      const queue = await t.http
        .get('/admin/catalog/skill-suggestions')
        .set(bearer(admin))
        .expect(200);
      expect(queue.body).toHaveLength(1);

      const approved = await t.http
        .post(`/admin/catalog/skill-suggestions/${suggestion.body.id}/approve`)
        .set(bearer(admin))
        .send({ learnerNotice: 'Education only. Not investment advice.' })
        .expect(200);
      expect(approved.body).toMatchObject({
        status: 'APPROVED',
        createdSkillId: expect.any(String),
      });

      const skill = await t.http.get('/public/skills/options-trading-basics').expect(200);
      expect(skill.body).toMatchObject({
        id: approved.body.createdSkillId,
        learnerNotice: expect.any(String),
      });

      const again = await t.http
        .post(`/admin/catalog/skill-suggestions/${suggestion.body.id}/reject`)
        .set(bearer(admin))
        .send({ reason: 'Too late now' })
        .expect(409);
      expect(again.body.error.code).toBe('INVALID_SUGGESTION_STATE');

      const mine = await t.http.get('/tutor/skill-suggestions').set(bearer(tutor)).expect(200);
      expect(mine.body[0].status).toBe('APPROVED');
    });

    it('refuses suggestions for skills that already exist', async () => {
      const tutor = await registerMember(t, 'tutor');
      const cats = (await t.http.get('/public/categories').expect(200)).body;
      const res = await t.http
        .post('/tutor/skill-suggestions')
        .set(bearer(tutor))
        .send({ categoryId: cats[0].id, name: 'video editing' })
        .expect(409);
      expect(res.body.error.code).toBe('SKILL_EXISTS');
    });

    it('rejection is audited', async () => {
      const tutor = await registerMember(t, 'tutor');
      const cats = (await t.http.get('/public/categories').expect(200)).body;
      const s = await t.http
        .post('/tutor/skill-suggestions')
        .set(bearer(tutor))
        .send({ categoryId: cats[0].id, name: 'Astrology' })
        .expect(201);
      const admin = await createStaff(t);
      await t.http
        .post(`/admin/catalog/skill-suggestions/${s.body.id}/reject`)
        .set(bearer(admin))
        .send({ reason: 'Not a teachable skill on this platform.' })
        .expect(200);
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, s.body.id));
      expect(audits.map((a) => a.action)).toEqual(['catalog.suggestion.rejected']);
    });
  });

  // ======================= Tutors =======================

  describe('tutor profile and skills', () => {
    it('a learner becomes a tutor with the same account', async () => {
      const student = await registerMember(t, 'student', { fullName: 'Asha Verma' });
      const tutor = await login(t, 'tutor', student);
      await t.http.get('/tutor/profile').set(bearer(tutor)).expect(404);

      await t.http.put('/tutor/profile').set(bearer(tutor)).send(PROFILE).expect(200);
      const res = await t.http
        .put(`/tutor/skills/${await skillId(t, 'video-editing')}`)
        .set(bearer(tutor))
        .send(SKILL_CLAIM)
        .expect(200);
      expect(res.body).toMatchObject({
        userId: student.userId,
        payoutUpiId: PROFILE.payoutUpiId,
        languages: ['English', 'Hindi'],
        badge: 'NONE',
        verificationStatus: 'NOT_SUBMITTED',
        skills: [
          {
            skill: { slug: 'video-editing' },
            status: 'PENDING',
            evidenceLinks: SKILL_CLAIM.evidenceLinks,
          },
        ],
      });

      const me = await t.http.get('/tutor/me').set(bearer(tutor)).expect(200);
      expect(me.body.tutorProfile).toEqual({ verificationStatus: 'NOT_SUBMITTED', badge: 'NONE' });
    });

    it('validates skill claims: unknown skill, non-https evidence, bad UPI id', async () => {
      const tutor = await registerMember(t, 'tutor');
      await t.http.put('/tutor/profile').set(bearer(tutor)).send({ bio: 'x' }).expect(200);

      const unknown = await t.http
        .put('/tutor/skills/00000000-0000-4000-8000-000000000000')
        .set(bearer(tutor))
        .send(SKILL_CLAIM)
        .expect(400);
      expect(unknown.body.error.code).toBe('UNKNOWN_SKILL');

      const http = await t.http
        .put(`/tutor/skills/${await skillId(t, 'calculus')}`)
        .set(bearer(tutor))
        .send({ ...SKILL_CLAIM, evidenceLinks: ['http://insecure.example.com'] })
        .expect(400);
      expect(http.body.error.details.fields.evidenceLinks).toBeDefined();

      const upi = await t.http
        .put('/tutor/profile')
        .set(bearer(tutor))
        .send({ payoutUpiId: 'not a upi id' })
        .expect(400);
      expect(upi.body.error.details.fields.payoutUpiId).toBeDefined();
    });

    it('needs a profile before listing skills, and can remove a skill', async () => {
      const tutor = await registerMember(t, 'tutor');
      const id = await skillId(t, 'calculus');
      const noProfile = await t.http
        .put(`/tutor/skills/${id}`)
        .set(bearer(tutor))
        .send(SKILL_CLAIM)
        .expect(404);
      expect(noProfile.body.error.code).toBe('TUTOR_PROFILE_NOT_FOUND');

      await t.http.put('/tutor/profile').set(bearer(tutor)).send(PROFILE).expect(200);
      await t.http.put(`/tutor/skills/${id}`).set(bearer(tutor)).send(SKILL_CLAIM).expect(200);
      const removed = await t.http.delete(`/tutor/skills/${id}`).set(bearer(tutor)).expect(200);
      expect(removed.body.skills).toEqual([]);
      await t.http.delete(`/tutor/skills/${id}`).set(bearer(tutor)).expect(404);
    });

    it('refuses to submit an incomplete profile, and returns 409 when submitting twice', async () => {
      const tutor = await registerMember(t, 'tutor');
      await t.http.put('/tutor/profile').set(bearer(tutor)).send({ bio: 'too short' }).expect(200);
      const incomplete = await t.http
        .post('/tutor/profile/verification')
        .set(bearer(tutor))
        .expect(400);
      expect(incomplete.body.error.code).toBe('PROFILE_INCOMPLETE');
      expect(incomplete.body.error.details.missing).toEqual(
        expect.arrayContaining(['at least one skill', 'payoutUpiId']),
      );

      const pending = await pendingTutor();
      const twice = await t.http
        .post('/tutor/profile/verification')
        .set(bearer(pending))
        .expect(409);
      expect(twice.body.error).toMatchObject({
        code: 'INVALID_VERIFICATION_STATE',
        details: { verificationStatus: 'PENDING' },
      });
    });
  });

  describe('admin verification', () => {
    it('only ADMIN staff can approve; members and moderators are refused', async () => {
      const tutor = await pendingTutor();
      const student = await registerMember(t, 'student');
      const moderator = await createStaff(t, 'MODERATOR');

      // Member tokens are for another app entirely.
      for (const caller of [tutor, student]) {
        await t.http
          .post(`/admin/tutors/${tutor.userId}/verification/approve`)
          .set(bearer(caller))
          .send({ badge: 'VERIFIED' })
          .expect(401);
      }
      const res = await t.http
        .post(`/admin/tutors/${tutor.userId}/verification/approve`)
        .set(bearer(moderator))
        .send({ badge: 'VERIFIED' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
    });

    it('admin reviews profile and skill claims separately; every decision is audited', async () => {
      const tutor = await pendingTutor();
      const admin = await createStaff(t);

      const profiles = await t.http
        .get('/admin/tutors/profile-reviews')
        .set(bearer(admin))
        .expect(200);
      expect(profiles.body[0]).toMatchObject({
        userId: tutor.userId,
        fullName: 'Ravi Kumar',
        email: tutor.email,
      });

      const claims = await t.http.get('/admin/tutors/skill-reviews').set(bearer(admin)).expect(200);
      expect(claims.body).toHaveLength(2);
      expect(claims.body[0]).toMatchObject({
        tutorUserId: tutor.userId,
        status: 'PENDING',
        evidenceLinks: SKILL_CLAIM.evidenceLinks,
        tutorVerificationStatus: 'PENDING',
      });

      await t.http
        .post(`/admin/tutors/${tutor.userId}/verification/approve`)
        .set(bearer(admin))
        .set('X-Request-Id', 'admin-approve-req-1')
        .send({ badge: 'VERIFIED' })
        .expect(200);
      await approveSkill(admin, tutor, 'technical-analysis');
      const rejected = await t.http
        .post(`/admin/tutors/${tutor.userId}/skills/${await skillId(t, 'video-editing')}/reject`)
        .set(bearer(admin))
        .send({ reason: 'Please add a link to edited work.' })
        .expect(200);

      expect(rejected.body).toMatchObject({ verificationStatus: 'VERIFIED', badge: 'VERIFIED' });
      const statuses = Object.fromEntries(
        rejected.body.skills.map((s: { skill: { slug: string }; status: string }) => [
          s.skill.slug,
          s.status,
        ]),
      );
      expect(statuses).toEqual({ 'technical-analysis': 'APPROVED', 'video-editing': 'REJECTED' });

      const audits = await t.db.select().from(auditLog);
      expect(audits.map((a) => a.action).sort()).toEqual([
        'tutor.skill.approved',
        'tutor.skill.rejected',
        'tutor.verification.approved',
      ]);
      expect(audits.find((a) => a.action === 'tutor.verification.approved')).toMatchObject({
        actorUserId: admin.userId,
        actorRole: 'ADMIN',
        entityId: tutor.userId,
        requestId: 'admin-approve-req-1',
      });
    });

    it('editing a rejected skill claim sends it back for review', async () => {
      const tutor = await pendingTutor();
      const admin = await createStaff(t);
      const id = await skillId(t, 'video-editing');
      await t.http
        .post(`/admin/tutors/${tutor.userId}/skills/${id}/reject`)
        .set(bearer(admin))
        .send({ reason: 'Add evidence please.' })
        .expect(200);
      const edited = await t.http
        .put(`/tutor/skills/${id}`)
        .set(bearer(tutor))
        .send({ ...SKILL_CLAIM, evidenceLinks: ['https://example.com/showreel'] })
        .expect(200);
      const claim = edited.body.skills.find((s: { skill: { id: string } }) => s.skill.id === id);
      expect(claim).toMatchObject({ status: 'PENDING', rejectionReason: null });
    });

    it('rejected profiles can be fixed and resubmitted; deciding twice returns 409', async () => {
      const tutor = await pendingTutor();
      const admin = await createStaff(t);
      await t.http
        .post(`/admin/tutors/${tutor.userId}/verification/reject`)
        .set(bearer(admin))
        .send({ reason: 'Please add a photo ID check.' })
        .expect(200);
      const again = await t.http
        .post(`/admin/tutors/${tutor.userId}/verification/reject`)
        .set(bearer(admin))
        .send({ reason: 'Again' })
        .expect(409);
      expect(again.body.error.code).toBe('INVALID_VERIFICATION_STATE');

      const resubmitted = await t.http
        .post('/tutor/profile/verification')
        .set(bearer(tutor))
        .expect(200);
      expect(resubmitted.body).toMatchObject({
        verificationStatus: 'PENDING',
        verificationRejectionReason: null,
      });
    });

    it('audit_log is append-only', async () => {
      const tutor = await pendingTutor();
      await approveProfile(await createStaff(t), tutor);
      await expect(t.db.update(auditLog).set({ action: 'tampered' })).rejects.toThrow();
      await expect(t.db.delete(auditLog)).rejects.toThrow();
      expect((await t.db.select().from(auditLog)).map((r) => r.action)).toEqual([
        'tutor.verification.approved',
      ]);
    });
  });

  describe('teaching eligibility', () => {
    it('VerifiedTutorGuard blocks unverified tutors and passes verified ones', async () => {
      const tutor = await pendingTutor();
      const blocked = await t.http
        .get('/tutor/__test__/verified-only')
        .set(bearer(tutor))
        .expect(403);
      expect(blocked.body.error.code).toBe('TUTOR_NOT_VERIFIED');

      await approveProfile(await createStaff(t), tutor);
      const ok = await t.http.get('/tutor/__test__/verified-only').set(bearer(tutor)).expect(200);
      expect(ok.body).toEqual({ ok: true, userId: tutor.userId });
    });

    it('canTeach needs a verified profile AND an approved, active skill', async () => {
      const tutor = await pendingTutor();
      const admin = await createStaff(t);
      const tutors = t.app.get(TutorsService);
      const ta = await skillId(t, 'technical-analysis');

      expect(await tutors.canTeach(tutor.userId, ta)).toBe(false); // nothing approved yet
      await approveSkill(admin, tutor, 'technical-analysis');
      expect(await tutors.canTeach(tutor.userId, ta)).toBe(false); // profile still pending
      await approveProfile(admin, tutor);
      expect(await tutors.canTeach(tutor.userId, ta)).toBe(true);
      expect(await tutors.canTeach(tutor.userId, await skillId(t, 'video-editing'))).toBe(false);

      await t.http
        .patch(`/admin/catalog/skills/${ta}`)
        .set(bearer(admin))
        .send({ isActive: false })
        .expect(200);
      expect(await tutors.canTeach(tutor.userId, ta)).toBe(false);
    });
  });

  describe('public tutor directory', () => {
    it('shows verified tutors with approved skills only, and no private fields', async () => {
      const tutor = await pendingTutor();
      await t.http.get(`/public/tutors/${tutor.userId}`).expect(404);

      const admin = await createStaff(t);
      await approveProfile(admin, tutor, 'EXPERT');
      await approveSkill(admin, tutor, 'technical-analysis');

      const res = await t.http.get(`/public/tutors/${tutor.userId}`).expect(200);
      expect(res.body).toMatchObject({
        userId: tutor.userId,
        fullName: 'Ravi Kumar',
        badge: 'EXPERT',
      });
      expect(res.body.skills.map((s: { skill: { slug: string } }) => s.skill.slug)).toEqual([
        'technical-analysis',
      ]);
      const body = JSON.stringify(res.body);
      for (const secret of [
        'payoutUpiId',
        PROFILE.payoutUpiId,
        'razorpay',
        tutor.email,
        'evidenceLinks',
      ]) {
        expect(body).not.toContain(secret);
      }
    });

    it('lists tutors by skill', async () => {
      const a = await pendingTutor('Tutor A');
      const b = await pendingTutor('Tutor B');
      const admin = await createStaff(t);
      for (const tutor of [a, b]) await approveProfile(admin, tutor);
      await approveSkill(admin, a, 'technical-analysis');
      await approveSkill(admin, b, 'video-editing');

      const ta = await t.http
        .get(`/public/tutors?skillId=${await skillId(t, 'technical-analysis')}`)
        .expect(200);
      expect(ta.body.items.map((x: { fullName: string }) => x.fullName)).toEqual(['Tutor A']);

      const all = await t.http.get('/public/tutors').expect(200);
      expect(all.body.total).toBe(2);
    });

    it('hides suspended tutors', async () => {
      const tutor = await pendingTutor();
      await approveProfile(await createStaff(t), tutor);
      await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, tutor.userId));
      await t.http.get(`/public/tutors/${tutor.userId}`).expect(404);
    });
  });
});
