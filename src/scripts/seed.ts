import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from '../app/core.module';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { CatalogService } from '../modules/catalog/catalog.service';
import { MasteryModule, MasteryService } from '../modules/mastery/mastery.service';
import { IdentityModule } from '../modules/identity/identity.module';
import { IdentitySeeder } from '../modules/identity/identity.seeder';
import { StorageService } from '../platform/storage/storage.service';

@Module({ imports: [CoreModule, IdentityModule, CatalogModule, MasteryModule] })
class SeedModule {}

/** Idempotent: creates the storage bucket, the first staff admin and the starter skill catalog. */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn'] });
  try {
    await app.get(StorageService).ensureBucket();
    console.log('Storage bucket ready.');
    console.log(`Admin: ${await app.get(IdentitySeeder).seedAdmin()}`);
    const catalog = await app.get(CatalogService).seed();
    console.log(
      `Catalog: ${catalog.categories} categories, ${catalog.skills} skills, ${catalog.topics} topics`,
    );
    console.log(`Quiz questions: ${await app.get(MasteryService).seedQuestions()}`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
