import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';
import { pageQuery } from '../../lib/pagination';
import { doctorProfileInput } from '../auth/auth.schemas';

const uuidParam = z.object({ id: z.string().uuid() });

const searchQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    specialization: z.string().trim().toLowerCase().max(50).optional(),
    city: z.string().trim().max(80).optional(),
    language: z.string().trim().toLowerCase().max(50).optional(),
    minFeePaise: z.coerce.number().int().min(0).optional(),
    maxFeePaise: z.coerce.number().int().min(0).optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    minExperience: z.coerce.number().int().min(0).max(80).optional(),
    availableOn: z.string().date().optional(),
    sort: z.enum(['rating', 'fee_asc', 'fee_desc', 'experience']).default('rating'),
    ...pageQuery,
  })
  .refine(
    (v) => v.minFeePaise === undefined || v.maxFeePaise === undefined || v.minFeePaise <= v.maxFeePaise,
    {
      message: 'minFeePaise must be <= maxFeePaise',
      path: ['minFeePaise'],
    },
  );

const slotRange = z.object({
  from: z.coerce.date().default(() => new Date()),
  to: z.coerce.date().optional(),
});

const createSlots = z.object({
  slots: z
    .array(z.object({ startAt: z.coerce.date(), endAt: z.coerce.date() }))
    .min(1)
    .max(100),
});

const profilePatch = doctorProfileInput
  .omit({ registrationNumber: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export function doctorsRouter({ doctorsService, availabilityService }: Cradle, mw: Middleware): Router {
  const r = Router();
  const { authenticate, authorize, requireMfa } = mw.auth;
  r.use(authenticate);

  // --- doctor self-service (declared before /:id so "me" is not parsed as an id)
  r.patch('/me', authorize('doctor:profile:manage'), requireMfa, mw.limit.writes, async (req, res) => {
    res.json(await doctorsService.updateOwnProfile(authUser(req).userId, profilePatch.parse(req.body)));
  });

  r.get('/me/slots', authorize('slot:manage'), requireMfa, async (req, res) => {
    const { from, to } = slotRange.parse(req.query);
    const end = to ?? new Date(from.getTime() + 14 * 86_400_000);
    res.json({ data: await availabilityService.listOwnSlots(authUser(req).userId, from, end) });
  });

  r.post('/me/slots', authorize('slot:manage'), requireMfa, mw.limit.writes, async (req, res) => {
    const { slots } = createSlots.parse(req.body);
    res.status(201).json({ data: await availabilityService.createSlots(authUser(req).userId, slots) });
  });

  r.delete('/me/slots/:id', authorize('slot:manage'), requireMfa, mw.limit.writes, async (req, res) => {
    await availabilityService.withdrawSlot(authUser(req).userId, uuidParam.parse(req.params).id);
    res.status(204).end();
  });

  // --- discovery
  r.get('/', authorize('doctor:read'), async (req, res) => {
    res.json(await doctorsService.search(searchQuery.parse(req.query)));
  });

  r.get('/:id', authorize('doctor:read'), async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    res.json(await doctorsService.getById(id, authUser(req)));
  });

  r.get('/:id/slots', authorize('slot:read'), async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const { from, to } = slotRange.parse(req.query);
    const end = to ?? new Date(from.getTime() + 7 * 86_400_000);
    res.json({ data: await availabilityService.listOpenSlots(id, from, end) });
  });

  return r;
}
