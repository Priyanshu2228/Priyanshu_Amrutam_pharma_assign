import pino, { type Logger } from 'pino';
import { trace } from '@opentelemetry/api';
import type { AppConfig } from '../config/env';
import { requestContext } from './context';

/**
 * Paths that must never reach log storage. PHI and credentials are redacted at the
 * logger so that a careless `logger.info({ body })` cannot leak them.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.mfaCode',
  '*.secret',
  '*.phone',
  '*.reason',
  '*.diagnosis',
  '*.medications',
  '*.notes',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'env'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'amrutam-api', env: config.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
    // Correlate every log line with the active trace and request.
    mixin() {
      const span = trace.getActiveSpan();
      const ctx = requestContext.get();
      return {
        ...(span ? { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId } : {}),
        ...(ctx ? { requestId: ctx.requestId, actorId: ctx.actorId } : {}),
      };
    },
  });
}
