import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env';

/**
 * Access tokens are stateless JWTs with a short TTL. To make logout and suspension take
 * effect immediately, we keep a small denylist in Redis whose entries only need to live
 * as long as an access token can.
 */
export class SessionGuard {
  private readonly redis: Redis;
  private readonly ttl: number;

  constructor({ redis, config }: { redis: Redis; config: AppConfig }) {
    this.redis = redis;
    this.ttl = config.auth.accessTtlSec;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.redis.set(`auth:revoked-session:${sessionId}`, '1', 'EX', this.ttl);
  }

  async blockUser(userId: string): Promise<void> {
    await this.redis.set(`auth:blocked-user:${userId}`, '1', 'EX', this.ttl);
  }

  async unblockUser(userId: string): Promise<void> {
    await this.redis.del(`auth:blocked-user:${userId}`);
  }

  async isBlocked(userId: string, sessionId: string): Promise<boolean> {
    const hits = await this.redis.exists(`auth:blocked-user:${userId}`, `auth:revoked-session:${sessionId}`);
    return hits > 0;
  }

  /** One-time use for TOTP codes: a code observed by an attacker cannot be replayed. */
  async claimTotp(userId: string, code: string): Promise<boolean> {
    const res = await this.redis.set(`auth:totp-used:${userId}:${code}`, '1', 'EX', 90, 'NX');
    return res === 'OK';
  }
}
