import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';
import { pageQuery } from '../../lib/pagination';

const idParam = z.object({ id: z.string().uuid() });

const analyticsQuery = z.object({
  from: z.coerce.date().default(() => new Date(Date.now() - 30 * 86_400_000)),
  to: z.coerce.date().default(() => new Date(Date.now() + 86_400_000)),
});

const auditQuery = z.object({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

export function adminRouter({ adminService, auditService }: Cradle, mw: Middleware): Router {
  const r = Router();
  const { authenticate, authorize, requireMfa } = mw.auth;
  r.use(authenticate, requireMfa);

  r.get('/analytics/summary', authorize('admin:analytics'), async (req, res) => {
    const { from, to } = analyticsQuery.parse(req.query);
    res.json(await adminService.analytics(from, to));
  });

  r.post('/doctors/:id/verify', authorize('admin:doctors'), async (req, res) => {
    await adminService.verifyDoctor(authUser(req).userId, idParam.parse(req.params).id);
    res.status(204).end();
  });

  r.post('/users/:id/suspend', authorize('admin:users'), async (req, res) => {
    await adminService.setUserStatus(authUser(req).userId, idParam.parse(req.params).id, 'suspended');
    res.status(204).end();
  });

  r.post('/users/:id/reactivate', authorize('admin:users'), async (req, res) => {
    await adminService.setUserStatus(authUser(req).userId, idParam.parse(req.params).id, 'active');
    res.status(204).end();
  });

  r.get('/audit-logs', authorize('admin:audit'), async (req, res) => {
    const query = auditQuery.parse(req.query);
    const page = await auditService.query(query);
    // Reading the audit trail is itself audited.
    await auditService.record({
      action: 'audit.queried',
      entityType: 'audit_log',
      metadata: { filters: { ...query, cursor: undefined } },
    });
    res.json(page);
  });

  return r;
}
