import { z } from 'zod';

export const email = z.string().trim().toLowerCase().email().max(254);

export const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'Password must contain upper-case, lower-case and a digit',
  });

export const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +919876543210');

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[a-z][a-z -]*$/, 'Only letters, spaces and hyphens');

export const doctorProfileInput = z.object({
  registrationNumber: z.string().trim().min(4).max(40),
  specializations: z.array(tag).min(1).max(5),
  languages: z.array(tag).max(10).default([]),
  yearsExperience: z.number().int().min(0).max(80),
  consultationFeePaise: z.number().int().min(100).max(10_000_000),
  bio: z.string().trim().max(2000).optional(),
  city: z.string().trim().min(2).max(80).optional(),
});

export const registerSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('patient'),
    email,
    password,
    fullName: z.string().trim().min(2).max(120),
    phone: phone.optional(),
    city: z.string().trim().min(2).max(80).optional(),
  }),
  z.object({
    role: z.literal('doctor'),
    email,
    password,
    fullName: z.string().trim().min(2).max(120),
    phone: phone.optional(),
    doctor: doctorProfileInput,
  }),
]);
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const totpCode = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');
export const mfaVerifySchema = z.object({ mfaToken: z.string().min(1).max(2048), code: totpCode });
export const mfaEnableSchema = z.object({ code: totpCode });
export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(512) });
