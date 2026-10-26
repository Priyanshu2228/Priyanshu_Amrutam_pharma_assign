import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createAdmin,
  createTestContext,
  enrolMfa,
  PASSWORD,
  registerPatient,
  totp,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('registration', () => {
  it('registers a patient and stores PII encrypted', async () => {
    const patient = await registerPatient(ctx);
    const me = await ctx.api().get('/v1/users/me').set(bearer(patient)).expect(200);
    expect(me.body).toMatchObject({
      role: 'patient',
      mfaEnabled: false,
      profile: { phone: '+919811111111' },
    });

    const { rows } = await ctx.container.cradle.db.query(
      'SELECT phone_enc FROM profiles WHERE user_id = $1',
      [patient.userId],
    );
    expect(rows[0]!.phone_enc).not.toContain('9811111111');
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const patient = await registerPatient(ctx);
    const dup = await ctx
      .api()
      .post('/v1/auth/register')
      .send({ role: 'patient', email: patient.email.toUpperCase(), password: PASSWORD, fullName: 'Dup' })
      .expect(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const weak = await ctx
      .api()
      .post('/v1/auth/register')
      .send({ role: 'patient', email: 'weak@test.local', password: 'password', fullName: 'Weak' })
      .expect(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('does not allow self-registration as admin', async () => {
    await ctx
      .api()
      .post('/v1/auth/register')
      .send({ role: 'admin', email: 'root@test.local', password: PASSWORD, fullName: 'Root' })
      .expect(400);
  });
});

describe('login, lockout and sessions', () => {
  it('returns the same generic error for unknown email and wrong password', async () => {
    const patient = await registerPatient(ctx);
    const wrong = await ctx
      .api()
      .post('/v1/auth/login')
      .send({ email: patient.email, password: 'Wrong-Pass-1' })
      .expect(401);
    const unknown = await ctx
      .api()
      .post('/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'Wrong-Pass-1' })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error).toMatchObject({
      code: wrong.body.error.code,
      message: wrong.body.error.message,
    });
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    const patient = await registerPatient(ctx);
    for (let i = 0; i < 5; i++) {
      await ctx
        .api()
        .post('/v1/auth/login')
        .send({ email: patient.email, password: 'Wrong-Pass-1' })
        .expect(401);
    }
    await ctx.api().post('/v1/auth/login').send({ email: patient.email, password: PASSWORD }).expect(401);
    const audit = await ctx.container.cradle.db.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 AND action LIKE 'auth.login.%'`,
      [patient.userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain('auth.login.locked');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const patient = await registerPatient(ctx);
    const first = await ctx
      .api()
      .post('/v1/auth/refresh')
      .send({ refreshToken: patient.refreshToken })
      .expect(200);
    expect(first.body.refreshToken).not.toBe(patient.refreshToken);

    // Replaying the old token (as a thief would) kills the whole session family.
    const reuse = await ctx
      .api()
      .post('/v1/auth/refresh')
      .send({ refreshToken: patient.refreshToken })
      .expect(401);
    expect(reuse.body.error.code).toBe('SESSION_REVOKED');
    await ctx.api().post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
  });

  it('logout invalidates the access token immediately', async () => {
    const patient = await registerPatient(ctx);
    await ctx.api().get('/v1/users/me').set(bearer(patient)).expect(200);
    await ctx
      .api()
      .post('/v1/auth/logout')
      .set(bearer(patient))
      .send({ refreshToken: patient.refreshToken })
      .expect(204);
    const res = await ctx.api().get('/v1/users/me').set(bearer(patient)).expect(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
    await ctx.api().post('/v1/auth/refresh').send({ refreshToken: patient.refreshToken }).expect(401);
  });

  it('rejects tampered and missing tokens', async () => {
    const patient = await registerPatient(ctx);
    await ctx.api().get('/v1/users/me').expect(401);
    await ctx.api().get('/v1/users/me').set('Authorization', `Bearer ${patient.token}x`).expect(401);
  });
});

describe('multi-factor authentication', () => {
  it('forces doctors to enrol MFA before touching protected routes', async () => {
    const reg = await ctx
      .api()
      .post('/v1/auth/register')
      .send({
        role: 'doctor',
        email: 'mfa.doc@test.local',
        password: PASSWORD,
        fullName: 'Dr. MFA',
        doctor: {
          registrationNumber: 'REG-MFA-001',
          specializations: ['ayurveda'],
          yearsExperience: 3,
          consultationFeePaise: 30000,
        },
      })
      .expect(201);

    const login = await ctx
      .api()
      .post('/v1/auth/login')
      .send({ email: 'mfa.doc@test.local', password: PASSWORD })
      .expect(200);
    expect(login.body).toMatchObject({ mfaRequired: false, mfaSetupRequired: true });

    const blocked = await ctx
      .api()
      .get('/v1/doctors/me/slots')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');

    const { secret, token } = await enrolMfa(ctx, reg.body.accessToken);
    await ctx
      .api()
      .get('/v1/doctors/me/slots')
      .set('Authorization', `Bearer ${token.accessToken}`)
      .expect(200);

    // Sessions from before enrolment were revoked.
    await ctx.api().post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);

    // Subsequent logins require the second factor; a used code cannot be replayed.
    const step1 = await ctx
      .api()
      .post('/v1/auth/login')
      .send({ email: 'mfa.doc@test.local', password: PASSWORD })
      .expect(200);
    expect(step1.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    const code = totp(secret, 1);
    await ctx.api().post('/v1/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code }).expect(200);
    const replay = await ctx
      .api()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code })
      .expect(401);
    expect(replay.body.error.code).toBe('INVALID_MFA_CODE');
    await ctx
      .api()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: '000000' })
      .expect(401);
  });

  it('cannot use an MFA challenge token as an access token', async () => {
    const admin = await createAdmin(ctx);
    const step1 = await ctx
      .api()
      .post('/v1/auth/login')
      .send({ email: admin.email, password: PASSWORD })
      .expect(200);
    await ctx.api().get('/v1/users/me').set('Authorization', `Bearer ${step1.body.mfaToken}`).expect(401);
  });
});

describe('RBAC', () => {
  it('blocks patients from admin and doctor routes', async () => {
    const patient = await registerPatient(ctx);
    await ctx.api().get('/v1/admin/analytics/summary').set(bearer(patient)).expect(403);
    await ctx.api().post('/v1/doctors/me/slots').set(bearer(patient)).send({ slots: [] }).expect(403);
  });

  it('suspension takes effect on live tokens immediately', async () => {
    const admin = await createAdmin(ctx);
    const patient = await registerPatient(ctx);
    await ctx.api().post(`/v1/admin/users/${patient.userId}/suspend`).set(bearer(admin)).expect(204);
    await ctx.api().get('/v1/users/me').set(bearer(patient)).expect(401);
    const login = await ctx
      .api()
      .post('/v1/auth/login')
      .send({ email: patient.email, password: PASSWORD })
      .expect(403);
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');

    await ctx.api().post(`/v1/admin/users/${patient.userId}/reactivate`).set(bearer(admin)).expect(204);
    await ctx.api().post('/v1/auth/login').send({ email: patient.email, password: PASSWORD }).expect(200);
  });
});
