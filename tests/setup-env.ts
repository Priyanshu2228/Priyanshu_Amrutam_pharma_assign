import os from 'node:os';
import path from 'node:path';

// Tests must never touch a developer database: the test URLs are forced, not defaulted.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://amrutam:amrutam@localhost:5432/amrutam_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.DATABASE_REPLICA_URL = '';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0123456789';
process.env.FIELD_ENCRYPTION_KEYS = 'test1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.AUDIT_HMAC_KEY = 'test-audit-hmac-key-test-audit-hmac-key-0123';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret-0123';
process.env.MFA_REQUIRED_ROLES = 'doctor,admin';
process.env.RATE_LIMIT_SCALE = '1000';
process.env.OTEL_ENABLED = 'false';
process.env.METRICS_TOKEN = '';
process.env.CORS_ORIGINS = '';
process.env.DOCUMENT_STORAGE_DIR = path.join(os.tmpdir(), 'amrutam-test-storage');
