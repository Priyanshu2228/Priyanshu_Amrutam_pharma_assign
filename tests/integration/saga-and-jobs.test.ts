import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay } from '../../src/jobs/outbox-relay';
import type { JobQueues } from '../../src/jobs/queues';
import type { MockPaymentGateway } from '../../src/modules/payments/payment-gateway';
import { buildProcessors } from '../../src/worker';
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

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await ctx.container.cradle.db.query(sql, params)).rows as T[];

/** Captures what the relay would enqueue, without needing BullMQ workers. */
function fakeQueues() {
  const added: { queue: string; name: string; data: Record<string, string>; jobId?: string }[] = [];
  const queues = {
    get: (queue: string) => ({
      add: async (name: string, data: Record<string, string>, opts?: { jobId?: string }) => {
        added.push({ queue, name, data, jobId: opts?.jobId });
      },
    }),
  } as unknown as JobQueues;
  return { queues, added };
}

const runJob = (
  queue: keyof ReturnType<typeof buildProcessors>,
  name: string,
  data: Record<string, string>,
) =>
  buildProcessors(ctx.container.cradle)[queue]({ name, data, id: 'test' } as unknown as Job<
    Record<string, string>
  >);

describe('cancellation and refunds', () => {
  it('cancelling an unpaid booking releases the slot and voids the payment', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 300 }]);
    const booked = await book(ctx, patient, slot!.id).expect(201);

    const res = await ctx
      .api()
      .post(`/v1/consultations/${booked.body.consultation.id}/cancel`)
      .set(bearer(patient))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Schedule changed' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'cancelled', refundScheduled: false });

    const [s] = await q<{ status: string }>('SELECT status FROM availability_slots WHERE id = $1', [
      slot!.id,
    ]);
    const [p] = await q<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
      booked.body.payment.id,
    ]);
    expect(s!.status).toBe('open');
    expect(p!.status).toBe('failed');

    // The freed slot can be booked again by someone else.
    await book(ctx, await registerPatient(ctx), slot!.id).expect(201);
  });

  it('refunds a paid booking cancelled outside the refund window, via outbox + worker', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 240 }]);
    const booked = await book(ctx, patient, slot!.id).expect(201);
    await confirmPayment(ctx, patient, booked.body.payment.id);

    const res = await ctx
      .api()
      .post(`/v1/consultations/${booked.body.consultation.id}/cancel`)
      .set(bearer(patient))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Feeling better' })
      .expect(200);
    expect(res.body.refundScheduled).toBe(true);

    const { queues, added } = fakeQueues();
    const relay = new OutboxRelay(
      ctx.container.cradle.db,
      queues,
      ctx.container.cradle.metrics,
      ctx.container.cradle.logger,
    );
    await relay.relayBatch();
    const refundJob = added.find((j) => j.name === 'refund');
    expect(refundJob).toMatchObject({ queue: 'payments', data: { aggregateId: booked.body.payment.id } });
    expect(added.some((j) => j.queue === 'notifications')).toBe(true);
    // Relayed events are not published twice.
    expect(await relay.relayBatch()).toBe(0);

    await runJob('payments', 'refund', refundJob!.data);
    const [p] = await q<{ status: string; provider_refund_id: string }>(
      'SELECT status, provider_refund_id FROM payments WHERE id = $1',
      [booked.body.payment.id],
    );
    expect(p).toMatchObject({ status: 'refunded', provider_refund_id: expect.stringMatching(/^rfnd_mock_/) });
    // Re-running the job (at-least-once delivery) is harmless.
    await runJob('payments', 'refund', refundJob!.data);
  });

  it('withholds the refund when a patient cancels inside the window', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 30 }]);
    const booked = await book(ctx, patient, slot!.id).expect(201);
    await confirmPayment(ctx, patient, booked.body.payment.id);
    const res = await ctx
      .api()
      .post(`/v1/consultations/${booked.body.consultation.id}/cancel`)
      .set(bearer(patient))
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Last minute' })
      .expect(200);
    expect(res.body.refundScheduled).toBe(false);
  });
});

