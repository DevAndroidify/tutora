import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { ModerationModule } from '../moderation/moderation.module';
import { TutorsService } from './tutors.service';
import { VerifiedTutorGuard } from './verified-tutor.guard';

/** Tutor profiles and skill approvals. Controllers live in the client apps (src/apps/*). */
@Module({
  imports: [IdentityModule, CatalogModule, ModerationModule],
  providers: [TutorsService, VerifiedTutorGuard],
  exports: [TutorsService, VerifiedTutorGuard],
})
export class TutorsModule {}
