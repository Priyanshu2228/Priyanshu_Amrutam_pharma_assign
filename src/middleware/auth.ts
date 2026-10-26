import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';
import { hasPermission, type Permission } from '../modules/auth/rbac';
import type { SessionGuard } from '../modules/auth/session-guard';
import type { TokenService } from '../modules/auth/token.service';
import { requestContext } from '../telemetry/context';
import type { AuthContext } from '../types/express';

export function authUser(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export function createAuthMiddleware({
  tokenService,
  sessionGuard,
  config,
}: {
  tokenService: TokenService;
  sessionGuard: SessionGuard;
  config: AppConfig;
}) {
  const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
    const claims = tokenService.verifyAccessToken(header.slice('Bearer '.length).trim());
    if (await sessionGuard.isBlocked(claims.sub, claims.sid)) {
      throw new UnauthorizedError('Session is no longer valid', 'SESSION_REVOKED');
    }
    req.auth = { userId: claims.sub, role: claims.role, mfa: claims.mfa, sessionId: claims.sid };
    requestContext.setActor(claims.sub, claims.role);
    next();
  };

  /** Route-level RBAC: the caller's role must hold at least one of the permissions. */
  const authorize =
    (...permissions: Permission[]): RequestHandler =>
    (req, _res, next) => {
      const auth = authUser(req);
      if (!permissions.some((p) => hasPermission(auth.role, p))) throw new ForbiddenError();
      next();
    };

  /**
   * Privileged roles (doctors see PHI, admins manage the platform) must have completed a
   * second factor in this session before touching protected routes.
   */
  const requireMfa: RequestHandler = (req, _res, next) => {
    const auth = authUser(req);
    if (config.auth.mfaRequiredRoles.includes(auth.role) && !auth.mfa) {
      throw new ForbiddenError('Multi-factor authentication is required for this action', 'MFA_REQUIRED');
    }
    next();
  };

  return { authenticate, authorize, requireMfa };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
