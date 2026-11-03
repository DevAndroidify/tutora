import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { ModerationModule } from '../moderation/moderation.module';
import { RequestsService } from './requests.service';

/** Learning requests (formerly "doubts") and their attachments. */
@Module({
  imports: [IdentityModule, CatalogModule, ModerationModule],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
