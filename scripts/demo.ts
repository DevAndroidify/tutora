/**
 * End-to-end demo against a running API and worker (yarn dev:all), using test data only:
 * registration -> tutor verification -> request -> sealed bids -> accept -> UPI (simulator) ->
 * live session (signed LiveKit webhooks) -> quiz + review -> payment release -> payout -> report.
 *
 * The 24-hour dispute window is not waited out: the demo releases through the admin endpoint,
 * which is the same ledger posting the worker's release sweep makes.
 *   yarn demo
 */
import { createHash } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { loadAppConfig } from '../src/platform/config/app-config';

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';
const run = Date.now().toString(36);
const config = loadAppConfig();
const rupees = (p: number) => `Rs ${(p / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (n: number, text: string) => console.log(`\n[${n}] ${text}`);

// The demo reads many response shapes; loose typing keeps it short.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call<T = any>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Acts as LiveKit: signs a webhook with the dev API key, like the real server does. */
async function livekit(event: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({
    id: `EV_demo_${Math.random().toString(36).slice(2)}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    ...event,
  });
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  await fetch(`${BASE}/webhooks/livekit`, {
    method: 'POST',
    headers: { 'content-type': 'application/webhook+json', authorization: await at.toJwt() },
    body,
  });
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what} (is the worker running?)`);
    await sleep(300);
  }
}

async function main(): Promise<void> {
  const admin = (
    await call('POST', '/admin/auth/login', undefined, {
      email: config.env.ADMIN_EMAIL,
      password: config.env.ADMIN_PASSWORD,
    })
  ).accessToken;
  const skill = await call('GET', '/public/skills/technical-analysis');

  step(1, 'Tutor registers, lists a skill with evidence, and is verified by an admin');
  const tutor = await call('POST', '/tutor/auth/register', undefined, {
    email: `demo.tutor.${run}@example.test`,
    password: 'demo-password-123',
    fullName: 'Meera Iyer',
  });
  await call('PUT', '/tutor/profile', tutor.accessToken, {
    headline: 'Price-action educator',
    bio: 'Eight years teaching charting and risk management to beginners.',
    payoutUpiId: 'meera@okicici',
  });
  await call('PUT', `/tutor/skills/${skill.id}`, tutor.accessToken, {
    summary: 'Candlesticks, trends and position sizing; no stock tips.',
    evidenceLinks: ['https://example.com/nism-certificate'],
  });
  await call('POST', '/tutor/profile/verification', tutor.accessToken);
  await call('POST', `/admin/tutors/${tutor.user.id}/verification/approve`, admin, {
    badge: 'VERIFIED',
  });
  await call('POST', `/admin/tutors/${tutor.user.id}/skills/${skill.id}/approve`, admin);
  console.log(`    ${tutor.user.fullName} verified for "${skill.name}"`);

  step(2, 'Learner registers and posts a request (contact details are hidden automatically)');
  const student = await call('POST', '/student/auth/register', undefined, {
    email: `demo.student.${run}@example.test`,
    password: 'demo-password-123',
    fullName: 'Arjun Rao',
  });
  const req = await call('POST', '/student/requests', student.accessToken, {
    skillId: skill.id,
    level: 'BEGINNER',
    title: 'How do I read reversal candles?',
    description: 'I keep misreading hammers. Call me on 9876543210.',
  });
  await call('POST', `/student/requests/${req.id}/publish`, student.accessToken);
  console.log(`    Stored description: "${req.description}"`);

  step(3, 'Tutor places a sealed bid; the learner accepts it');
  const bid = await call('POST', `/tutor/requests/${req.id}/bids`, tutor.accessToken, {
    seatPricePaise: 49900,
    proposedStartAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    durationMinutes: 60,
    approachText: 'We will read 10 real charts together.',
  });
  const ranked = await call('GET', `/student/requests/${req.id}/bids`, student.accessToken);
  console.log(
    `    Learner sees ${ranked.length} bid(s): ${rupees(ranked[0].seatPricePaise)}, score ${ranked[0].score.total}`,
  );
  const booking = await call('POST', `/student/bids/${bid.id}/accept`, student.accessToken);
  console.log(`    Reserved. Pay by ${booking.paymentDueAt}`);

  step(4, 'Learner pays with UPI (local simulator; Razorpay test mode works the same way)');
  const order = await call(
    'POST',
    `/student/participants/${booking.participantId}/payments`,
    student.accessToken,
    undefined,
    { 'Idempotency-Key': `demo-${booking.participantId}` },
  );
  await call('POST', `/dev/fake-upi/orders/${order.providerOrderId}/pay`, undefined, {});
  await until('payment HELD', async () =>
    (await call('GET', `/student/payments/${order.id}`, student.accessToken)).status === 'HELD'
      ? true
      : undefined,
  );
  console.log(`    Payment ${order.id.slice(0, 8)} is HELD; session SCHEDULED`);

  step(5, 'Live session: LiveKit reports joins and the room finishing');
  await livekit({
    event: 'participant_joined',
    room: { name: `session-${booking.sessionId}` },
    participant: { identity: `tutor:${tutor.user.id}` },
  });
  await livekit({
    event: 'participant_joined',
    room: { name: `session-${booking.sessionId}` },
    participant: { identity: `student:${student.user.id}` },
  });
  await livekit({ event: 'room_finished', room: { name: `session-${booking.sessionId}` } });
  const sessions = await call('GET', '/student/sessions', student.accessToken);
  console.log(`    Session ${sessions[0].sessionStatus}, learner ${sessions[0].participantStatus}`);

  step(6, 'Learner takes the exit quiz and reviews the tutor');
  const [quiz] = await call('GET', '/student/quizzes', student.accessToken);
  const result = await call('POST', `/student/quizzes/${quiz.id}/submit`, student.accessToken, {
    answers: quiz.questions.map(() => 1),
  });
  await call('POST', `/student/sessions/${booking.sessionId}/review`, student.accessToken, {
    rating: 5,
    comment: 'Clear and patient.',
  });
  console.log(
    `    Quiz ${result.result.correct}/${result.result.total} (${result.result.passed ? 'passed' : 'not passed'}); review 5/5`,
  );

  step(7, 'Held money is released to the tutor (minus the platform fee) and a payout is recorded');
  await call('POST', `/admin/payments/${order.id}/release`, admin, {
    note: 'Demo: releasing without waiting 24 hours.',
  });
  const earnings = await call('GET', '/tutor/earnings', tutor.accessToken);
  console.log(
    `    Tutor available: ${rupees(earnings.availablePaise)} (fee ${earnings.platformFeeBps / 100}%)`,
  );
  await call('POST', '/admin/payouts', admin, {
    tutorUserId: tutor.user.id,
    amountPaise: earnings.availablePaise,
    reference: `UTRDEMO${run.toUpperCase()}`,
  });

  step(8, 'Report');
  const balances = await call('GET', '/admin/ledger/balances', admin);
  for (const b of balances) {
    if (b.code.startsWith('tutor_payable:') && b.code !== `tutor_payable:${tutor.user.id}`)
      continue;
    console.log(`    ${b.code.padEnd(52)} ${rupees(b.balancePaise).padStart(14)}`);
  }
  const rec = await call('GET', '/admin/reconciliation', admin);
  console.log(
    `    Reconciliation: ${rec.ok ? 'OK' : 'MISMATCH'} (${rec.paymentsChecked} payments, ${rec.providerChecked} checked with provider, ${rec.mismatches.length} mismatches)`,
  );
  const profile = await call('GET', `/public/tutors/${tutor.user.id}`);
  console.log(
    `    Public profile: rating ${profile.rating.average} (${profile.rating.count}), mastery "${profile.skills[0].mastery.label}"`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
