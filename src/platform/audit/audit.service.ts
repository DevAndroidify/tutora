import { Global, Injectable, Module } from '@nestjs/common';
import { Clock } from '../clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../database/database.module';
import { auditLog } from './audit.schema';

export interface AuditEntry {
  actor: { id: string; role: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /**
   * Records an entry. Pass the open transaction so the entry commits with the decision it describes.
   */
  async record(entry: AuditEntry, tx: DbExecutor = this.db): Promise<void> {
    await tx.insert(auditLog).values({
      actorUserId: entry.actor?.id ?? null,
      actorRole: entry.actor?.role ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ?? {},
      requestId: entry.requestId ?? null,
      createdAt: this.clock.now(),
    });
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
