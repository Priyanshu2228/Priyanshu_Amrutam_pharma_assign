import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { buildContainer, type AppContainer } from '../../src/container';
import { hashPassword } from '../../src/lib/password';

export const PASSWORD = 'Sup3rSecretPass';

export interface TestContext {
  container: AppContainer;
  app: Express;
  api: () => request.Agent;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const container = buildContainer();
  const app = createApp(container);
  await resetState(container);
  return {
    container,
    app,
    api: () => request.agent(app),
    close: () => container.dispose(),
  };
}

/** Empties every table (TRUNCATE bypasses the audit append-only row trigger) and Redis. */
export async function resetState(container: AppContainer): Promise<void> {
  const { db, redis } = container.cradle;
  await db.query(`
    TRUNCATE users, refresh_tokens, profiles, doctors, availability_slots, consultations, prescriptions,
             payments, processed_webhook_events, idempotency_keys, outbox_events, audit_logs CASCADE`);
  await db.query('REFRESH MATERIALIZED VIEW consultation_daily_stats');
  await redis.flushdb();
}

/** TOTP for the given step offset; offsets let one test use several distinct codes. */
export function totp(secret: string, stepOffset = 0): string {
  return authenticator.clone({ epoch: Date.now() + stepOffset * 30_000 }).generate(secret);
}

export const idemKey = () => `test-${randomUUID()}`;

export interface Session {
  userId: string;
  token: string;
  refreshToken: string;
  email: string;
}

let seq = 0;
const uniqueEmail = (prefix: string) => `${prefix}.${Date.now()}.${++seq}@test.local`;

export async function registerPatient(
  ctx: TestContext,
  overrides: Record<string, unknown> = {},
): Promise<Session> {
  const email = uniqueEmail('patient');
  const res = await ctx
    .api()
    .post('/v1/auth/register')
    .send({
      role: 'patient',
      email,
      password: PASSWORD,
      fullName: 'Test Patient',
      phone: '+919811111111',
      ...overrides,
    })
    .expect(201);
  return { userId: res.body.userId, token: res.body.accessToken, refreshToken: res.body.refreshToken, email };
}

/** Registers a doctor, enrols MFA (so the session is MFA-verified) and verifies the profile. */
export async function createVerifiedDoctor(
  ctx: TestContext,
  doctor: Partial<{
    specializations: string[];
    city: string;
    consultationFeePaise: number;
    languages: string[];
  }> = {},
): Promise<Session & { mfaSecret: string }> {
  const email = uniqueEmail('doctor');
  const reg = await ctx
    .api()
    .post('/v1/auth/register')
    .send({
      role: 'doctor',
      email,
      password: PASSWORD,
      fullName: 'Dr. Test Vaidya',
      doctor: {
        registrationNumber: `REG-${randomUUID().slice(0, 8)}`,
        specializations: doctor.specializations ?? ['ayurveda'],
        languages: doctor.languages ?? ['english', 'hindi'],
        yearsExperience: 10,
        consultationFeePaise: doctor.consultationFeePaise ?? 50000,
        city: doctor.city ?? 'Pune',
      },
    })
    .expect(201);
  const { secret, token } = await enrolMfa(ctx, reg.body.accessToken);
  await ctx.container.cradle.doctorsRepository.verify(
    ctx.container.cradle.db,
    reg.body.userId,
    reg.body.userId,
  );
  await ctx.container.cradle.cacheService.bump('doctors');
  return {
    userId: reg.body.userId,
    token: token.accessToken,
    refreshToken: token.refreshToken,
    email,
    mfaSecret: secret,
  };
}

export async function enrolMfa(ctx: TestContext, accessToken: string) {
  const setup = await ctx
    .api()
    .post('/v1/auth/mfa/setup')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  const enabled = await ctx
    .api()
    .post('/v1/auth/mfa/enable')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ code: totp(setup.body.secret) })
    .expect(200);
  return {
    secret: setup.body.secret as string,
    token: enabled.body as { accessToken: string; refreshToken: string },
  };
}

/** Admins cannot self-register; insert one directly with MFA pre-enrolled, then log in. */
export async function createAdmin(ctx: TestContext): Promise<Session> {
  const { db, fieldCrypto } = ctx.container.cradle;
  const email = uniqueEmail('admin');
  const secret = authenticator.generateSecret();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, mfa_enabled, mfa_secret_enc) VALUES ($1, $2, 'admin', true, $3) RETURNING id`,
    [email, await hashPassword(PASSWORD), fieldCrypto.encrypt(secret)],
  );
  await db.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, 'Admin')`, [rows[0]!.id]);
  const login = await ctx.api().post('/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const verified = await ctx
    .api()
    .post('/v1/auth/mfa/verify')
    .send({ mfaToken: login.body.mfaToken, code: totp(secret) })
    .expect(200);
  return {
    userId: rows[0]!.id,
    token: verified.body.accessToken,
    refreshToken: verified.body.refreshToken,
    email,
  };
}

export async function publishSlots(
  ctx: TestContext,
  doctor: Session,
  slots: { startInMin: number; durationMin?: number }[],
): Promise<{ id: string; startAt: string }[]> {
  const res = await ctx
    .api()
    .post('/v1/doctors/me/slots')
    .set('Authorization', `Bearer ${doctor.token}`)
    .send({
      slots: slots.map((s) => {
        const start = Date.now() + s.startInMin * 60_000;
        return {
          startAt: new Date(start).toISOString(),
          endAt: new Date(start + (s.durationMin ?? 30) * 60_000).toISOString(),
        };
      }),
    })
    .expect(201);
  return res.body.data;
}

export function book(ctx: TestContext, patient: Session, slotId: string, key = idemKey()) {
  return ctx
    .api()
    .post('/v1/consultations')
    .set('Authorization', `Bearer ${patient.token}`)
    .set('Idempotency-Key', key)
    .send({ slotId, reason: 'Recurring acidity and poor sleep' });
}

export async function confirmPayment(ctx: TestContext, patient: Session, paymentId: string) {
  return ctx
    .api()
    .post(`/v1/payments/${paymentId}/mock-confirm`)
    .set('Authorization', `Bearer ${patient.token}`)
    .set('Idempotency-Key', idemKey())
    .expect(200);
}

export const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
