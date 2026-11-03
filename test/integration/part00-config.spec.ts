import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ConfigValidationError, parseEnv } from '../../src/platform/config/app-config';

const ROOT = resolve(__dirname, '../..');

const validEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'bucket',
  LIVEKIT_URL: 'http://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'secret',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('Part 0: configuration', () => {
  it('accepts valid settings and applies documented defaults', () => {
    const env = parseEnv(validEnv);
    expect(env.PAYMENT_WINDOW_MINUTES).toBe(15);
    expect(env.DISPUTE_WINDOW_HOURS).toBe(24);
    expect(env.NO_SHOW_GRACE_MINUTES).toBe(10);
    expect(env.POOL_MAX_SEATS).toBe(5);
    expect(env.RECHECK_DAYS).toBe(7);
    expect(env.MASTERY_K).toBe(10);
    expect(env.MASTERY_MIN_ATTEMPTS).toBe(10);
    expect(env.PLATFORM_FEE_BPS).toBe(1000);
    expect(env.EMBEDDING_DIM).toBe(1024);
    expect(env.HOLD_MODE).toBe('ledger_only');
    expect(env.UPI_PROVIDER).toBe('fake');
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it('lists every invalid or missing setting in one clear error', () => {
    const { DATABASE_URL: _omit, ...rest } = validEnv;
    let error: unknown;
    try {
      parseEnv({ ...rest, JWT_ACCESS_SECRET: 'short', UPI_PROVIDER: 'paypal' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigValidationError);
    const message = (error as Error).message;
    expect(message).toMatch(/^Invalid configuration/);
    expect(message).toContain('DATABASE_URL: is required');
    expect(message).toContain('JWT_ACCESS_SECRET: must be at least 32 characters');
    expect(message).toContain('UPI_PROVIDER');
  });

  it('stops the API process at startup with a clear message', () => {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/app/api.main.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TS_NODE_TRANSPILE_ONLY: 'true',
        JWT_ACCESS_SECRET: 'too-short',
        DATABASE_URL: 'not-a-url',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid configuration');
    expect(result.stderr).toContain('JWT_ACCESS_SECRET');
    expect(result.stderr).toContain('DATABASE_URL');
  });
});
