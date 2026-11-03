import { eq } from 'drizzle-orm';
import { IdentitySeeder } from '../../src/modules/identity/identity.seeder';
import { UsersService } from '../../src/modules/identity/users.service';
import { hashRequest } from '../../src/platform/idempotency/idempotency.interceptor';
import { idempotencyKeys } from '../../src/platform/idempotency/idempotency.schema';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  registerMember,
  resetState,
  type TestApp,
} from '../fixtures/test-app';
import { TestRoutesModule, testRouteCalls } from '../fixtures/test-routes.module';

describe('Part 1: staff roles, ownership, idempotency and admin seed', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [TestRoutesModule] });
  });

  beforeEach(async () => {
    await resetState(t);
    testRouteCalls.charge = 0;
    testRouteCalls.failOnce = 0;
  });

  afterAll(async () => {
    await t.close();
  });

  describe('staff roles', () => {
    it('returns 403 for a staff role without permission', async () => {
      const moderator = await createStaff(t, 'MODERATOR');
      const res = await t.http
        .get('/admin/tutors/profile-reviews')
        .set(bearer(moderator))
        .expect(403);
      expect(res.body.error).toMatchObject({
        code: 'FORBIDDEN_ROLE',
        details: { requiredRoles: ['ADMIN'] },
      });
    });

    it('lets ADMIN through', async () => {
      const admin = await createStaff(t, 'ADMIN');
      await t.http.get('/admin/tutors/profile-reviews').set(bearer(admin)).expect(200);
    });
  });

  describe('ownership helper', () => {
    it('allows the owner and staff in the admin app, and returns 403 for anyone else', async () => {
      const owner = await registerMember(t);
      const stranger = await registerMember(t);
      const admin = await createStaff(t);

      await t.http
        .post('/student/__test__/owned')
        .set(bearer(owner))
        .send({ ownerId: owner.userId })
        .expect(201);
      await t.http
        .post('/admin/__test__/owned')
        .set(bearer(admin))
        .send({ ownerId: owner.userId })
        .expect(201);
      const res = await t.http
        .post('/student/__test__/owned')
        .set(bearer(stranger))
        .send({ ownerId: owner.userId })
        .expect(403);
      expect(res.body.error.code).toBe('NOT_OWNER');
    });
  });

  describe('idempotency interceptor', () => {
    const charge = (s: { accessToken: string }, key: string | null, body: object) => {
      const req = t.http.post('/student/__test__/charges').set(bearer(s));
      if (key) req.set('Idempotency-Key', key);
      return req.send(body);
    };

    it('requires an Idempotency-Key header', async () => {
      const s = await registerMember(t);
      const res = await charge(s, null, { amountPaise: 50000, note: 'x' }).expect(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('replays the first response for the same key and body without re-running the handler', async () => {
      const s = await registerMember(t);
      const first = await charge(s, 'charge-key-0001', { note: 'a', amountPaise: 50000 }).expect(
        201,
      );
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      // Same body with keys in another order counts as the same request.
      const second = await charge(s, 'charge-key-0001', { amountPaise: 50000, note: 'a' }).expect(
        201,
      );
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(testRouteCalls.charge).toBe(1);
    });

    it('returns 409 when a key is reused with a different body', async () => {
      const s = await registerMember(t);
      await charge(s, 'charge-key-0003', { amountPaise: 50000, note: 'x' }).expect(201);
      const res = await charge(s, 'charge-key-0003', { amountPaise: 99999, note: 'x' }).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(testRouteCalls.charge).toBe(1);
    });

    it('scopes keys per user', async () => {
      const a = await registerMember(t);
      const b = await registerMember(t);
      const ra = await charge(a, 'shared-key-0004', { amountPaise: 1, note: 'x' }).expect(201);
      const rb = await charge(b, 'shared-key-0004', { amountPaise: 1, note: 'x' }).expect(201);
      expect([ra.body.userId, rb.body.userId]).toEqual([a.userId, b.userId]);
      expect(testRouteCalls.charge).toBe(2);
    });

    it('returns 409 while the first request with a key is still running', async () => {
      const s = await registerMember(t);
      const now = t.clock.now();
      await t.db.insert(idempotencyKeys).values({
        scope: s.userId,
        key: 'in-flight-0005',
        method: 'POST',
        path: '/student/__test__/charges',
        requestHash: hashRequest('POST', '/student/__test__/charges', {
          amountPaise: 1,
          note: 'x',
        }),
        status: 'IN_PROGRESS',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
      const res = await charge(s, 'in-flight-0005', { amountPaise: 1, note: 'x' }).expect(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    });

    it('releases the key when the handler fails so the client can retry', async () => {
      const s = await registerMember(t);
      const send = () =>
        t.http
          .post('/student/__test__/fail-once')
          .set(bearer(s))
          .set('Idempotency-Key', 'retry-key-0006')
          .send({});
      await send().expect(409);
      expect((await send().expect(201)).body).toEqual({ attempt: 2 });
    });

    it('lets an expired key be used for a fresh request', async () => {
      const s = await registerMember(t);
      await charge(s, 'expiring-key-0007', { amountPaise: 1, note: 'x' }).expect(201);
      t.clock.advanceHours(t.config.env.IDEMPOTENCY_TTL_HOURS + 1);
      const fresh = await login(t, 'student', s);
      const res = await charge(fresh, 'expiring-key-0007', { amountPaise: 2, note: 'y' }).expect(
        201,
      );
      expect(res.body.chargeNo).toBe(2);
      const rows = await t.db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, 'expiring-key-0007'));
      expect(rows).toHaveLength(1);
    });
  });

  describe('admin seed', () => {
    it('creates one staff ADMIN from settings and is safe to run twice', async () => {
      const seeder = t.app.get(IdentitySeeder);
      expect(await seeder.seedAdmin()).toBe('created');
      expect(await seeder.seedAdmin()).toBe('exists');

      const admin = await t.app.get(UsersService).findByEmail(t.config.env.ADMIN_EMAIL!);
      expect(admin).toMatchObject({ accountType: 'STAFF', staffRole: 'ADMIN' });

      const session = await login(t, 'admin', {
        email: t.config.env.ADMIN_EMAIL!,
        password: t.config.env.ADMIN_PASSWORD!,
      });
      await t.http.get('/admin/me').set(bearer(session)).expect(200);
    });
  });
});
