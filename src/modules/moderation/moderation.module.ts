import { Module } from '@nestjs/common';
import {
  RuleBasedScreeningProvider,
  ScreeningProvider,
} from '../../providers/screening/screening.provider';
import { IdentityModule } from '../identity/identity.module';
import { ModerationService } from './moderation.service';

/** Trust & safety: screening, reports, cases, actions and sanctions. */
@Module({
  imports: [IdentityModule],
  providers: [
    ModerationService,
    { provide: ScreeningProvider, useClass: RuleBasedScreeningProvider },
  ],
  exports: [ModerationService, ScreeningProvider],
})
export class ModerationModule {}
