import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { AppConfig } from '../../config/env';
import type { Database, Queryable } from '../../db/database';
import { UnauthorizedError } from '../../lib/errors';
import type { Role } from './rbac';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** True when this session completed a second factor. */
  mfa: boolean;
  /** Refresh-token family (login session) id, used to revoke a session. */
  sid: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export class TokenService {
  private readonly config: AppConfig;
  private readonly db: Database;

  constructor({ config, db }: { config: AppConfig; db: Database }) {
    this.config = config;
    this.db = db;
  }

  private signOpts(expiresIn: number): jwt.SignOptions {
    return {
      algorithm: 'HS256',
      expiresIn,
      issuer: this.config.auth.issuer,
      audience: this.config.auth.audience,
    };
  }

  issueAccessToken(claims: AccessClaims): string {
    return jwt.sign(
      { ...claims, typ: 'access' },
      this.config.auth.accessSecret,
      this.signOpts(this.config.auth.accessTtlSec),
    );
  }

  verifyAccessToken(token: string): AccessClaims {
    const payload = this.verify(token, 'access');
    return { sub: payload.sub, role: payload.role, mfa: Boolean(payload.mfa), sid: payload.sid };
  }

  /** Short-lived token proving the password step passed; exchanged for tokens after TOTP. */
  issueMfaChallenge(userId: string): string {
    return jwt.sign(
      { sub: userId, typ: 'mfa_challenge' },
      this.config.auth.accessSecret,
      this.signOpts(this.config.auth.mfaChallengeTtlSec),
    );
  }

  verifyMfaChallenge(token: string): string {
    return this.verify(token, 'mfa_challenge').sub;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private verify(token: string, typ: string): any {
    try {
      const payload = jwt.verify(token, this.config.auth.accessSecret, {
        algorithms: ['HS256'],
        issuer: this.config.auth.issuer,
        audience: this.config.auth.audience,
      });
      if (typeof payload !== 'object' || payload.typ !== typ || typeof payload.sub !== 'string') {
        throw new Error('wrong token type');
      }
      return payload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token', 'INVALID_TOKEN');
    }
  }

  async issuePair(
    user: { id: string; role: Role },
    mfa: boolean,
    q: Queryable = this.db,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(48).toString('base64url');
    await q.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [user.id, familyId, sha256(refreshToken), this.config.auth.refreshTtlSec],
    );
    return {
      accessToken: this.issueAccessToken({ sub: user.id, role: user.role, mfa, sid: familyId }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.auth.accessTtlSec,
    };
  }

  /**
   * Rotates a refresh token. Returns `reuse` when a token that was already rotated is
   * presented again: that only happens if it was stolen, so the whole family is revoked.
   */
  async rotate(
    refreshToken: string,
    loadUser: (
      id: string,
      q: Queryable,
    ) => Promise<{ id: string; role: Role; status: string; mfaEnabled: boolean } | null>,
  ): Promise<
    { kind: 'ok'; pair: TokenPair; userId: string } | { kind: 'reuse'; userId: string } | { kind: 'invalid' }
  > {
    return this.db.withTransaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        family_id: string;
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        'SELECT id, user_id, family_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
        [sha256(refreshToken)],
      );
      const token = rows[0];
      if (!token) return { kind: 'invalid' as const };
      if (token.revoked_at) {
        await tx.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [token.family_id],
        );
        return { kind: 'reuse' as const, userId: token.user_id };
      }
      if (token.expires_at.getTime() <= Date.now()) return { kind: 'invalid' as const };

      const user = await loadUser(token.user_id, tx);
      if (!user || user.status !== 'active') return { kind: 'invalid' as const };

      // MFA status of the session carries over: a refreshed session is as strong as its login.
      const pair = await this.issuePair(user, user.mfaEnabled, tx, token.family_id);
      await tx.query(
        `UPDATE refresh_tokens SET revoked_at = now(),
                replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2)
          WHERE id = $1`,
        [token.id, sha256(pair.refreshToken)],
      );
      return { kind: 'ok' as const, pair, userId: user.id };
    });
  }

  async revokeFamilyByToken(refreshToken: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    );
  }

  async revokeAllForUser(userId: string, q: Queryable = this.db): Promise<void> {
    await q.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
  }
}
