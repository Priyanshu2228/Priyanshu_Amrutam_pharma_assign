import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';

export function prescriptionsRouter({ prescriptionsService }: Cradle, mw: Middleware): Router {
  const r = Router();
  r.use(mw.auth.authenticate, mw.auth.authorize('prescription:read'), mw.auth.requireMfa);

  r.get('/:id/document', async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { stream, filename } = await prescriptionsService.openDocument(authUser(req), id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    await pipeline(stream, res);
  });

  return r;
}
