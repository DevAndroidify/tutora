import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import request from 'supertest';
import { ApiModule } from '../../src/app/api.module';
import { configureApp } from '../../src/app/configure-app';
import { Clock, FakeClock } from '../../src/platform/clock/clock';
import { AppConfig, loadAppConfig, type Env } from '../../src/platform/config/app-config';
import { DRIZZLE, type Database } from '../../src/platform/database/database.module';
import { REDIS } from '../../src/platform/redis/redis.module';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { PasswordService } from '../../src/modules/identity/auth/password.service';
import type { MemberApp, StaffRole } from '../../src/modules/identity/identity.schema';
import { UsersService } from '../../src/modules/identity/users.service';

type TestAgent = ReturnType<typeof request>;

export interface TestApp {
  app: INestApplication;
  http: TestAgent;
  clock: FakeClock;
  db: Database;
  redis: Redis;
  config: AppConfig;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Replace raw settings, e.g. point a dependency at a dead port. */
  env?: Partial<Env>;
  /** Extra modules for test-only routes. */
  imports?: ModuleMetadata['imports'];
  /** Listen on a random port (needed for Socket.IO clients). */
  listen?: boolean;
  /** Replace providers, e.g. a payment gateway with a mocked SDK client. */
  overrides?: Array<{ provide: unknown; useValue: unknown }>;
}

/** Boots the real API module with the same HTTP pipeline as production and a controllable clock. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadAppConfig().with(options.env ?? {});
  const clock = new FakeClock(new Date());

  let builder = Test.createTestingModule({
    imports: [ApiModule, ...(options.imports ?? [])],
  })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(Clock)
    .useValue(clock);
  for (const o of options.overrides ?? []) {
    builder = builder.overrideProvider(o.provide as never).useValue(o.useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ rawBody: true, bufferLogs: true });
  configureApp(app);
  if (options.listen) {
    await app.listen(0, '127.0.0.1');
  } else {
    await app.init();
  }

  return {
    app,
    http: request(app.getHttpServer()),
    clock,
    db: app.get<Database>(DRIZZLE),
    redis: app.get<Redis>(REDIS),
    config,
    close: () => app.close(),
  };
}

/** Empties every application table and the test Redis DB. Keeps the migrations table. */
export async function resetState(t: TestApp): Promise<void> {
  const result = await t.db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = result.rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length > 0) {
    await t.db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));
  }
  await t.redis.flushdb();
}

let counter = 0;

export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}@example.test`;
}

export interface Session {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

const PASSWORD = 'correct-horse-battery';

/** Registers a member through an app's real endpoint and returns that app's tokens. */
export async function registerMember(
  t: TestApp,
  app: MemberApp = 'student',
  overrides: { email?: string; fullName?: string } = {},
): Promise<Session> {
  const email = overrides.email ?? uniqueEmail(app);
  const res = await t.http
    .post(`/${app}/auth/register`)
    .send({ email, password: PASSWORD, fullName: overrides.fullName ?? `Test ${app}` })
    .expect(201);
  return {
    userId: res.body.user.id,
    email,
    password: PASSWORD,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

/** Signs an existing account in to another app (e.g. a student opening the tutor app). */
export async function login(
  t: TestApp,
  app: 'student' | 'tutor' | 'admin',
  s: { email: string; password: string },
): Promise<Session> {
  const res = await t.http
    .post(`/${app}/auth/login`)
    .send({ email: s.email, password: s.password })
    .expect(200);
  return {
    userId: res.body.user.id,
    email: s.email,
    password: s.password,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

/** Staff can't self-register, so create one directly and sign in to the admin app. */
export async function createStaff(t: TestApp, staffRole: StaffRole = 'ADMIN'): Promise<Session> {
  const email = uniqueEmail(staffRole.toLowerCase());
  const password = 'staff-password-123';
  await t.app.get(UsersService).createStaff({
    email,
    passwordHash: await t.app.get(PasswordService).hash(password),
    fullName: `Test ${staffRole}`,
    staffRole,
  });
  return login(t, 'admin', { email, password });
}

export async function seedCatalog(t: TestApp): Promise<void> {
  await t.app.get(CatalogService).seed();
}

export async function skillId(t: TestApp, slug: string): Promise<string> {
  return (await t.app.get(CatalogService).getSkill(slug)).id;
}

export const bearer = (s: { accessToken: string }) => ({
  Authorization: `Bearer ${s.accessToken}`,
});
