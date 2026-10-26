import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';
import { phone } from '../auth/auth.schemas';

const profilePatch = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    phone: phone.nullable(),
    dateOfBirth: z
      .string()
      .date()
      .refine((d) => new Date(d) < new Date(), 'Date of birth must be in the past')
      .nullable(),
    gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullable(),
    city: z.string().trim().min(2).max(80).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export function usersRouter({ usersService }: Cradle, mw: Middleware): Router {
  const r = Router();
  r.use(mw.auth.authenticate, mw.auth.authorize('profile:manage'));

  r.get('/me', async (req, res) => {
    res.json(await usersService.getMe(authUser(req).userId));
  });

  r.patch('/me', mw.limit.writes, async (req, res) => {
    res.json(await usersService.updateMe(authUser(req).userId, profilePatch.parse(req.body)));
  });

  return r;
}
