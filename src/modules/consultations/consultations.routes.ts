import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';
import { pageQuery } from '../../lib/pagination';
import { CONSULTATION_STATUSES } from './consultation-state';

const idParam = z.object({ id: z.string().uuid() });

const bookSchema = z.object({
  slotId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000).optional(),
});

const listQuery = z.object({
  status: z.enum(CONSULTATION_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const completeSchema = z.object({ notes: z.string().trim().max(5000).optional() });

const medication = z.object({
  name: z.string().trim().min(1).max(120),
  dosage: z.string().trim().min(1).max(60),
  frequency: z.string().trim().min(1).max(60),
  durationDays: z.number().int().min(1).max(365),
  instructions: z.string().trim().max(300).optional(),
});

const prescriptionSchema = z.object({
  diagnosis: z.string().trim().min(2).max(2000),
  medications: z.array(medication).min(1).max(30),
  advice: z.string().trim().max(3000).optional(),
  followUpDate: z
    .string()
    .date()
    .refine((d) => new Date(d) > new Date(), 'Follow-up must be in the future')
    .optional(),
});

export function consultationsRouter(
  { bookingService, consultationsService, prescriptionsService }: Cradle,
  mw: Middleware,
): Router {
  const r = Router();
  const { authenticate, authorize, requireMfa } = mw.auth;
  r.use(authenticate);

  /** Book a slot (saga step 1+2). Requires Idempotency-Key: a retried request never double-books. */
  r.post('/', authorize('consultation:book'), mw.limit.booking, mw.idempotent(), async (req, res) => {
    const result = await bookingService.book(authUser(req).userId, bookSchema.parse(req.body));
    res.status(201).json(result);
  });

  r.get('/', authorize('consultation:read'), requireMfa, async (req, res) => {
    res.json(await consultationsService.list(authUser(req), listQuery.parse(req.query)));
  });

  r.get('/:id', authorize('consultation:read'), requireMfa, async (req, res) => {
    res.json(await consultationsService.get(authUser(req), idParam.parse(req.params).id));
  });

  r.post(
    '/:id/cancel',
    authorize('consultation:cancel'),
    requireMfa,
    mw.limit.writes,
    mw.idempotent(),
    async (req, res) => {
      const { reason } = cancelSchema.parse(req.body);
      res.json(await bookingService.cancel(authUser(req), idParam.parse(req.params).id, reason));
    },
  );

  r.post('/:id/start', authorize('consultation:conduct'), requireMfa, async (req, res) => {
    res.json(await consultationsService.start(authUser(req).userId, idParam.parse(req.params).id));
  });

  r.post('/:id/complete', authorize('consultation:conduct'), requireMfa, async (req, res) => {
    const { notes } = completeSchema.parse(req.body ?? {});
    res.json(await consultationsService.complete(authUser(req).userId, idParam.parse(req.params).id, notes));
  });

  r.post('/:id/no-show', authorize('consultation:conduct'), requireMfa, async (req, res) => {
    res.json(await consultationsService.markNoShow(authUser(req).userId, idParam.parse(req.params).id));
  });

  r.post(
    '/:id/prescription',
    authorize('prescription:write'),
    requireMfa,
    mw.limit.writes,
    mw.idempotent(),
    async (req, res) => {
      const input = prescriptionSchema.parse(req.body);
      res
        .status(201)
        .json(await prescriptionsService.issue(authUser(req).userId, idParam.parse(req.params).id, input));
    },
  );

  r.get('/:id/prescription', authorize('prescription:read'), requireMfa, async (req, res) => {
    res.json(await prescriptionsService.getForConsultation(authUser(req), idParam.parse(req.params).id));
  });

  return r;
}
