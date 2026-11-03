import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either the root database handle or an open transaction. */
export type DbExecutor = Database | Transaction;

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

/** Injects the Drizzle database handle. */
export const InjectDb = (): ParameterDecorator => Inject(DRIZZLE);

export function createPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  });
}

@Injectable()
export class DatabaseHealth {
  constructor(@InjectDb() private readonly db: Database) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const pool = createPool(config.database.url);
        // Idle client errors (e.g. database restart) must not crash the process.
        pool.on('error', () => undefined);
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
    DatabaseHealth,
    PoolCloser,
  ],
  exports: [DRIZZLE, PG_POOL, DatabaseHealth],
})
export class DatabaseModule {}
