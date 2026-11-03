import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { AppConfig } from '../config/app-config';
import { Clock } from '../clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../database/database.module';
import { outboxEvents, type OutboxEventRow } from './outbox.schema';

export interface OutboxEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Delivers one event. Throwing makes the publisher retry it later. */
export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  /** Adds an event inside the caller's transaction, so it exists only if the change commits. */
  async add(tx: DbExecutor, eventType: string, payload: Record<string, unknown>): Promise<void> {
    const now = this.clock.now();
    await tx.insert(outboxEvents).values({ eventType, payload, createdAt: now, availableAt: now });
  }

  /**
   * Publishes up to `limit` pending events in order. Rows are locked with SKIP LOCKED so
   * several workers can run safely. Failed events back off exponentially; after
   * OUTBOX_MAX_ATTEMPTS they are parked (dead_at) and logged.
   */
  async publishPending(handler: OutboxHandler, limit = 100): Promise<number> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.publishedAt),
            isNull(outboxEvents.deadAt),
            lte(outboxEvents.availableAt, now),
          ),
        )
        .orderBy(asc(outboxEvents.id))
        .limit(limit)
        .for('update', { skipLocked: true });

      let published = 0;
      for (const row of rows) {
        try {
          await handler(toEvent(row));
          await tx
            .update(outboxEvents)
            .set({ publishedAt: now, attempts: row.attempts + 1, lastError: null })
            .where(eq(outboxEvents.id, row.id));
          published++;
        } catch (err) {
          const attempts = row.attempts + 1;
          const dead = attempts >= this.config.env.OUTBOX_MAX_ATTEMPTS;
          const backoffMs = Math.min(2 ** attempts * 1000, 5 * 60_000);
          await tx
            .update(outboxEvents)
            .set({
              attempts,
              lastError: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
              availableAt: new Date(now.getTime() + backoffMs),
              deadAt: dead ? now : null,
            })
            .where(eq(outboxEvents.id, row.id));
          if (dead)
            this.logger.error({ eventId: row.id, err }, 'Outbox event parked after max attempts');
        }
      }
      return published;
    });
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(and(isNull(outboxEvents.publishedAt), isNull(outboxEvents.deadAt)));
    return row?.n ?? 0;
  }
}

function toEvent(row: OutboxEventRow): OutboxEvent {
  return {
    id: row.id,
    type: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
