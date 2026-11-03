import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  PAYMENTS_QUEUE,
  PROCESS_WEBHOOK_JOB,
  PaymentsService,
} from '../modules/payments/payments.service';
import {
  BOOKING_QUEUE,
  BookingService,
  PAYMENT_EXPIRY_JOB,
} from '../modules/sessions/booking.service';

/** Delayed payment-window expiry. The minute sweep covers anything this misses. */
@Processor(BOOKING_QUEUE)
export class BookingProcessor extends WorkerHost {
  constructor(private readonly booking: BookingService) {
    super();
  }

  async process(job: Job<{ participantId: string }>): Promise<boolean> {
    if (job.name !== PAYMENT_EXPIRY_JOB) return false;
    return this.booking.expireParticipant(job.data.participantId);
  }
}

/** Saved webhooks are processed here, so the HTTP handler can answer within Razorpay's 5 seconds. */
@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost {
  constructor(private readonly payments: PaymentsService) {
    super();
  }

  async process(job: Job<{ webhookEventId: number }>): Promise<void> {
    if (job.name !== PROCESS_WEBHOOK_JOB) return;
    await this.payments.processWebhookEvent(job.data.webhookEventId);
  }
}
