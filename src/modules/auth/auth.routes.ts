import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';
import { loginSchema, mfaEnableSchema, mfaVerifySchema, refreshSchema, registerSchema } from './auth.schemas';

export function authRouter({ authService }: Cradle, mw: Middleware): Router {
  const r = Router();
  const { authenticate } = mw.auth;

  r.post('/register', mw.limit.auth, async (req, res) => {
    res.status(201).json(await authService.register(registerSchema.parse(req.body)));
  });

  r.post('/login', mw.limit.auth, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    res.json(await authService.login(email, password));
  });

  r.post('/mfa/verify', mw.limit.auth, async (req, res) => {
    const { mfaToken, code } = mfaVerifySchema.parse(req.body);
    res.json(await authService.verifyMfa(mfaToken, code));
  });

  r.post('/refresh', mw.limit.auth, async (req, res) => {
    res.json(await authService.refresh(refreshSchema.parse(req.body).refreshToken));
  });

  r.post('/logout', authenticate, async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string().max(512).optional() }).parse(req.body ?? {});
    await authService.logout(authUser(req).sessionId, refreshToken);
    res.status(204).end();
  });

  r.post('/mfa/setup', authenticate, async (req, res) => {
    res.json(await authService.setupMfa(authUser(req).userId));
  });

  r.post('/mfa/enable', authenticate, mw.limit.auth, async (req, res) => {
    const { code } = mfaEnableSchema.parse(req.body);
    res.json(await authService.enableMfa(authUser(req).userId, code));
  });

  return r;
}
