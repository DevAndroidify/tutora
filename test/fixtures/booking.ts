import { eq } from 'drizzle-orm';
import { paymentWebhookEvents } from '../../src/modules/payments/payments.schema';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { approvedTutor, bidBody, openRequest } from './marketplace';
import { bearer, createStaff, registerMember, type Session, type TestApp } from './test-app';

export interface Booked {
  student: Session;
  tutors: Session[];
  requestId: string;
  bidIds: string[];
  participantId: string;
  sessionId: string;
  amountPaise: number;
}

/** A request with `bidCount` bids; the first bid (₹499) is accepted. */
export async function acceptedBooking(t: TestApp, bidCount = 2): Promise<Booked> {
  const admin = await createStaff(t);
  const student = await registerMember(t, 'student');
  const requestId = await openRequest(t, student);
  const tutors: Session[] = [];
  const bidIds: string[] = [];
  for (let i = 0; i < bidCount; i++) {
    const tutor = await approvedTutor(t, ['technical-analysis'], `Tutor ${i}`, admin);
    tutors.push(tutor);
    const res = await t.http
      .post(`/tutor/requests/${requestId}/bids`)
      .set(bearer(tutor))
      .send(bidBody(t, { seatPricePaise: 49900 + i * 1000 }))
      .expect(201);
    bidIds.push(res.body.id);
  }
  const accepted = await t.http
    .post(`/student/bids/${bidIds[0]}/accept`)
    .set(bearer(student))
    .expect(201);
  return {
    student,
    tutors,
    requestId,
    bidIds,
    participantId: accepted.body.participantId,
    sessionId: accepted.body.sessionId,
    amountPaise: accepted.body.amountPaise,
  };
}

/** Starts a payment through the real endpoint (with an Idempotency-Key). */
export async function startPayment(t: TestApp, b: Booked, key = `pay-${b.participantId}`) {
  return t.http
    .post(`/student/participants/${b.participantId}/payments`)
    .set(bearer(b.student))
    .set('Idempotency-Key', key)
    .expect(201);
}

/** Processes every saved, unprocessed webhook like the worker does. */
export async function processWebhooks(t: TestApp): Promise<void> {
  const payments = t.app.get(PaymentsService);
  const rows = await t.db
    .select({ id: paymentWebhookEvents.id })
    .from(paymentWebhookEvents)
    .where(eq(paymentWebhookEvents.status, 'RECEIVED'));
  for (const r of rows) await payments.processWebhookEvent(r.id);
}
