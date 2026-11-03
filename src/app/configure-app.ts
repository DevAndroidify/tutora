import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AdminAppModule } from '../apps/admin/admin-app.module';
import { PublicAppModule } from '../apps/public/public-app.module';
import { StudentAppModule } from '../apps/student/student-app.module';
import { TutorAppModule } from '../apps/tutor/tutor-app.module';
import { WebhooksAppModule } from '../apps/webhooks/webhooks-app.module';
import { AppConfig } from '../platform/config/app-config';
import { AllExceptionsFilter } from '../platform/errors/all-exceptions.filter';
import { createValidationPipe } from '../platform/errors/validation';
import { HealthModule } from '../platform/health/health.controller';
import { RedisIoAdapter } from '../modules/realtime/realtime.gateway';

/** One OpenAPI document per client app, so each frontend team sees only its own API. */
const API_DOCS = [
  {
    path: 'docs/student',
    title: 'Tutora Student API',
    description: 'Learner app. Tokens from /student/auth only work on /student routes.',
    include: [StudentAppModule, PublicAppModule],
  },
  {
    path: 'docs/tutor',
    title: 'Tutora Tutor API',
    description: 'Tutor app. Tokens from /tutor/auth only work on /tutor routes.',
    include: [TutorAppModule, PublicAppModule],
  },
  {
    path: 'docs/admin',
    title: 'Tutora Admin API',
    description: 'Staff portal. Staff accounts only.',
    include: [AdminAppModule],
  },
  {
    path: 'docs/public',
    title: 'Tutora Public API',
    description: 'Unauthenticated catalog and tutor browsing, plus health.',
    include: [PublicAppModule, HealthModule, WebhooksAppModule],
  },
];

/**
 * Applies global HTTP settings. Shared by api.main.ts and the integration tests
 * so tests exercise the same pipeline as production.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  const express = app as NestExpressApplication;

  app.useLogger(app.get(Logger));
  express.disable('x-powered-by');
  // Security headers. CSP is relaxed only for the dev pages and Swagger UI outside production.
  express.use(
    helmet({
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Only listed frontend origins may call the API from a browser.
  const origins = config.env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: false, maxAge: 600 });
  express.set('trust proxy', config.env.TRUST_PROXY);
  // LiveKit posts webhooks as application/webhook+json; the raw body is kept for signature checks.
  express.useBodyParser('json', {
    limit: '1mb',
    type: ['application/json', 'application/webhook+json'],
  });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  if (!config.isProduction) {
    for (const doc of API_DOCS) {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle(doc.title)
          .setDescription(doc.description)
          .setVersion('0.2.0')
          .addBearerAuth()
          .build(),
        { include: doc.include },
      );
      SwaggerModule.setup(doc.path, app, document);
    }
  }
}
