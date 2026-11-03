import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';

/** Skill taxonomy. Controllers live in the client apps (src/apps/*). */
@Module({
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
