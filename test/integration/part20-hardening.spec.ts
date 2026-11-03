import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AdminAppModule } from '../../src/apps/admin/admin-app.module';
import { PublicAppModule } from '../../src/apps/public/public-app.module';
import { StudentAppModule } from '../../src/apps/student/student-app.module';
import { TutorAppModule } from '../../src/apps/tutor/tutor-app.module';
import { WebhooksAppModule } from '../../src/apps/webhooks/webhooks-app.module';
import { acceptedBooking } from '../fixtures/booking';
import { bearer, createTestApp, resetState, seedCatalog, type TestApp } from '../fixtures/test-app';

describe('Part 20: metrics and security', () => {
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

  it('exposes Prometheus metrics at /metrics', async () => {
    const b = await acceptedBooking(t, 2);
    await t.http.post(`/student/bids/${b.bidIds[1]}/accept`).set(bearer(b.student)).expect(409); // a prevented double booking
    const res = await t.http.get('/metrics').expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'tutora_http_request_duration_seconds_bucket',
      'tutora_acceptance_conflicts_prevented_total 1',
      'tutora_bid_delivery_p95_seconds',
      'tutora_reconciliation_mismatches 0',
      'tutora_session_completion_ratio',
      'tutora_tutor_no_show_rate',
      'tutora_low_bandwidth_share',
      'tutora_pool_invite_acceptance_ratio',
      'tutora_quiz_pass_rate',
      'tutora_process_resident_memory_bytes',
    ]) {
      expect(res.text).toContain(name);
    }
  });

  it('can protect /metrics with a token', async () => {
    const locked = await createTestApp({ env: { METRICS_TOKEN: 'metrics-token-for-tests' } });
    try {
      await locked.http.get('/metrics').expect(401);
      await locked.http
        .get('/metrics')
        .set('Authorization', 'Bearer metrics-token-for-tests')
        .expect(200);
    } finally {
      await locked.close();
    }
  });

  it('sends security headers and no CORS grant to unknown origins', async () => {
    const res = await t.http.get('/health').set('Origin', 'https://evil.example').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('every non-public route refuses requests without a token', async () => {
    const PUBLIC = [
      /^\/health/,
      /^\/public\//,
      /^\/webhooks\//,
      /^\/dev\//,
      /^\/(student|tutor|admin)\/auth\//,
    ];
    const id = '00000000-0000-4000-8000-000000000000';
    const checked: string[] = [];
    const failures: string[] = [];
    for (const include of [
      StudentAppModule,
      TutorAppModule,
      AdminAppModule,
      PublicAppModule,
      WebhooksAppModule,
    ]) {
      const doc = SwaggerModule.createDocument(t.app, new DocumentBuilder().build(), {
        include: [include],
      });
      for (const [path, ops] of Object.entries(doc.paths)) {
        const url = path.replace(/\{[^}]+\}/g, id);
        if (PUBLIC.some((p) => p.test(path))) continue;
        for (const method of Object.keys(ops as object)) {
          const res = await (
            t.http as unknown as Record<string, (u: string) => Promise<{ status: number }>>
          )[method]!(url);
          checked.push(`${method.toUpperCase()} ${path}`);
          if (res.status !== 401) failures.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked.length).toBeGreaterThan(60);
  });
});
