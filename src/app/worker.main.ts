// Must stay first: instruments libraries before they load.
import '../platform/telemetry/tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ConfigValidationError, loadAppConfig } from '../platform/config/app-config';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadAppConfig();

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('Worker started');
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigValidationError) {
    console.error(err.message);
  } else {
    console.error('Worker failed to start:', err);
  }
  process.exit(1);
});
