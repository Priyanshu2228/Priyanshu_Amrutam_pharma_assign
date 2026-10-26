import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: csv,

  DATABASE_URL: z.string().min(1),
  DATABASE_REPLICA_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().default('amrutam-api'),
  JWT_AUDIENCE: z.string().default('amrutam-clients'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),
  MFA_CHALLENGE_TTL_SEC: z.coerce.number().int().positive().default(300),
  MFA_REQUIRED_ROLES: csv,

  FIELD_ENCRYPTION_KEYS: z.string().min(1),
  AUDIT_HMAC_KEY: z.string().min(32, 'AUDIT_HMAC_KEY must be at least 32 chars'),

  PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),

  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),

  SLOT_HOLD_MINUTES: z.coerce.number().int().positive().default(10),
  REFUND_WINDOW_HOURS: z.coerce.number().nonnegative().default(2),

  OTEL_ENABLED: bool,
  OTEL_SERVICE_NAME: z.string().default('amrutam-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),

  DOCUMENT_STORAGE_DIR: z.string().default('./storage'),
});

export type Env = z.infer<typeof schema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  corsOrigins: string[];
  db: { url: string; replicaUrl?: string; poolMax: number; statementTimeoutMs: number };
  redisUrl: string;
  auth: {
    accessSecret: string;
    issuer: string;
    audience: string;
    accessTtlSec: number;
    refreshTtlSec: number;
    mfaChallengeTtlSec: number;
    mfaRequiredRoles: string[];
  };
  crypto: { fieldKeys: string; auditHmacKey: string };
  payments: { provider: Env['PAYMENT_PROVIDER']; webhookSecret: string };
  booking: { slotHoldMinutes: number; refundWindowHours: number };
  /** Multiplies every rate limit; raised in load tests and integration tests. */
  rateLimitScale: number;
  otel: { enabled: boolean; serviceName: string; endpoint: string };
  metricsToken?: string;
  storageDir: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS,
    db: {
      url: e.DATABASE_URL,
      replicaUrl: e.DATABASE_REPLICA_URL,
      poolMax: e.DB_POOL_MAX,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    },
    redisUrl: e.REDIS_URL,
    auth: {
      accessSecret: e.JWT_ACCESS_SECRET,
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      accessTtlSec: e.ACCESS_TOKEN_TTL_SEC,
      refreshTtlSec: e.REFRESH_TOKEN_TTL_SEC,
      mfaChallengeTtlSec: e.MFA_CHALLENGE_TTL_SEC,
      mfaRequiredRoles: e.MFA_REQUIRED_ROLES,
    },
    crypto: { fieldKeys: e.FIELD_ENCRYPTION_KEYS, auditHmacKey: e.AUDIT_HMAC_KEY },
    payments: { provider: e.PAYMENT_PROVIDER, webhookSecret: e.PAYMENT_WEBHOOK_SECRET },
    booking: { slotHoldMinutes: e.SLOT_HOLD_MINUTES, refundWindowHours: e.REFUND_WINDOW_HOURS },
    rateLimitScale: e.RATE_LIMIT_SCALE,
    otel: {
      enabled: e.OTEL_ENABLED,
      serviceName: e.OTEL_SERVICE_NAME,
      endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    metricsToken: e.METRICS_TOKEN,
    storageDir: e.DOCUMENT_STORAGE_DIR,
  };
}
