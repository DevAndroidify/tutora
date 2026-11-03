import { OutboxService } from '../../src/platform/outbox/outbox.service';
import { RealtimeRouter } from '../../src/modules/realtime/realtime.router';
import {
  bearer,
  createStaff,
  registerMember,
  skillId,
  type Session,
  type TestApp,
} from './test-app';

/** Registers a tutor, gets the profile verified and the given skills approved through the real APIs. */
export async function approvedTutor(
  t: TestApp,
  slugs: string[] = ['technical-analysis'],
  fullName = 'Approved Tutor',
  admin?: Session,
): Promise<Session> {
  const staff = admin ?? (await createStaff(t));
  const tutor = await registerMember(t, 'tutor', { fullName });
  await t.http
    .put('/tutor/profile')
    .set(bearer(tutor))
    .send({
      bio: 'I have taught this subject to hundreds of learners over many years.',
      payoutUpiId: 'tutor@okaxis',
    })
    .expect(200);
  for (const slug of slugs) {
    await t.http
      .put(`/tutor/skills/${await skillId(t, slug)}`)
      .set(bearer(tutor))
      .send({
        summary: 'Structured lessons with practice problems.',
        evidenceLinks: ['https://example.com/cv'],
      })
      .expect(200);
  }
  await t.http.post('/tutor/profile/verification').set(bearer(tutor)).expect(200);
  await t.http
    .post(`/admin/tutors/${tutor.userId}/verification/approve`)
    .set(bearer(staff))
    .send({ badge: 'VERIFIED' })
    .expect(200);
  for (const slug of slugs) {
    await t.http
      .post(`/admin/tutors/${tutor.userId}/skills/${await skillId(t, slug)}/approve`)
      .set(bearer(staff))
      .expect(200);
  }
  return tutor;
}

/** Creates and publishes a learning request; returns its id. */
export async function openRequest(
  t: TestApp,
  student: Session,
  slug = 'technical-analysis',
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await t.http
    .post('/student/requests')
    .set(bearer(student))
    .send({
      skillId: await skillId(t, slug),
      level: 'BEGINNER',
      title: 'Help me read candlestick charts',
      description: 'I keep misreading reversal patterns on daily charts.',
      ...overrides,
    })
    .expect(201);
  await t.http.post(`/student/requests/${res.body.id}/publish`).set(bearer(student)).expect(200);
  return res.body.id;
}

export function bidBody(t: TestApp, overrides: Record<string, unknown> = {}) {
  return {
    seatPricePaise: 49900,
    proposedStartAt: new Date(t.clock.nowMs() + 2 * 3_600_000).toISOString(),
    durationMinutes: 60,
    approachText: 'We will walk through 10 real charts together.',
    ...overrides,
  };
}

/** Delivers pending outbox events like the worker does. Requires RealtimeRouterModule in the app. */
export async function publishOutbox(t: TestApp): Promise<number> {
  const router = t.app.get(RealtimeRouter);
  return t.app.get(OutboxService).publishPending((e) => router.handle(e));
}
