import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { envSchema, type Env } from './env.schema';

export type { Env };

export class ConfigValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration. Fix these settings and restart:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Typed, validated application settings. Injected everywhere by its class token.
 */
export class AppConfig {
  constructor(readonly env: Env) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  get database() {
    return { url: this.env.DATABASE_URL };
  }

  get redis() {
    return { url: this.env.REDIS_URL };
  }

  get storage() {
    return {
      endpoint: this.env.S3_ENDPOINT,
      region: this.env.S3_REGION,
      accessKeyId: this.env.S3_ACCESS_KEY_ID,
      secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
      bucket: this.env.S3_BUCKET,
      forcePathStyle: this.env.S3_FORCE_PATH_STYLE,
    };
  }

  get livekit() {
    return {
      url: this.env.LIVEKIT_URL,
      apiKey: this.env.LIVEKIT_API_KEY,
      apiSecret: this.env.LIVEKIT_API_SECRET,
    };
  }

  get auth() {
    return {
      accessSecret: this.env.JWT_ACCESS_SECRET,
      accessTtlSeconds: this.env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
      loginRateLimitMax: this.env.LOGIN_RATE_LIMIT_MAX,
      loginRateLimitWindowSeconds: this.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    };
  }

  /** Returns a copy with some raw settings replaced. Useful in tests. */
  with(overrides: Partial<Env>): AppConfig {
    return new AppConfig({ ...this.env, ...overrides });
  }
}

/**
 * Validates raw settings. Throws ConfigValidationError listing every problem.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      const reason =
        issue.code === 'invalid_type' && raw[key] === undefined ? 'is required' : issue.message;
      return `${key}: ${reason}`;
    });
    throw new ConfigValidationError(issues);
  }
  return result.data;
}

let dotenvLoaded = false;

/**
 * Loads `.env.test` when NODE_ENV=test, otherwise `.env`. Real environment variables win.
 */
export function loadEnvFiles(cwd = process.cwd()): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const file = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
  const path = resolve(cwd, file);
  if (existsSync(path)) {
    loadDotenv({ path, quiet: true, override: false });
  }
}

export function loadAppConfig(raw: Record<string, string | undefined> = process.env): AppConfig {
  loadEnvFiles();
  return new AppConfig(parseEnv(raw));
}
