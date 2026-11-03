import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { DatabaseHealth } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { StorageService } from '../storage/storage.service';
import { LiveKitService } from '../../providers/livekit/livekit.service';

export type DependencyName = 'postgres' | 'redis' | 'minio' | 'livekit';

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'error';
  checks: Record<DependencyName, DependencyStatus>;
}

const CHECK_TIMEOUT_MS = 3_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function describeError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return describeError(err.errors[0]);
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const name = err.name && err.name !== 'Error' ? err.name : undefined;
    const parts = [name, typeof code === 'string' ? code : undefined, err.message];
    // fetch() hides the real reason (e.g. ECONNREFUSED) in `cause`.
    if (err.cause) parts.push(`caused by ${describeError(err.cause)}`);
    return parts.filter(Boolean).join(': ').slice(0, 300);
  }
  return 'unknown error';
}

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseHealth,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly livekit: LiveKitService,
  ) {}

  async check(): Promise<HealthReport> {
    const probes: Record<DependencyName, () => Promise<unknown>> = {
      postgres: () => this.database.ping(),
      redis: () => this.redis.ping(),
      minio: () => this.storage.ping(),
      livekit: () => this.livekit.ping(),
    };

    const entries = await Promise.all(
      (Object.keys(probes) as DependencyName[]).map(async (name) => {
        const started = performance.now();
        try {
          await withTimeout(probes[name](), CHECK_TIMEOUT_MS);
          return [name, { status: 'up', latencyMs: Math.round(performance.now() - started) }];
        } catch (err) {
          return [
            name,
            {
              status: 'down',
              latencyMs: Math.round(performance.now() - started),
              error: describeError(err),
            },
          ];
        }
      }),
    );

    const checks = Object.fromEntries(entries) as Record<DependencyName, DependencyStatus>;
    const allUp = Object.values(checks).every((c) => c.status === 'up');
    return { status: allUp ? 'ok' : 'error', checks };
  }
}
