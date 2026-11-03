import { Module } from '@nestjs/common';
import { BiddingModule } from '../modules/bidding/bidding.module';
import { ModerationModule } from '../modules/moderation/moderation.module';
import { RealtimeRouterModule } from '../modules/realtime/realtime.router';
import { PaymentsModule } from '../modules/payments/payments.module';
import { SessionsModule } from '../modules/sessions/sessions.module';
import { RecordingModule } from '../modules/recording/recording.service';
import { ReplayModule } from '../modules/replay/replay.service';
import { PoolingModule } from '../modules/pooling/pooling.service';
import { GroupBookingModule } from '../modules/group-booking/group-booking.service';
import { SettlementModule } from '../modules/settlement/settlement.service';
import { BookingProcessor, PaymentsProcessor } from './worker-processors';
import { QueueModule } from '../platform/queue/queue.module';
import { CoreModule } from './core.module';
import { WorkerRunner } from './worker-runner';

/** Background worker: outbox publishing, queue processors (payment expiry, webhooks) and sweeps. */
@Module({
  imports: [
    CoreModule,
    QueueModule,
    RealtimeRouterModule,
    BiddingModule,
    ModerationModule,
    SessionsModule,
    PaymentsModule,
    SettlementModule,
    RecordingModule,
    ReplayModule,
    PoolingModule,
    GroupBookingModule,
  ],
  providers: [WorkerRunner, BookingProcessor, PaymentsProcessor],
})
export class WorkerModule {}
