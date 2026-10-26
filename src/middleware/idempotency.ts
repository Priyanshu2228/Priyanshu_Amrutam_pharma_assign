import { createHash } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import type { Database } from '../db/database';
import { BadRequestError, ConflictError, UnprocessableError } from '../lib/errors';
import { canonicalJson } from '../modules/audit/audit.service';
import type { Metrics } from '../telemetry/metrics';
import { authUser } from './auth';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const LOCK_SECONDS = 30;
const RETENTION_HOURS = 24;

interface StoredKey {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
  lock_active: boolean;
}

/**
 * Idempotency-Key support for unsafe writes (Stripe-style semantics):
 *  - first request with a key executes and its response is stored for 24h;
 *  - a retry with the same key and same payload replays the stored response;
 *  - the same key with a different payload is rejected (422);
 *  - a retry while the original is still running gets 409 + Retry-After;
 *  - 5xx responses are not stored, so the client can safely retry them.
 *
 * Keys are scoped per user so one client cannot read another's stored response.
 */
export function createIdempotencyMiddleware({
  db,
  metrics,
  logger,
}: {
  db: Database;
  metrics: Metrics;
  logger: Logger;
}) {
  return function idempotent(): RequestHandler {
    return async (req, res, next) => {
      const key = req.header('Idempotency-Key');
      if (!key)
        throw new BadRequestError(
          'IDEMPOTENCY_KEY_REQUIRED',
          'Idempotency-Key header is required for this operation',
        );
      if (!KEY_PATTERN.test(key)) {
        throw new BadRequestError(
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]',
        );
      }
      const { userId } = authUser(req);
      const path = req.baseUrl + req.path;
      const requestHash = createHash('sha256')
        .update(`${req.method} ${path}\n${canonicalJson(req.body ?? null)}`)
        .digest('hex');

      const claimed = await db.query(
        `INSERT INTO idempotency_keys (user_id, idem_key, method, path, request_hash, status, locked_until, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'in_progress', now() + make_interval(secs => $6), now() + make_interval(hours => $7))
         ON CONFLICT (user_id, idem_key) DO UPDATE
            SET request_hash = EXCLUDED.request_hash, method = EXCLUDED.method, path = EXCLUDED.path,
                status = 'in_progress', response_status = NULL, response_body = NULL,
                locked_until = EXCLUDED.locked_until, expires_at = EXCLUDED.expires_at, created_at = now()
          WHERE idempotency_keys.expires_at < now()
         RETURNING idem_key`,
        [userId, key, req.method, path, requestHash, LOCK_SECONDS, RETENTION_HOURS],
      );

      if (claimed.rowCount === 0) {
        const { rows } = await db.query<StoredKey>(
          `SELECT request_hash, status, response_status, response_body, locked_until > now() AS lock_active
             FROM idempotency_keys WHERE user_id = $1 AND idem_key = $2`,
          [userId, key],
        );
        const existing = rows[0];
        if (!existing)
          throw new ConflictError('IDEMPOTENCY_IN_PROGRESS', 'Request is being processed, retry shortly');
        if (existing.request_hash !== requestHash) {
          throw new UnprocessableError(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used with a different request payload',
          );
        }
        if (existing.status === 'completed') {
          metrics.idempotentReplays.inc();
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(existing.response_status ?? 200).json(existing.response_body);
          return;
        }
        if (existing.lock_active) {
          res.setHeader('Retry-After', '1');
          throw new ConflictError('IDEMPOTENCY_IN_PROGRESS', 'Request is being processed, retry shortly');
        }
        // The original request died mid-flight (crash/timeout): take over its lock.
        const takeover = await db.query(
          `UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => $3)
            WHERE user_id = $1 AND idem_key = $2 AND status = 'in_progress' AND locked_until <= now()
            RETURNING idem_key`,
          [userId, key, LOCK_SECONDS],
        );
        if (takeover.rowCount === 0) {
          res.setHeader('Retry-After', '1');
          throw new ConflictError('IDEMPOTENCY_IN_PROGRESS', 'Request is being processed, retry shortly');
        }
      }

      // Persist the outcome BEFORE the response leaves, so an immediate retry always replays.
      const send = res.json.bind(res) as Response['json'];
      res.json = ((body: unknown) => {
        const finalize =
          res.statusCode >= 500
            ? db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND idem_key = $2', [userId, key])
            : db.query(
                `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4
                  WHERE user_id = $1 AND idem_key = $2`,
                [userId, key, res.statusCode, JSON.stringify(body ?? null)],
              );
        finalize
          .catch((err: unknown) => logger.error({ err }, 'failed to persist idempotency result'))
          .finally(() => send(body));
        return res;
      }) as Response['json'];

      next();
    };
  };
}

export type IdempotencyMiddleware = ReturnType<typeof createIdempotencyMiddleware>;
