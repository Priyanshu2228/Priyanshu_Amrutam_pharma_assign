import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Metrics } from '../telemetry/metrics';

/**
 * Cache-aside over Redis with:
 *  - namespace versioning: `bump(ns)` invalidates every key in a namespace in O(1)
 *    (old keys simply age out via TTL), avoiding SCAN/DEL storms;
 *  - in-process single-flight so a hot miss triggers one loader call per instance;
 *  - fail-open: Redis errors degrade to a direct load, never to a failed request.
 */
export class CacheService {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor({ redis, logger, metrics }: { redis: Redis; logger: Logger; metrics: Metrics }) {
    this.redis = redis;
    this.logger = logger;
    this.metrics = metrics;
  }

  private async version(namespace: string): Promise<string> {
    return (await this.redis.get(`cache:ver:${namespace}`)) ?? '0';
  }

  async wrap<T>(namespace: string, key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    let fullKey: string;
    try {
      fullKey = `cache:${namespace}:v${await this.version(namespace)}:${key}`;
      const hit = await this.redis.get(fullKey);
      if (hit !== null) {
        this.metrics.cacheRequests.inc({ namespace: namespaceLabel(namespace), result: 'hit' });
        return JSON.parse(hit) as T;
      }
    } catch (err) {
      this.logger.warn({ err, namespace }, 'cache read failed; loading from source');
      this.metrics.cacheRequests.inc({ namespace: namespaceLabel(namespace), result: 'error' });
      return load();
    }

    this.metrics.cacheRequests.inc({ namespace: namespaceLabel(namespace), result: 'miss' });
    const existing = this.inflight.get(fullKey) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = (async () => {
      const value = await load();
      this.redis.set(fullKey, JSON.stringify(value), 'EX', ttlSec).catch((err: unknown) => {
        this.logger.warn({ err, namespace }, 'cache write failed');
      });
      return value;
    })().finally(() => this.inflight.delete(fullKey));
    this.inflight.set(fullKey, promise);
    return promise;
  }

  async bump(namespace: string): Promise<void> {
    try {
      const key = `cache:ver:${namespace}`;
      await this.redis
        .multi()
        .incr(key)
        .expire(key, 7 * 24 * 3600)
        .exec();
    } catch (err) {
      // TTLs bound the staleness window even if invalidation is lost.
      this.logger.warn({ err, namespace }, 'cache invalidation failed');
    }
  }
}

/** Keep metric label cardinality bounded: `slots:<uuid>` -> `slots`. */
function namespaceLabel(namespace: string): string {
  return namespace.split(':')[0] ?? namespace;
}