describe('hold expiry (saga timeout) and late capture compensation', () => {
  it('expires unpaid holds and refunds a payment that arrives afterwards', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 500 }]);
    const booked = await book(ctx, patient, slot!.id).expect(201);
    const id = booked.body.consultation.id;

    await ctx.container.cradle.db.query(
      `UPDATE consultations SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await runJob('maintenance', 'expire-holds', {});

    const [c] = await q<{ status: string; cancellation_reason: string }>(
      'SELECT status, cancellation_reason FROM consultations WHERE id = $1',
      [id],
    );
    const [s] = await q<{ status: string }>('SELECT status FROM availability_slots WHERE id = $1', [
      slot!.id,
    ]);
    expect(c).toMatchObject({ status: 'cancelled', cancellation_reason: 'payment_timeout' });
    expect(s!.status).toBe('open');

    // The provider was slow: the capture lands after expiry. The payment flips to
    // 'failed' on expiry, so reset it to model a provider-side capture racing the timeout.
    await ctx.container.cradle.db.query(`UPDATE payments SET status = 'initiated' WHERE id = $1`, [
      booked.body.payment.id,
    ]);
    const late = await ctx.container.cradle.bookingService.onPaymentCaptured(
      booked.body.payment.providerPaymentId,
      'evt_late_1',
    );
    expect(late.outcome).toBe('refund_scheduled');
    const [p] = await q<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
      booked.body.payment.id,
    ]);
    expect(p!.status).toBe('refund_pending');
  });
});

describe('payment provider outage', () => {
  it('retries transient failures, then compensates and frees the slot', async () => {
    const gateway = ctx.container.cradle.paymentGateway as MockPaymentGateway;
    const doctor = await createVerifiedDoctor(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 900 }]);

    gateway.failNext = 2; // within the retry budget
    await book(ctx, await registerPatient(ctx), slot!.id).expect(201);

    const [slot2] = await publishSlots(ctx, doctor, [{ startInMin: 1000 }]);
    gateway.failNext = 10; // exhausts retries
    const res = await book(ctx, await registerPatient(ctx), slot2!.id).expect(503);
    expect(res.body.error.code).toBe('PAYMENT_UNAVAILABLE');
    gateway.failNext = 0;
    const [s] = await q<{ status: string }>('SELECT status FROM availability_slots WHERE id = $1', [
      slot2!.id,
    ]);
    expect(s!.status).toBe('open');
  });
});

describe('async prescription documents', () => {
  it('renders the PDF in the worker and serves it to the patient only', async () => {
    const doctor = await createVerifiedDoctor(ctx);
    const patient = await registerPatient(ctx);
    const [slot] = await publishSlots(ctx, doctor, [{ startInMin: 3 }]);
    const booked = await book(ctx, patient, slot!.id).expect(201);
    await confirmPayment(ctx, patient, booked.body.payment.id);
    const cid = booked.body.consultation.id;
    await ctx.api().post(`/v1/consultations/${cid}/start`).set(bearer(doctor)).expect(200);
    const rx = await ctx
      .api()
      .post(`/v1/consultations/${cid}/prescription`)
      .set(bearer(doctor))
      .set('Idempotency-Key', idemKey())
      .send({
        diagnosis: 'Vata imbalance',
        medications: [{ name: 'Dashamoola', dosage: '10ml', frequency: 'at night', durationDays: 21 }],
      })
      .expect(201);

    await ctx.api().get(`/v1/prescriptions/${rx.body.id}/document`).set(bearer(patient)).expect(409);
    await runJob('documents', 'render-prescription', { aggregateId: rx.body.id, patientId: patient.userId });

    const pdf = await ctx
      .api()
      .get(`/v1/prescriptions/${rx.body.id}/document`)
      .set(bearer(patient))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    await ctx
      .api()
      .get(`/v1/prescriptions/${rx.body.id}/document`)
      .set(bearer(await registerPatient(ctx)))
      .expect(404);
  });
});

describe('admin analytics and audit integrity', () => {
  it('reports aggregates from the refreshed materialized view', async () => {
    const admin = await createAdmin(ctx);
    await runJob('maintenance', 'refresh-analytics', {});
    const res = await ctx.api().get('/v1/admin/analytics/summary').set(bearer(admin)).expect(200);
    expect(res.body.totals.consultations).toBeGreaterThan(0);
    expect(res.body.totals.cancelled).toBeGreaterThan(0);
    expect(res.body.revenue.refundedPaise).toBeGreaterThan(0);
    expect(res.body.cancellationRate).toBeGreaterThan(0);
  });

  it('flags forged audit rows and refuses to rewrite history', async () => {
    const admin = await createAdmin(ctx);
    const { db } = ctx.container.cradle;
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, signature) VALUES ($1, 'consultation.viewed', 'consultation', 'forged-1', 'bogus')`,
      [admin.userId],
    );
    const res = await ctx
      .api()
      .get('/v1/admin/audit-logs')
      .query({ entityId: 'forged-1' })
      .set(bearer(admin))
      .expect(200);
    expect(res.body.data[0].signatureValid).toBe(false);

    await expect(db.query(`UPDATE audit_logs SET action = 'x' WHERE entity_id = 'forged-1'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM audit_logs WHERE entity_id = 'forged-1'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('exposes Prometheus metrics including booking outcomes', async () => {
    const patient = await registerPatient(ctx);
    // A rejected request must still be labelled with its full route template.
    await ctx.api().get('/v1/doctors').query({ minRating: 9 }).set(bearer(patient)).expect(400);
    const res = await ctx.api().get('/metrics').expect(200);
    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).toMatch(/booking_attempts_total\{outcome="held"\} \d+/);
    expect(res.text).toContain('route="/v1/doctors",status_code="400"');
    expect(res.text).not.toMatch(/route="\/",/);
  });

  it('reports readiness of dependencies', async () => {
    const res = await ctx.api().get('/readyz').expect(200);
    expect(res.body.checks).toEqual({ db: 'ok', redis: 'ok' });
  });
});
