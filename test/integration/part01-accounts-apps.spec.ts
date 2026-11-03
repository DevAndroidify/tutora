import { eq } from 'drizzle-orm';
import { refreshTokens, users } from '../../src/modules/identity/identity.schema';
import { auditLog } from '../../src/platform/audit/audit.schema';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  registerMember,
  resetState,
  uniqueEmail,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 1: accounts and the three client apps', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(t);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('registration', () => {
    it.each(['student', 'tutor'] as const)(
      'registers a member from the %s app and never exposes the password hash',
      async (app) => {
        const email = uniqueEmail('Asha');
        const res = await t.http
          .post(`/${app}/auth/register`)
          .send({
            email: `  ${email.toUpperCase()} `,
            password: 'correct-horse-battery',
            fullName: ' Asha ',
          })
          .expect(201);

        expect(res.body).toMatchObject({
          user: {
            email: email.toLowerCase(),
            fullName: 'Asha',
            accountType: 'MEMBER',
            staffRole: null,
            status: 'ACTIVE',
          },
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
          accessTokenExpiresIn: 900,
          tokenType: 'Bearer',
        });
        expect(JSON.stringify(res.body)).not.toMatch(/password/i);

        const [row] = await t.db.select().from(users).where(eq(users.id, res.body.user.id));
        expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
      },
    );

    it('one email = one account: registering again in the other app returns 409', async () => {
      const s = await registerMember(t, 'student');
      const res = await t.http
        .post('/tutor/auth/register')
        .send({ email: s.email, password: 'another-password', fullName: 'X' })
        .expect(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('the admin app has no registration', async () => {
      await t.http
        .post('/admin/auth/register')
        .send({ email: uniqueEmail(), password: 'correct-horse-battery', fullName: 'X' })
        .expect(404);
    });

    it('validates input and rejects unknown fields such as a role', async () => {
      const res = await t.http
        .post('/student/auth/register')
        .send({ email: 'nope', password: 'short', fullName: '', staffRole: 'ADMIN' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.error.details.fields)).toEqual(
        expect.arrayContaining(['email', 'password', 'fullName', 'staffRole']),
      );
      expect(res.body.error.requestId).toMatch(/^req_/);
    });
  });

  describe('one account, separate apps', () => {
    it('a learner can sign in to the tutor app with the same account', async () => {
      const student = await registerMember(t, 'student', { fullName: 'Dual Role' });
      const tutorSession = await login(t, 'tutor', student);
      expect(tutorSession.userId).toBe(student.userId);

      const me = await t.http.get('/tutor/me').set(bearer(tutorSession)).expect(200);
      expect(me.body).toMatchObject({ id: student.userId, tutorProfile: null });
      await t.http.get('/student/me').set(bearer(student)).expect(200);
    });

    it('tokens only work in the app they were issued to', async () => {
      const student = await registerMember(t, 'student');
      const res = await t.http.get('/tutor/me').set(bearer(student)).expect(401);
      expect(res.body.error.code).toBe('TOKEN_APP_MISMATCH');
      await t.http.get('/admin/me').set(bearer(student)).expect(401);

      const tutor = await registerMember(t, 'tutor');
      expect((await t.http.get('/student/me').set(bearer(tutor)).expect(401)).body.error.code).toBe(
        'TOKEN_APP_MISMATCH',
      );
    });

    it('refresh tokens only refresh in their own app', async () => {
      const student = await registerMember(t, 'student');
      const res = await t.http
        .post('/tutor/auth/refresh')
        .send({ refreshToken: student.refreshToken })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
      // The student session is untouched by the failed cross-app attempt.
      await t.http
        .post('/student/auth/refresh')
        .send({ refreshToken: student.refreshToken })
        .expect(200);
    });

    it('members cannot sign in to the admin app, and staff cannot sign in to member apps', async () => {
      const member = await registerMember(t, 'student');
      const asAdmin = await t.http
        .post('/admin/auth/login')
        .send({ email: member.email, password: member.password })
        .expect(401);
      expect(asAdmin.body.error.code).toBe('INVALID_CREDENTIALS');

      const staff = await createStaff(t, 'ADMIN');
      for (const app of ['student', 'tutor']) {
        const res = await t.http
          .post(`/${app}/auth/login`)
          .send({ email: staff.email, password: staff.password })
          .expect(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      }
      const me = await t.http.get('/admin/me').set(bearer(staff)).expect(200);
      expect(me.body).toMatchObject({ accountType: 'STAFF', staffRole: 'ADMIN' });
    });

    it('suspended and banned accounts cannot sign in or use existing tokens', async () => {
      const s = await registerMember(t, 'student');
      await t.db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, s.userId));

      const loginRes = await t.http
        .post('/student/auth/login')
        .send({ email: s.email, password: s.password })
        .expect(403);
      expect(loginRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
      await t.http.get('/student/me').set(bearer(s)).expect(401);
      await t.http.post('/student/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);

      await t.db.update(users).set({ status: 'BANNED' }).where(eq(users.id, s.userId));
      const banned = await t.http
        .post('/student/auth/login')
        .send({ email: s.email, password: s.password })
        .expect(403);
      expect(banned.body.error.code).toBe('ACCOUNT_BANNED');
    });
  });

  describe('login and access tokens', () => {
    it('rejects a wrong password and an unknown email with the same error', async () => {
      const s = await registerMember(t);
      const wrong = await t.http
        .post('/student/auth/login')
        .send({ email: s.email, password: 'wrong-password' })
        .expect(401);
      const unknown = await t.http
        .post('/student/auth/login')
        .send({ email: uniqueEmail(), password: 'wrong-password' })
        .expect(401);
      expect(wrong.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(wrong.body.error.message).toBe(unknown.body.error.message);
    });

    it('requires a valid access token', async () => {
      expect((await t.http.get('/student/me').expect(401)).body.error.code).toBe('UNAUTHENTICATED');
      expect(
        (await t.http.get('/student/me').set('Authorization', 'Bearer not-a-jwt').expect(401)).body
          .error.code,
      ).toBe('INVALID_ACCESS_TOKEN');
    });

    it('access tokens expire after 15 minutes', async () => {
      const s = await registerMember(t);
      t.clock.advanceMinutes(14);
      await t.http.get('/student/me').set(bearer(s)).expect(200);
      t.clock.advanceMinutes(2);
      expect((await t.http.get('/student/me').set(bearer(s)).expect(401)).body.error.code).toBe(
        'INVALID_ACCESS_TOKEN',
      );
    });

    it('rate-limits login per app, IP and email', async () => {
      const s = await registerMember(t);
      for (let i = 0; i < t.config.env.LOGIN_RATE_LIMIT_MAX; i++) {
        await t.http
          .post('/student/auth/login')
          .send({ email: s.email, password: 'wrong-password' })
          .expect(401);
      }
      const blocked = await t.http
        .post('/student/auth/login')
        .send({ email: s.email, password: s.password })
        .expect(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // Another email is not locked out.
      const other = await registerMember(t);
      await login(t, 'student', other);
    });
  });

  describe('refresh and logout', () => {
    it('rotates refresh tokens and stores only hashes', async () => {
      const s = await registerMember(t);
      const first = await t.http
        .post('/student/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(200);
      expect(first.body.refreshToken).not.toBe(s.refreshToken);
      await t.http.get('/student/me').set(bearer(first.body)).expect(200);

      const stored = await t.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, s.userId));
      expect(stored).toHaveLength(2);
      expect(stored.every((r) => r.app === 'student' && r.tokenHash.length === 64)).toBe(true);
    });

    it('reusing an old refresh token revokes that whole family and is audited', async () => {
      const s = await registerMember(t);
      const rotated = await t.http
        .post('/student/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(200);

      const reuse = await t.http
        .post('/student/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      const victim = await t.http
        .post('/student/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);
      expect(victim.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, s.userId));
      expect(audits.map((a) => a.action)).toContain('auth.refresh_token_reuse_detected');
    });

    it('reuse in one app does not sign the user out of the other app', async () => {
      const s = await registerMember(t, 'student');
      const tutorSession = await login(t, 'tutor', s);

      await t.http.post('/student/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      await t.http.post('/student/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);

      await t.http
        .post('/tutor/auth/refresh')
        .send({ refreshToken: tutorSession.refreshToken })
        .expect(200);
    });

    it('rejects expired refresh tokens', async () => {
      const s = await registerMember(t);
      t.clock.advanceDays(t.config.env.REFRESH_TOKEN_TTL_DAYS + 1);
      const res = await t.http
        .post('/student/auth/refresh')
        .send({ refreshToken: s.refreshToken })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('logout revokes the session; unknown tokens still get 204', async () => {
      const s = await registerMember(t);
      await t.http.post('/student/auth/logout').send({ refreshToken: s.refreshToken }).expect(204);
      await t.http.post('/student/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
      await t.http
        .post('/student/auth/logout')
        .send({ refreshToken: 'x'.repeat(64) })
        .expect(204);
    });
  });
});
