import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BiddingModule } from '../bidding/bidding.module';
import { RequestsModule } from '../requests/requests.module';
import { BOOKING_QUEUE, BookingService } from './booking.service';

@Module({
  imports: [RequestsModule, BiddingModule, BullModule.registerQueue({ name: BOOKING_QUEUE })],
  providers: [BookingService],
  exports: [BookingService],
})
export class SessionsModule {}
