import { Module } from '@nestjs/common';
import { AdminAppModule } from '../apps/admin/admin-app.module';
import { PublicAppModule } from '../apps/public/public-app.module';
import { StudentAppModule } from '../apps/student/student-app.module';
import { TutorAppModule } from '../apps/tutor/tutor-app.module';
import { WebhooksAppModule } from '../apps/webhooks/webhooks-app.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { RealtimeGatewayModule } from '../modules/realtime/realtime.gateway';
import { HealthModule } from '../platform/health/health.controller';
import { QueueModule } from '../platform/queue/queue.module';
import { CoreModule } from './core.module';
import { MetricsModule } from '../platform/telemetry/metrics';

/**
 * One deployable API serving four API areas:
 *   /student/*  student app (members, learner side)
 *   /tutor/*    tutor app   (members, teacher side)
 *   /admin/*    admin app   (staff only)
 *   /public/*   unauthenticated browsing
 * Domain modules (src/modules/*) hold the data and rules; app modules only expose routes.
 */
@Module({
  imports: [
    CoreModule,
    // GET /metrics (Prometheus) and HTTP timing.
    MetricsModule,
    QueueModule,
    HealthModule,
    // Registers the global access-token and staff-role guards.
    IdentityModule,
    PublicAppModule,
    StudentAppModule,
    TutorAppModule,
    AdminAppModule,
    // POST /webhooks/:provider and the dev-only UPI simulator.
    WebhooksAppModule,
    // Socket.IO /realtime namespace (announces saved changes only).
    RealtimeGatewayModule,
  ],
})
export class ApiModule {}
