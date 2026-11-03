import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/app-config';

export const REDIS = Symbol('REDIS');

/** Injects the shared ioredis client. Redis only holds data that can be rebuilt. */
export const InjectRedis = (): ParameterDecorator => Inject(REDIS);

export function createRedis(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 3_000,
    // Bounds shutdown when the server is unreachable (the default waits 2s for a socket that is already gone).
    disconnectTimeout: 500,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  // Connection errors are reported by /health; keep them from crashing the process.
  client.on('error', () => undefined);
  return client;
}

@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createRedis(config.redis.url),
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class RedisModule {}
