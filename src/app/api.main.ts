// Must stay first: instruments libraries before they load.
import '../platform/telemetry/tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfig, ConfigValidationError, loadAppConfig } from '../platform/config/app-config';
import { ApiModule } from './api.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  // Validate settings before anything else so bad config fails fast with a clear message.
  loadAppConfig();

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    rawBody: true,
    bufferLogs: true,
  });
  configureApp(app);

  const config = app.get(AppConfig);
  await app.listen(config.env.PORT);
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigValidationError) {
    console.error(err.message);
  } else {
    console.error('API failed to start:', err);
  }
  process.exit(1);
});
