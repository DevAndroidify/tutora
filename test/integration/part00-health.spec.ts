import { createTestApp, type TestApp } from '../fixtures/test-app';
import type { Env } from '../../src/platform/config/app-config';

describe('Part 0: GET /health', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('returns 200 when PostgreSQL, Redis, MinIO and LiveKit are up', async () => {
    const res = await t.http.get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    for (const dep of ['postgres', 'redis', 'minio', 'livekit']) {
      expect(res.body.checks[dep]).toMatchObject({ status: 'up' });
    }
  });

  it('sets a request id header and reuses a well-formed incoming one', async () => {
    const generated = await t.http.get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);

    const echoed = await t.http.get('/health').set('X-Request-Id', 'client-trace-12345');
    expect(echoed.headers['x-request-id']).toBe('client-trace-12345');
  });

  it('returns the standard error shape with the request id for unknown routes', async () => {
    const res = await t.http.get('/no-such-route').expect(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.any(String),
        details: {},
        requestId: res.headers['x-request-id'],
      },
    });
  });
});

describe('Part 0: GET /health with a stopped dependency', () => {
  const DEAD = '127.0.0.1:1';
  const cases: Array<[string, Partial<Env>]> = [
    ['postgres', { DATABASE_URL: `postgres://tutora:tutora@${DEAD}/tutora_test` }],
    ['redis', { REDIS_URL: `redis://${DEAD}/1` }],
    ['minio', { S3_ENDPOINT: `http://${DEAD}` }],
    ['livekit', { LIVEKIT_URL: `http://${DEAD}` }],
  ];

  it.each(cases)('returns 503 and identifies %s', async (name, env) => {
    const t = await createTestApp({ env });
    try {
      const res = await t.http.get('/health').expect(503);
      expect(res.body.status).toBe('error');
      expect(res.body.checks[name]).toMatchObject({ status: 'down', error: expect.any(String) });
      const others = Object.entries(res.body.checks).filter(([dep]) => dep !== name);
      for (const [, check] of others) {
        expect(check).toMatchObject({ status: 'up' });
      }
    } finally {
      await t.close();
    }
  });
});
