/**
 * Creates data for the k6 load tests against a running API (default http://localhost:3000) and writes
 * k6/data/fixture.json. Uses only public HTTP endpoints plus the seeded admin. Test data only.
 *
 *   yarn load:setup && yarn load:run
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAppConfig } from '../src/platform/config/app-config';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const TUTORS = Number(process.env.LOAD_TUTORS ?? 20);
const CREATE_REQUESTS = Number(process.env.LOAD_CREATE_REQUESTS ?? 15);
const ACCEPT_REQUESTS = Number(process.env.LOAD_ACCEPT_REQUESTS ?? 20);
const BIDS_PER_ACCEPT_REQUEST = 5;
const WEBHOOKS = Number(process.env.LOAD_WEBHOOKS ?? 500);

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const run = Date.now().toString(36);
const startAt = () => new Date(Date.now() + 3 * 3_600_000).toISOString();

async function main(): Promise<void> {
  const config = loadAppConfig();
  const admin = (
    await call<{ accessToken: string }>('POST', '/admin/auth/login', undefined, {
      email: config.env.ADMIN_EMAIL,
      password: config.env.ADMIN_PASSWORD,
    })
  ).accessToken;
  const skill = (await call<{ id: string }>('GET', '/public/skills/technical-analysis')).id;

  console.log(`Creating ${TUTORS} verified tutors...`);
  const tutors: string[] = [];
  for (let i = 0; i < TUTORS; i++) {
    const t = await call<{ accessToken: string; user: { id: string } }>(
      'POST',
      '/tutor/auth/register',
      undefined,
      {
        email: `load.tutor.${run}.${i}@example.test`,
        password: 'load-test-password',
        fullName: `Load Tutor ${i}`,
      },
    );
    await call('PUT', '/tutor/profile', t.accessToken, {
      bio: 'Load-test tutor teaching charting and risk management for beginners.',
      payoutUpiId: 'load.tutor@okaxis',
    });
    await call('PUT', `/tutor/skills/${skill}`, t.accessToken, {
      summary: 'Candlesticks and risk management.',
      evidenceLinks: ['https://example.com/cv'],
    });
    await call('POST', '/tutor/profile/verification', t.accessToken);
    await call('POST', `/admin/tutors/${t.user.id}/verification/approve`, admin, {
      badge: 'VERIFIED',
    });
    await call('POST', `/admin/tutors/${t.user.id}/skills/${skill}/approve`, admin);
    tutors.push(t.accessToken);
  }

  const openRequest = async (i: number, tag: string) => {
    const s = await call<{ accessToken: string }>('POST', '/student/auth/register', undefined, {
      email: `load.student.${tag}.${run}.${i}@example.test`,
      password: 'load-test-password',
      fullName: `Load Student ${tag} ${i}`,
    });
    const r = await call<{ id: string }>('POST', '/student/requests', s.accessToken, {
      skillId: skill,
      level: 'BEGINNER',
      title: `Load test request ${tag} ${i}`,
      description: 'Generated for load testing. Help me read candlestick charts.',
    });
    await call('POST', `/student/requests/${r.id}/publish`, s.accessToken);
    return { studentToken: s.accessToken, requestId: r.id };
  };

  console.log(`Creating ${CREATE_REQUESTS} requests for bid creation...`);
  const createRequests: string[] = [];
  for (let i = 0; i < CREATE_REQUESTS; i++)
    createRequests.push((await openRequest(i, 'create')).requestId);

  console.log(
    `Creating ${ACCEPT_REQUESTS} requests with ${BIDS_PER_ACCEPT_REQUEST} bids each for bid acceptance...`,
  );
  const acceptTargets: Array<{ studentToken: string; bidIds: string[] }> = [];
  for (let i = 0; i < ACCEPT_REQUESTS; i++) {
    const r = await openRequest(i, 'accept');
    const bidIds: string[] = [];
    for (let b = 0; b < BIDS_PER_ACCEPT_REQUEST; b++) {
      const bid = await call<{ id: string }>(
        'POST',
        `/tutor/requests/${r.requestId}/bids`,
        tutors[(i + b) % tutors.length],
        {
          seatPricePaise: 30000 + b * 1000,
          proposedStartAt: startAt(),
          durationMinutes: 60,
          approachText: 'Load-test bid.',
        },
      );
      bidIds.push(bid.id);
    }
    acceptTargets.push({ studentToken: r.studentToken, bidIds });
  }

  console.log(`Signing ${WEBHOOKS} fake-gateway webhooks...`);
  const webhooks = Array.from({ length: WEBHOOKS }, (_, i) => {
    const body = JSON.stringify({
      id: `evt_load_${run}_${i}`,
      event: 'payment.captured',
      payment: {
        providerPaymentId: `pay_load_${randomUUID()}`,
        providerOrderId: `order_load_${run}_${i}`,
        amountPaise: 49900,
        currency: 'INR',
        status: 'captured',
      },
    });
    return {
      body,
      eventId: `evt_load_${run}_${i}`,
      signature: createHmac('sha256', config.env.FAKE_UPI_WEBHOOK_SECRET)
        .update(body)
        .digest('hex'),
    };
  });

  const out = resolve(process.cwd(), 'k6/data');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    resolve(out, 'fixture.json'),
    JSON.stringify(
      { baseUrl: BASE, tutors, createRequests, acceptTargets, webhooks, startAt: startAt() },
      null,
      2,
    ),
  );
  console.log(
    `Wrote k6/data/fixture.json (${tutors.length} tutors, ${createRequests.length} + ${acceptTargets.length} requests, ${webhooks.length} webhooks).`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
