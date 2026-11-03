import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { RequestsModule } from '../requests/requests.module';
import { TutorsModule } from '../tutors/tutors.module';
import { MasteryModule } from '../mastery/mastery.service';
import { BiddingService } from './bidding.service';

@Module({
  imports: [RequestsModule, TutorsModule, ModerationModule, MasteryModule],
  providers: [BiddingService],
  exports: [BiddingService],
})
export class BiddingModule {}
