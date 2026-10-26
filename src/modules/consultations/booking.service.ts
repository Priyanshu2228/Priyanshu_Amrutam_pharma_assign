import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env';
import type { Database } from '../../db/database';
import type { OutboxService } from '../../jobs/outbox';
import type { CacheService } from '../../lib/cache';
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError } from '../../lib/errors';
import type { FieldCrypto } from '../../lib/field-crypto';
import type { Metrics } from '../../telemetry/metrics';
import type { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/rbac';
import { slotCacheNamespace } from '../availability/availability.service';
import type { SlotsRepository } from '../availability/slots.repository';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import type { PaymentsRepository } from '../payments/payments.repository';
import type { PaymentsService } from '../payments/payments.service';
import { assertTransition, sourcesOf } from './consultation-state';
import type { ConsultationRecord, ConsultationsRepository } from './consultations.repository';
import { presentConsultation, type ConsultationView } from './consultation.presenter';

interface Deps {
  config: AppConfig;
  db: Database;
  logger: Logger;
  metrics: Metrics;
  fieldCrypto: FieldCrypto;
  cacheService: CacheService;
  auditService: AuditService;
  outboxService: OutboxService;
  slotsRepository: SlotsRepository;
  doctorsRepository: DoctorsRepository;
  consultationsRepository: ConsultationsRepository;
  paymentsRepository: PaymentsRepository;
  paymentsService: PaymentsService;
}

export interface BookingResult {
  consultation: ConsultationView;
  payment: {
    id: string;
    status: string;
    amountPaise: number;
    currency: string;
    provider: string;
    providerPaymentId: string;
    clientSecret: string;
  };
}

/**
 * Booking saga (orchestrated):
 *
 *   1. HOLD     tx: slot open->held, consultation(pending_payment), payment(initiated), outbox, audit
 *   2. INTENT   provider call outside the tx (never hold DB locks across the network)
 *               └─ on failure: COMPENSATE -> cancel consultation, release slot, fail payment
 *   3. CAPTURE  webhook tx: payment captured, consultation confirmed, slot booked, outbox
 *               └─ capture after the hold expired: COMPENSATE -> schedule refund
 *   4. TIMEOUT  worker: expired holds -> cancelled, slot released, payment failed
 *
 * Lock order is always consultation -> payment -> slot, which rules out deadlocks between
 * the webhook, the cancel path and the expiry job.
 */
export class BookingService {
  constructor(private readonly d: Deps) {}

  async book(patientId: string, input: { slotId: string; reason?: string }): Promise<BookingResult> {
    const holdUntil = new Date(Date.now() + this.d.config.booking.slotHoldMinutes * 60_000);
    let held: {
      consultation: ConsultationRecord;
      payment: Awaited<ReturnType<PaymentsRepository['insert']>>;
    };
    try {
      held = await this.d.db.withTransaction(async (tx) => {
        const slot = await this.d.slotsRepository.hold(tx, input.slotId, holdUntil);
        if (!slot) {
          const existing = await this.d.slotsRepository.findById(input.slotId, tx);
          if (!existing) throw new NotFoundError('Slot');
          throw new ConflictError(
            'SLOT_UNAVAILABLE',
            'This slot has just been taken or is no longer bookable',
          );
        }
        const doctor = await this.d.doctorsRepository.findById(slot.doctorId, tx);
        if (!doctor?.isVerified)
          throw new ConflictError('DOCTOR_UNAVAILABLE', 'This doctor is not accepting bookings');

        const consultation = await this.d.consultationsRepository.insert(tx, {
          patientId,
          doctorId: slot.doctorId,
          slotId: slot.id,
          scheduledStart: slot.startAt,
          scheduledEnd: slot.endAt,
          holdExpiresAt: holdUntil,
          feePaise: doctor.consultationFeePaise,
          reasonEnc: this.d.fieldCrypto.encryptNullable(input.reason),
        });
        const payment = await this.d.paymentsRepository.insert(tx, {
          consultationId: consultation.id,
          amountPaise: doctor.consultationFeePaise,
          provider: this.d.paymentsService.providerName,
        });
        await this.d.outboxService.add(tx, {
          type: 'consultation.held',
          aggregateType: 'consultation',
          aggregateId: consultation.id,
          payload: { holdExpiresAt: holdUntil.toISOString() },
        });
        await this.d.auditService.record(
          {
            action: 'consultation.booked',
            entityType: 'consultation',
            entityId: consultation.id,
            metadata: { slotId: slot.id, doctorId: slot.doctorId, paymentId: payment.id },
          },
          tx,
        );
        return { consultation, payment };
      });
    } catch (err) {
      this.d.metrics.bookingAttempts.inc({ outcome: err instanceof ConflictError ? 'conflict' : 'error' });
      throw err;
    }
    await this.d.cacheService.bump(slotCacheNamespace(held.consultation.doctorId));

    try {
      const intent = await this.d.paymentsService.createIntent(held.payment);
      this.d.metrics.bookingAttempts.inc({ outcome: 'held' });
      return {
        consultation: presentConsultation(held.consultation, this.d.fieldCrypto),
        payment: {
          id: held.payment.id,
          status: held.payment.status,
          amountPaise: held.payment.amountPaise,
          currency: held.payment.currency,
          provider: held.payment.provider,
          providerPaymentId: intent.providerPaymentId,
          clientSecret: intent.clientSecret,
        },
      };
    } catch (err) {
      this.d.logger.error(
        { err, consultationId: held.consultation.id },
        'payment intent failed; compensating booking',
      );
      this.d.metrics.bookingAttempts.inc({ outcome: 'payment_unavailable' });
      await this.compensate(held.consultation.id, 'payment_init_failed');
      throw new ServiceUnavailableError(
        'PAYMENT_UNAVAILABLE',
        'Payments are temporarily unavailable, please retry',
      );
    }
  }

  /** Saga step 3. Idempotent per provider event id. */
  async onPaymentCaptured(
    providerPaymentId: string,
    eventId: string,
  ): Promise<{ outcome: string; consultationId?: string }> {
    const result = await this.d.db.withTransaction(async (tx) => {
      if (
        !(await this.d.paymentsRepository.markEventProcessed(
          tx,
          this.d.paymentsService.providerName,
          eventId,
        ))
      ) {
        return { outcome: 'duplicate' };
      }
      const ref = await this.d.paymentsRepository.findByProviderId(providerPaymentId, tx);
      if (!ref) throw new NotFoundError('Payment');
      const consultation = await this.d.consultationsRepository.findById(ref.consultationId, tx, {
        forUpdate: true,
      });
      const payment = await this.d.paymentsRepository.findById(ref.id, tx, { forUpdate: true });
      if (!consultation || !payment) throw new NotFoundError('Payment');
      if (payment.status !== 'initiated') return { outcome: 'ignored', consultationId: consultation.id };

      if (consultation.status === 'pending_payment') {
        await this.d.paymentsRepository.setStatus(tx, payment.id, ['initiated'], 'captured');
        await this.d.consultationsRepository.transition(
          tx,
          consultation.id,
          ['pending_payment'],
          'confirmed',
          {
            holdExpiresAt: null,
          },
        );
        await this.d.slotsRepository.markBooked(tx, consultation.slotId);
        await this.d.outboxService.add(tx, {
          type: 'consultation.confirmed',
          aggregateType: 'consultation',
          aggregateId: consultation.id,
          payload: { patientId: consultation.patientId, doctorId: consultation.doctorId },
        });
        await this.d.auditService.record(
          {
            action: 'consultation.confirmed',
            entityType: 'consultation',
            entityId: consultation.id,
            actorRole: 'system',
            metadata: { paymentId: payment.id, amountPaise: payment.amountPaise },
          },
          tx,
        );
        return { outcome: 'confirmed', consultationId: consultation.id };
      }

      // Money arrived for a consultation that already lapsed: compensate with a refund.
      await this.d.paymentsRepository.setStatus(tx, payment.id, ['initiated'], 'refund_pending');
      await this.scheduleRefund(tx, payment.id, consultation.id, 'late_capture');
      return { outcome: 'refund_scheduled', consultationId: consultation.id };
    });
    if (result.outcome === 'confirmed') this.d.metrics.consultationTransitions.inc({ to: 'confirmed' });
    return result;
  }

  async onPaymentFailed(
    providerPaymentId: string,
    eventId: string,
    reason?: string,
  ): Promise<{ outcome: string }> {
    const outcome = await this.d.db.withTransaction(async (tx) => {
      if (
        !(await this.d.paymentsRepository.markEventProcessed(
          tx,
          this.d.paymentsService.providerName,
          eventId,
        ))
      ) {
        return 'duplicate';
      }
      const ref = await this.d.paymentsRepository.findByProviderId(providerPaymentId, tx);
      if (!ref) throw new NotFoundError('Payment');
      const consultation = await this.d.consultationsRepository.findById(ref.consultationId, tx, {
        forUpdate: true,
      });
      if (!consultation) throw new NotFoundError('Consultation');
      await this.d.paymentsRepository.setStatus(tx, ref.id, ['initiated'], 'failed', {
        failureReason: reason ?? 'declined',
      });
      // A decline releases the slot right away instead of waiting for the hold to lapse.
      const cancelled = await this.d.consultationsRepository.transition(
        tx,
        consultation.id,
        ['pending_payment'],
        'cancelled',
        {
          cancellationReason: 'payment_failed',
          cancelledAt: new Date(),
          holdExpiresAt: null,
        },
      );
      if (cancelled) {
        await this.d.slotsRepository.release(tx, [consultation.slotId]);
        await this.d.outboxService.add(tx, {
          type: 'consultation.cancelled',
          aggregateType: 'consultation',
          aggregateId: consultation.id,
          payload: { reason: 'payment_failed' },
        });
      }
      await this.d.auditService.record(
        {
          action: 'payment.failed',
          entityType: 'payment',
          entityId: ref.id,
          actorRole: 'system',
          metadata: { reason },
        },
        tx,
      );
      return cancelled ? 'cancelled' : 'ignored';
    });
    return { outcome };
  }

  async cancel(
    actor: { userId: string; role: Role },
    consultationId: string,
    reason: string,
  ): Promise<ConsultationView & { refundScheduled: boolean }> {
    const { consultation, refund } = await this.d.db.withTransaction(async (tx) => {
      const current = await this.d.consultationsRepository.findById(consultationId, tx, { forUpdate: true });
      if (!current) throw new NotFoundError('Consultation');
      const isOwner =
        (actor.role === 'patient' && current.patientId === actor.userId) ||
        (actor.role === 'doctor' && current.doctorId === actor.userId) ||
        actor.role === 'admin';
      if (!isOwner) throw new NotFoundError('Consultation');
      assertTransition(current.status, 'cancelled');

      const updated = await this.d.consultationsRepository.transition(
        tx,
        current.id,
        sourcesOf('cancelled'),
        'cancelled',
        {
          cancelledBy: actor.userId,
          cancellationReason: reason,
          cancelledAt: new Date(),
          holdExpiresAt: null,
        },
      );
      if (!updated) throw new ConflictError('CONCURRENT_UPDATE', 'Consultation changed, please retry');

      let refund = false;
      const payment = await this.d.paymentsRepository.findLatestForConsultation(tx, current.id);
      if (payment?.status === 'initiated') {
        await this.d.paymentsRepository.setStatus(tx, payment.id, ['initiated'], 'failed', {
          failureReason: 'cancelled',
        });
      } else if (payment?.status === 'captured') {
        // Policy: doctor/admin cancellations always refund; patients get a refund only
        // when they cancel at least REFUND_WINDOW_HOURS before the start.
        const hoursToStart = (current.scheduledStart.getTime() - Date.now()) / 3_600_000;
        refund = actor.role !== 'patient' || hoursToStart >= this.d.config.booking.refundWindowHours;
        if (refund) {
          await this.d.paymentsRepository.setStatus(tx, payment.id, ['captured'], 'refund_pending');
          await this.scheduleRefund(tx, payment.id, current.id, 'cancellation');
        }
      }
      await this.d.slotsRepository.release(tx, [current.slotId]);
      await this.d.outboxService.add(tx, {
        type: 'consultation.cancelled',
        aggregateType: 'consultation',
        aggregateId: current.id,
        payload: { cancelledBy: actor.role, refund },
      });
      await this.d.auditService.record(
        {
          action: 'consultation.cancelled',
          entityType: 'consultation',
          entityId: current.id,
          metadata: { from: current.status, refund },
        },
        tx,
      );
      return { consultation: updated, refund };
    });
    this.d.metrics.consultationTransitions.inc({ to: 'cancelled' });
    await this.d.cacheService.bump(slotCacheNamespace(consultation.doctorId));
    return { ...presentConsultation(consultation, this.d.fieldCrypto), refundScheduled: refund };
  }

  /** Saga step 4, run periodically by the worker. */
  async expireHolds(batchSize = 200): Promise<number> {
    const expired = await this.d.db.withTransaction(async (tx) => {
      const rows = await this.d.consultationsRepository.expireHolds(tx, batchSize);
      if (rows.length === 0) return rows;
      await this.d.paymentsRepository.failInitiatedForConsultations(
        tx,
        rows.map((r) => r.id),
        'hold_expired',
      );
      await this.d.slotsRepository.release(
        tx,
        rows.map((r) => r.slotId),
      );
      for (const r of rows) {
        await this.d.outboxService.add(tx, {
          type: 'consultation.cancelled',
          aggregateType: 'consultation',
          aggregateId: r.id,
          payload: { reason: 'payment_timeout' },
        });
        await this.d.auditService.record(
          {
            action: 'consultation.expired',
            entityType: 'consultation',
            entityId: r.id,
            actorId: null,
            actorRole: 'system',
          },
          tx,
        );
      }
      return rows;
    });
    for (const doctorId of new Set(expired.map((r) => r.doctorId))) {
      await this.d.cacheService.bump(slotCacheNamespace(doctorId));
    }
    return expired.length;
  }

  private async compensate(consultationId: string, reason: string): Promise<void> {
    try {
      const doctorId = await this.d.db.withTransaction(async (tx) => {
        const c = await this.d.consultationsRepository.transition(
          tx,
          consultationId,
          ['pending_payment'],
          'cancelled',
          {
            cancellationReason: reason,
            cancelledAt: new Date(),
            holdExpiresAt: null,
          },
        );
        if (!c) return null;
        await this.d.paymentsRepository.failInitiatedForConsultations(tx, [c.id], reason);
        await this.d.slotsRepository.release(tx, [c.slotId]);
        await this.d.auditService.record(
          {
            action: 'consultation.compensated',
            entityType: 'consultation',
            entityId: c.id,
            metadata: { reason },
          },
          tx,
        );
        return c.doctorId;
      });
      if (doctorId) await this.d.cacheService.bump(slotCacheNamespace(doctorId));
    } catch (err) {
      // The hold-expiry job is the backstop: the slot frees itself when the hold lapses.
      this.d.logger.error({ err, consultationId }, 'compensation failed; hold expiry will reconcile');
      if (err instanceof AppError && err.status < 500) throw err;
    }
  }

  private async scheduleRefund(
    tx: Parameters<OutboxService['add']>[0],
    paymentId: string,
    consultationId: string,
    cause: string,
  ): Promise<void> {
    await this.d.outboxService.add(tx, {
      type: 'payment.refund_requested',
      aggregateType: 'payment',
      aggregateId: paymentId,
      payload: { consultationId, cause },
    });
    await this.d.auditService.record(
      {
        action: 'payment.refund_requested',
        entityType: 'payment',
        entityId: paymentId,
        metadata: { consultationId, cause },
      },
      tx,
    );
  }
}
