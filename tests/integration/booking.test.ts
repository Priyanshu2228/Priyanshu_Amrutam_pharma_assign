import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '../../src/modules/payments/payment-gateway';
import {
  bearer,
  book,
  confirmPayment,
  createAdmin,
  createTestContext,
  createVerifiedDoctor,
  idemKey,
  publishSlots,
  registerPatient,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const count = async (sql: string, params: unknown[] = []) =>
  Number((await ctx.container.cradle.db.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('doctor discovery and availability', () => {
  it('publishes slots and finds doctors by facets', async () => {
    const doctor = await createVerifiedDoctor(ctx, {
      specializations: ['dermatology', 'ayurveda'],
      city: 'Jaipur',
      consultationFeePaise: 70000,
    });
    await createVerifiedDoctor(ctx, {
      specializations: ['nutrition'],
      city: 'Jaipur',
      consultationFeePaise: 30000,
    });
    const patient = await registerPatient(ctx);
    await publishSlots(ctx, doctor, [{ startInMin: 60 }, { startInMin: 120 }]);

    const bySpec = await ctx
      .api()
      .get('/v1/doctors')
      .query({ specialization: 'Dermatology' })
      .set(bearer(patient))
      .expect(200);
    expect(bySpec.body.data.map((d: { id: string }) => d.id)).toEqual([doctor.userId]);
    expect(bySpec.body.data[0].registrationNumber).toBeUndefined();

    const byText = await ctx
      .api()
      .get('/v1/doctors')
      .query({ q: 'derm jaip' })
      .set(bearer(patient))
      .expect(200);
    expect(byText.body.data).toHaveLength(1);

    const cheap = await ctx
      .api()
      .get('/v1/doctors')
      .query({ city: 'jaipur', sort: 'fee_asc', limit: 1 })
      .set(bearer(patient))
      .expect(200);
    expect(cheap.body.data[0].consultationFeePaise).toBe(30000);
    const page2 = await ctx
      .api()
      .get('/v1/doctors')
      .query({ city: 'jaipur', sort: 'fee_asc', limit: 1, cursor: cheap.body.nextCursor })
      .set(bearer(patient))
      .expect(200);
    expect(page2.body.data[0].consultationFeePaise).toBe(70000);
    expect(page2.body.nextCursor).toBeNull();

    const slots = await ctx.api().get(`/v1/doctors/${doctor.userId}/slots`).set(bearer(patient)).expect(200);
    expect(slots.body.data).toHaveLength(2);
  });

  it('rejects overlapping, past and unverified availability', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    await publishSlots(ctx, doctor, [{ startInMin: 600 }]);
    const overlap = await ctx
      .api()
      .post('/v1/doctors/me/slots')
      .set(bearer(doctor))
      .send({
        slots: [{ startAt: new Date(Date.now() + 610 * 60_000), endAt: new Date(Date.now() + 640 * 60_000) }],
      })
      .expect(409);
    expect(overlap.body.error.code).toBe('SLOT_OVERLAP');

    const past = await ctx
      .api()
      .post('/v1/doctors/me/slots')
      .set(bearer(doctor))
      .send({
        slots: [{ startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 29 * 60_000) }],
      })
      .expect(400);
    expect(past.body.error.code).toBe('SLOT_IN_PAST');

    await ctx.container.cradle.db.query('UPDATE doctors SET is_verified = false WHERE user_id = $1', [
      doctor.userId,
    ]);
    const unverified = await ctx
      .api()
      .post('/v1/doctors/me/slots')
      .set(bearer(doctor))
      .send({
        slots: [{ startAt: new Date(Date.now() + 900 * 60_000), endAt: new Date(Date.now() + 930 * 60_000) }],
      })
      .expect(403);
    expect(unverified.body.error.code).toBe('DOCTOR_NOT_VERIFIED');
  });
});

describe('booking concurrency and idempotency', () => {
  it('lets exactly one of many concurrent patients win a slot', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 180 }]);
    const patients = await Promise.all(Array.from({ length: 10 }, () => registerPatient(ctx)));

    const results = await Promise.all(patients.map((p) => book(ctx, p, slot!.id)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(await count('SELECT count(*) AS n FROM consultations WHERE slot_id = $1', [slot!.id])).toBe(1);
  });

  it('replays retried requests instead of booking twice', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const [slot, other] = await publishSlots(ctx, doctor, [{ startInMin: 240 }, { startInMin: 300 }]);
    const patient = await registerPatient(ctx);
    const key = idemKey();

    const first = await book(ctx, patient, slot!.id, key).expect(201);
    const retry = await book(ctx, patient, slot!.id, key).expect(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(
      await count('SELECT count(*) AS n FROM consultations WHERE patient_id = $1', [patient.userId]),
    ).toBe(1);

    const reused = await book(ctx, patient, other!.id, key).expect(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const missing = await ctx
      .api()
      .post('/v1/consultations')
      .set(bearer(patient))
      .send({ slotId: other!.id })
      .expect(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('scopes idempotency keys per user', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const [a, b] = await publishSlots(ctx, doctor, [{ startInMin: 400 }, { startInMin: 460 }]);
    const [p1, p2] = await Promise.all([registerPatient(ctx), registerPatient(ctx)]);
    const key = idemKey();
    await book(ctx, p1, a!.id, key).expect(201);
    const second = await book(ctx, p2, b!.id, key).expect(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('end-to-end consultation lifecycle', () => {
  it('books, pays, consults, prescribes and audits', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const stranger = await registerPatient(ctx);
    const admin = await createAdmin(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 5 }]);

    const booked = await book(ctx, patient, slot!.id).expect(201);
    expect(booked.body.consultation).toMatchObject({
      status: 'pending_payment',
      reason: 'Recurring acidity and poor sleep',
    });
    expect(booked.body.payment).toMatchObject({
      status: 'initiated',
      amountPaise: 50000,
      clientSecret: expect.any(String),
    });
    const consultationId = booked.body.consultation.id;

    // The slot disappears from public listings while held.
    const listing = await ctx
      .api()
      .get(`/v1/doctors/${doctor.userId}/slots`)
      .set(bearer(patient))
      .expect(200);
    expect(listing.body.data.find((s: { id: string }) => s.id === slot!.id)).toBeUndefined();

    const captured = await confirmPayment(ctx, patient, booked.body.payment.id);
    expect(captured.body).toMatchObject({ outcome: 'confirmed', consultationId });

    // Webhook redelivery of the same capture is a no-op.
    const body = JSON.stringify({
      id: `mock-capture-${booked.body.payment.id}`,
      type: 'payment.captured',
      data: { providerPaymentId: booked.body.payment.providerPaymentId },
    });
    const dup = await ctx
      .api()
      .post('/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signWebhook(process.env.PAYMENT_WEBHOOK_SECRET!, body))
      .send(body)
      .expect(200);
    expect(dup.body.outcome).toBe('duplicate');

    const started = await ctx
      .api()
      .post(`/v1/consultations/${consultationId}/start`)
      .set(bearer(doctor))
      .expect(200);
    expect(started.body).toMatchObject({ status: 'in_progress', videoRoomId: `consult-${consultationId}` });

    const rxKey = idemKey();
    const prescription = {
      diagnosis: 'Amlapitta (hyperacidity)',
      medications: [{ name: 'Avipattikar churna', dosage: '3g', frequency: 'twice daily', durationDays: 14 }],
      advice: 'Avoid spicy food; dinner before 8pm',
    };
    const rx = await ctx
      .api()
      .post(`/v1/consultations/${consultationId}/prescription`)
      .set(bearer(doctor))
      .set('Idempotency-Key', rxKey)
      .send(prescription)
      .expect(201);
    expect(rx.body).toMatchObject({ diagnosis: prescription.diagnosis, document: { status: 'pending' } });
    // A second, different prescription is refused (one per consultation).
    await ctx
      .api()
      .post(`/v1/consultations/${consultationId}/prescription`)
      .set(bearer(doctor))
      .set('Idempotency-Key', idemKey())
      .send(prescription)
      .expect(409);

    await ctx
      .api()
      .post(`/v1/consultations/${consultationId}/complete`)
      .set(bearer(doctor))
      .send({ notes: 'Follow up in 2 weeks' })
      .expect(200);
    // Illegal transition after completion.
    const again = await ctx
      .api()
      .post(`/v1/consultations/${consultationId}/start`)
      .set(bearer(doctor))
      .expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Patient reads their prescription; others cannot (404 hides existence).
    const read = await ctx
      .api()
      .get(`/v1/consultations/${consultationId}/prescription`)
      .set(bearer(patient))
      .expect(200);
    expect(read.body.medications[0].name).toBe('Avipattikar churna');
    await ctx.api().get(`/v1/consultations/${consultationId}/prescription`).set(bearer(stranger)).expect(404);
    await ctx.api().get(`/v1/consultations/${consultationId}`).set(bearer(stranger)).expect(404);
    await ctx.api().get(`/v1/consultations/${consultationId}/prescription`).set(bearer(admin)).expect(403);

    // Admins see operational metadata but not clinical free text.
    const adminView = await ctx
      .api()
      .get(`/v1/consultations/${consultationId}`)
      .set(bearer(admin))
      .expect(200);
    expect(adminView.body).toMatchObject({ status: 'completed', reason: null, doctorNotes: null });

    // PHI at rest is ciphertext.
    const raw = await ctx.container.cradle.db.query(
      'SELECT diagnosis_enc, medications_enc FROM prescriptions WHERE id = $1',
      [rx.body.id],
    );
    expect(raw.rows[0]!.diagnosis_enc).not.toContain('Amlapitta');

    // The trail records who touched the record, and every row's signature verifies.
    const audit = await ctx
      .api()
      .get('/v1/admin/audit-logs')
      .query({ entityId: rx.body.id })
      .set(bearer(admin))
      .expect(200);
    const actions = audit.body.data.map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['prescription.issued', 'prescription.viewed']));
    expect(audit.body.data.every((r: { signatureValid: boolean }) => r.signatureValid)).toBe(true);

    const slotRow = await ctx.container.cradle.db.query(
      'SELECT status FROM availability_slots WHERE id = $1',
      [slot!.id],
    );
    expect(slotRow.rows[0]!.status).toBe('booked');
  });

  it('lists consultations scoped to the caller', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const [p1, p2] = await Promise.all([registerPatient(ctx), registerPatient(ctx)]);
    const [s1, s2] = await publishSlots(ctx, doctor, [{ startInMin: 700 }, { startInMin: 760 }]);
    await book(ctx, p1, s1!.id).expect(201);
    await book(ctx, p2, s2!.id).expect(201);

    const mine = await ctx.api().get('/v1/consultations').set(bearer(p1)).expect(200);
    expect(mine.body.data).toHaveLength(1);
    const assigned = await ctx
      .api()
      .get('/v1/consultations')
      .set(bearer(doctor))
      .query({ limit: 1 })
      .expect(200);
    expect(assigned.body.data).toHaveLength(1);
    expect(assigned.body.nextCursor).not.toBeNull();
  });
});

describe('payments webhook security', () => {
  it('rejects unsigned or tampered webhooks', async () => {
    const body = JSON.stringify({
      id: 'evt_x',
      type: 'payment.captured',
      data: { providerPaymentId: 'pay_x' },
    });
    await ctx
      .api()
      .post('/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(401);
    await ctx
      .api()
      .post('/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signWebhook('wrong-secret-0000000', body))
      .send(body)
      .expect(401);
  });

  it('a declined payment frees the slot immediately', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 800 }]);
    const booked = await book(ctx, patient, slot!.id).expect(201);
    const body = JSON.stringify({
      id: 'evt_declined_1',
      type: 'payment.failed',
      data: { providerPaymentId: booked.body.payment.providerPaymentId, reason: 'card_declined' },
    });
    const res = await ctx
      .api()
      .post('/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signWebhook(process.env.PAYMENT_WEBHOOK_SECRET!, body))
      .send(body)
      .expect(200);
    expect(res.body.outcome).toBe('cancelled');
    const s = await ctx.container.cradle.db.query('SELECT status FROM availability_slots WHERE id = $1', [
      slot!.id,
    ]);
    expect(s.rows[0]!.status).toBe('open');
  });
});
