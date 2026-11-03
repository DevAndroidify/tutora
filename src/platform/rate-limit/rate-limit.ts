import {
  applyDecorators,
  UseGuards,
  CanActivate,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { AppConfig } from '../config/app-config';
import { AppError } from '../errors/app-error';
import type { AppRequest } from '../http/request-context';
import { InjectRedis } from '../redis/redis.module';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter in Redis. Losing Redis data only resets counters.
 */
@Injectable()
export class RateLimitService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async consume(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const key = `ratelimit:${bucket}`;
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX')
      .ttl(key)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }

  async reset(bucket: string): Promise<void> {
    await this.redis.del(`ratelimit:${bucket}`);
  }
}

/** Named policies. Posting and bidding are per signed-in user (route-level guards run after auth). */
export type RateLimitPolicyName = 'login' | 'posting' | 'bidding';

interface RateLimitPolicy {
  limit: (config: AppConfig) => number;
  windowSeconds: (config: AppConfig) => number;
  /** Builds the counter key. Combine IP with the target identity so one attacker can't lock out a user. */
  key: (req: AppRequest) => string;
}

function bodyField(req: AppRequest, field: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[field];
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 320) : '';
}

const POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> = {
  login: {
    limit: (c) => c.env.LOGIN_RATE_LIMIT_MAX,
    windowSeconds: (c) => c.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    key: (req) =>
      `login:${req.baseUrl}${req.path}:${req.ip ?? 'unknown'}:${bodyField(req, 'email')}`,
  },
  posting: {
    limit: (c) => c.env.POSTING_RATE_LIMIT_MAX,
    windowSeconds: (c) => c.env.POSTING_RATE_LIMIT_WINDOW_SECONDS,
    key: (req) => `posting:${req.user?.id ?? req.ip ?? 'unknown'}`,
  },
  bidding: {
    limit: (c) => c.env.BIDDING_RATE_LIMIT_MAX,
    windowSeconds: (c) => c.env.BIDDING_RATE_LIMIT_WINDOW_SECONDS,
    key: (req) => `bidding:${req.user?.id ?? req.ip ?? 'unknown'}`,
  },
};

const RATE_LIMIT_KEY = 'route:rateLimit';

/** Applies a named Redis-backed rate limit to a route. Returns 429 RATE_LIMITED when exceeded. */
export const RateLimit = (policy: RateLimitPolicyName): MethodDecorator =>
  applyDecorators(SetMetadata(RATE_LIMIT_KEY, policy), UseGuards(RateLimitGuard));

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const name = this.reflector.get<RateLimitPolicyName | undefined>(
      RATE_LIMIT_KEY,
      ctx.getHandler(),
    );
    if (!name) return true;

    const policy = POLICIES[name];
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const result = await this.limiter.consume(
      policy.key(req),
      policy.limit(this.config),
      policy.windowSeconds(this.config),
    );
    if (!result.allowed) {
      ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', result.retryAfterSeconds);
      throw AppError.tooManyRequests('RATE_LIMITED', 'Too many attempts. Try again later.', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    return true;
  }
}

@Global()
@Module({
  providers: [RateLimitService, RateLimitGuard],
  exports: [RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
