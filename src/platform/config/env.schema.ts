import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: nonNegativeInt.max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: bool,

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_FORCE_PATH_STYLE: bool,

    LIVEKIT_URL: z.url(),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: positiveInt.default(900),
    REFRESH_TOKEN_TTL_DAYS: positiveInt.default(30),
    LOGIN_RATE_LIMIT_MAX: positiveInt.default(5),
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(900),
    IDEMPOTENCY_TTL_HOURS: positiveInt.default(24),

    ADMIN_EMAIL: z.email().optional(),
    ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
    ADMIN_FULL_NAME: z.string().min(1).default('Platform Admin'),

    REQUEST_TTL_HOURS: positiveInt.default(72),
    UPLOAD_MAX_BYTES: positiveInt.default(10 * 1024 * 1024),
    UPLOAD_URL_TTL_SECONDS: positiveInt.default(300),
    POSTING_RATE_LIMIT_MAX: positiveInt.default(20),
    POSTING_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(3600),
    BIDDING_RATE_LIMIT_MAX: positiveInt.default(60),
    BIDDING_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(3600),
    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
    OUTBOX_MAX_ATTEMPTS: positiveInt.default(10),
    SESSION_JOIN_EARLY_MINUTES: positiveInt.default(15),
    SESSION_TOKEN_TTL_SECONDS: positiveInt.default(600),
    RECORDING_RETENTION_DAYS: positiveInt.default(30),
    /** S3 endpoint as seen from the LiveKit Egress container (Docker service name locally). */
    RECORDING_S3_ENDPOINT: z.url().default('http://minio:9000'),
    QUIZ_QUESTIONS: positiveInt.default(5),
    QUIZ_PASS_PERCENT: positiveInt.max(100).default(60),
    WHITEBOARD_SNAPSHOT_LIMIT: positiveInt.default(50),
    /** Cosine similarity needed for two requests to be pooled (0-1). */
    POOL_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    POOL_INVITE_TTL_HOURS: positiveInt.default(24),
    /** How long pool members have to pay once the first member accepts an offer. */
    POOL_PAYMENT_WINDOW_MINUTES: positiveInt.default(60),
    /** Optional bearer token required by GET /metrics (Part 20). */
    METRICS_TOKEN: z.string().min(16).optional(),
    OTEL_ENABLED: bool,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    CORS_ORIGINS: z.string().default(''),

    PAYMENT_WINDOW_MINUTES: positiveInt.default(15),
    DISPUTE_WINDOW_HOURS: positiveInt.default(24),
    NO_SHOW_GRACE_MINUTES: positiveInt.default(10),
    POOL_MAX_SEATS: positiveInt.default(5),
    RECHECK_DAYS: positiveInt.default(7),
    MASTERY_K: positiveInt.default(10),
    MASTERY_MIN_ATTEMPTS: positiveInt.default(10),
    PLATFORM_FEE_BPS: nonNegativeInt.max(10000).default(1000),
    /** Must match the vector(1024) column; changing it needs a migration. */
    EMBEDDING_DIM: positiveInt
      .refine((n) => n === 1024, 'must be 1024 (matches the request_embeddings column)')
      .default(1024),
    HOLD_MODE: z.enum(['ledger_only', 'razorpay_route']).default('ledger_only'),
    UPI_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),

    /** Signs webhooks from the local fake UPI gateway. Dev/test only. */
    FAKE_UPI_WEBHOOK_SECRET: z.string().min(16).default('fake-upi-dev-webhook-secret'),
    /** Razorpay TEST MODE keys only. Live keys (rzp_live_) are refused at startup. */
    RAZORPAY_KEY_ID: z
      .string()
      .regex(
        /^rzp_test_[A-Za-z0-9]+$/,
        'must be a Razorpay TEST key (rzp_test_...). Live keys are not allowed.',
      )
      .optional(),
    RAZORPAY_KEY_SECRET: z.string().min(8).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(8).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.UPI_PROVIDER === 'razorpay') {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when UPI_PROVIDER=razorpay',
          });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
