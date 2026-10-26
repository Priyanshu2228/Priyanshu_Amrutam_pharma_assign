import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { TooManyRequestsError } from '../lib/errors';
import type { AppConfig } from '../config/env';
import type { Metrics } from '../telemetry/metrics';

interface LimiterSpec {
  name: string;
  points: number;
  durationSec: number;
  key: (req: Request) => string;
}

/**
 * Distributed rate limiting (Redis, shared by all API replicas). If Redis is unavailable
 * an in-memory "insurance" limiter takes over per instance, so protection degrades
 * gracefully instead of failing open or taking the API down.
 */
export function createRateLimiters({
  redis,
  metrics,
  config,
}: {
  redis: Redis;
  metrics: Metrics;
  config: AppConfig;
}) {
  const build = (spec: LimiterSpec): RequestHandler => {
    const points = Math.ceil(spec.points * config.rateLimitScale);
    const limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `rl:${spec.name}`,
      points,
      duration: spec.durationSec,
      insuranceLimiter: new RateLimiterMemory({ points, duration: spec.durationSec }),
    });
    return async (req, res, next) => {
      try {
        const r = await limiter.consume(spec.key(req));
        res.setHeader('RateLimit-Limit', points);
        res.setHeader('RateLimit-Remaining', r.remainingPoints);
        res.setHeader('RateLimit-Reset', Math.ceil(r.msBeforeNext / 1000));
        next();
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          const retryAfter = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
          metrics.rateLimited.inc({ limiter: spec.name });
          res.setHeader('Retry-After', retryAfter);
          throw new TooManyRequestsError(retryAfter);
        }
        throw err;
      }
    };
  };

  const ip = (req: Request) => req.ip ?? 'unknown';
  const user = (req: Request) => req.auth?.userId ?? ip(req);

  return {
    /** Coarse per-IP ceiling for the whole API. */
    global: build({ name: 'global', points: 600, durationSec: 60, key: ip }),
    /** Credential endpoints: slows brute force and credential stuffing per IP. */
    auth: build({ name: 'auth', points: 20, durationSec: 15 * 60, key: ip }),
    /** Booking writes per user: stops slot-hoarding bots. */
    booking: build({ name: 'booking', points: 20, durationSec: 60, key: user }),
    /** Authenticated writes per user. */
    writes: build({ name: 'writes', points: 120, durationSec: 60, key: user }),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
