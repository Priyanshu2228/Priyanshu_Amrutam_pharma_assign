import type { Cradle } from '../container';
import { createAuthMiddleware, type AuthMiddleware } from './auth';
import { createIdempotencyMiddleware, type IdempotencyMiddleware } from './idempotency';
import { createRateLimiters, type RateLimiters } from './rate-limit';

export interface Middleware {
  auth: AuthMiddleware;
  idempotent: IdempotencyMiddleware;
  limit: RateLimiters;
}

export function buildMiddleware(c: Cradle): Middleware {
  return {
    auth: createAuthMiddleware(c),
    idempotent: createIdempotencyMiddleware(c),
    limit: createRateLimiters(c),
  };
}
