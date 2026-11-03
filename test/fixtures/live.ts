import { createHash, randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { BookingService } from '../../src/modules/sessions/booking.service';
import { acceptedBooking, processWebhooks, startPayment, type Booked } from './booking';
import { login, type Session, type TestApp } from './test-app';

export interface PaidSession extends Booked {
  tutor: Session;
  paymentId: string;
}

/** Accepted bid, paid with the fake UPI gateway: session SCHEDULED, money HELD. */
export async function paidSession(t: TestApp, bidCount = 1): Promise<PaidSession> {
  const b = await acceptedBooking(t, bidCount);
  const started = await startPayment(t, b);
  await t.http
    .post(`/dev/fake-upi/orders/${started.body.providerOrderId}/pay`)
    .send({})
    .expect(200);
  await processWebhooks(t);
  return { ...b, tutor: b.tutors[0]!, paymentId: started.body.id };
}

/** Moves the fake clock to the session start (+ offset minutes). */
export async function goToStart(t: TestApp, s: Booked, offsetMinutes = 0): Promise<void> {
  const session = await t.app.get(BookingService).getSession(s.sessionId);
  t.clock.set(new Date(session!.startsAt.getTime() + offsetMinutes * 60_000));
}

/** Fresh tokens after moving the clock (access tokens expire after 15 minutes). */
export async function relogin(t: TestApp, s: PaidSession): Promise<PaidSession> {
  return {
    ...s,
    student: await login(t, 'student', s.student),
    tutor: await login(t, 'tutor', s.tutor),
  };
}

/** Builds a LiveKit webhook exactly as LiveKit signs it: JWT with the body's sha256 in Authorization. */
export async function livekitWebhook(
  t: TestApp,
  event: Record<string, unknown>,
  secret = t.config.livekit.apiSecret,
): Promise<{ body: string; auth: string }> {
  const body = JSON.stringify({
    id: `EV_${randomUUID()}`,
    createdAt: String(Math.floor(t.clock.nowMs() / 1000)),
    ...event,
  });
  const at = new AccessToken(t.config.livekit.apiKey, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return { body, auth: await at.toJwt() };
}

export async function sendLivekit(t: TestApp, event: Record<string, unknown>, expectStatus = 200) {
  const hook = await livekitWebhook(t, event);
  return t.http
    .post('/webhooks/livekit')
    .set('Content-Type', 'application/webhook+json')
    .set('Authorization', hook.auth)
    .send(hook.body)
    .expect(expectStatus);
}

export const joined = (
  sessionId: string,
  identity: string,
  extra: Record<string, unknown> = {},
) => ({
  event: 'participant_joined',
  room: { name: `session-${sessionId}` },
  participant: { identity },
  ...extra,
});
export const left = (sessionId: string, identity: string, extra: Record<string, unknown> = {}) => ({
  event: 'participant_left',
  room: { name: `session-${sessionId}` },
  participant: { identity },
  ...extra,
});
export const finished = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  event: 'room_finished',
  room: { name: `session-${sessionId}` },
  ...extra,
});
