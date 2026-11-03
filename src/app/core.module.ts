import { Module } from '@nestjs/common';
import { AuditModule } from '../platform/audit/audit.service';
import { ClockModule } from '../platform/clock/clock';
import { ConfigModule } from '../platform/config/config.module';
import { DatabaseModule } from '../platform/database/database.module';
import { IdempotencyModule } from '../platform/idempotency/idempotency.interceptor';
import { OutboxModule } from '../platform/outbox/outbox.service';
import { RateLimitModule } from '../platform/rate-limit/rate-limit';
import { RedisModule } from '../platform/redis/redis.module';
import { StorageModule } from '../platform/storage/storage.service';
import { UploadsModule } from '../platform/storage/uploads.service';
import { LoggingModule } from '../platform/telemetry/logging.module';
import { LiveKitModule } from '../providers/livekit/livekit.service';

/** Shared infrastructure used by both the API and the worker. */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ClockModule,
    DatabaseModule,
    RedisModule,
    StorageModule,
    UploadsModule,
    LiveKitModule,
    AuditModule,
    OutboxModule,
    IdempotencyModule,
    RateLimitModule,
  ],
})
export class CoreModule {}
