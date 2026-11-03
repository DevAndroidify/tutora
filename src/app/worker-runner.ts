import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppConfig } from '../platform/config/app-config';
import { OutboxService } from '../platform/outbox/outbox.service';
import { BiddingService } from '../modules/bidding/bidding.service';
import { ModerationService } from '../modules/moderation/moderation.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { BookingService } from '../modules/sessions/booking.service';
import { RecordingService } from '../modules/recording/recording.service';
import { SettlementService } from '../modules/settlement/settlement.service';
import { ReplayService } from '../modules/replay/replay.service';
import { PoolingService } from '../modules/pooling/pooling.service';
import { GroupBookingService } from '../modules/group-booking/group-booking.service';
import type { OutboxEvent } from '../platform/outbox/outbox.service';
import { RealtimeRouter } from '../modules/realtime/realtime.router';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Background loops:
 * - outbox publisher (every OUTBOX_POLL_INTERVAL_MS), delivers saved events to sockets and notifications;
 * - sweeps (every minute): expire learning requests and their bids, lift ended sanctions.
 * All state lives in PostgreSQL, so a restart loses nothing; every loop is idempotent.
 */
@Injectable()
export class WorkerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRunner.name);
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly outbox: OutboxService,
    private readonly router: RealtimeRouter,
    private readonly bidding: BiddingService,
    private readonly moderation: ModerationService,
    private readonly booking: BookingService,
    private readonly payments: PaymentsService,
    private readonly settlement: SettlementService,
    private readonly recording: RecordingService,
    private readonly replay: ReplayService,
    private readonly pooling: PoolingService,
    private readonly groups: GroupBookingService,
  ) {}

  /** Every outbox event goes to each consumer; all of them are idempotent, so retries are safe. */
  private async dispatch(event: OutboxEvent): Promise<void> {
    await this.router.handle(event);
    await this.replay.onEvent(event);
    await this.pooling.onEvent(event);
  }

  onApplicationBootstrap(): void {
    this.every('outbox', this.config.env.OUTBOX_POLL_INTERVAL_MS, () =>
      this.outbox.publishPending((e) => this.dispatch(e)),
    );
    this.every('expire-requests', SWEEP_INTERVAL_MS, () => this.bidding.expireDueRequests());
    this.every('lift-sanctions', SWEEP_INTERVAL_MS, () => this.moderation.sweepExpiredSanctions());
    // Safety nets for delayed jobs and missed webhooks.
    this.every('payment-expiry', SWEEP_INTERVAL_MS, () => this.booking.sweepExpiredPayments());
    this.every('payments', SWEEP_INTERVAL_MS, () => this.payments.sweep());
    this.every('release-holds', SWEEP_INTERVAL_MS, () => this.settlement.releaseDue());
    this.every('tutor-no-shows', SWEEP_INTERVAL_MS, () => this.settlement.processNoShows());
    this.every('route-holds', SWEEP_INTERVAL_MS, () => this.settlement.ensureRouteHolds());
    this.every('recording-retention', SWEEP_INTERVAL_MS, () => this.recording.sweepRetention());
    this.every('replay', SWEEP_INTERVAL_MS, () => this.replay.sweep());
    this.every('pooling', SWEEP_INTERVAL_MS, () => this.pooling.sweep());
    this.every('group-deadlines', SWEEP_INTERVAL_MS, () => this.groups.sweep());
  }

  onApplicationShutdown(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Runs `job` on an interval, never overlapping itself, logging failures. */
  private every(name: string, ms: number, job: () => Promise<unknown>): void {
    const tick = async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (err) {
        this.logger.error({ err, job: name }, `Worker job ${name} failed`);
      } finally {
        this.running.delete(name);
      }
    };
    void tick();
    this.timers.push(setInterval(() => void tick(), ms));
  }
}
