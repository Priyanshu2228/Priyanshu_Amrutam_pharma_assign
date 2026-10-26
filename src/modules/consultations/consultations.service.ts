import type { Database } from '../../db/database';
import type { OutboxService } from '../../jobs/outbox';
import { ConflictError, NotFoundError } from '../../lib/errors';
import type { FieldCrypto } from '../../lib/field-crypto';
import type { Page } from '../../lib/pagination';
import type { Metrics } from '../../telemetry/metrics';
import type { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/rbac';
import { assertTransition, type ConsultationStatus } from './consultation-state';
import { presentConsultation, type ConsultationView } from './consultation.presenter';
import type { ConsultationRecord, ConsultationsRepository } from './consultations.repository';

/** Doctors may open the call this long before the scheduled start. */
const EARLY_START_MINUTES = 10;
/** A patient is a no-show if absent this long after the start. */
const NO_SHOW_GRACE_MINUTES = 15;

interface Deps {
  db: Database;
  metrics: Metrics;
  fieldCrypto: FieldCrypto;
  auditService: AuditService;
  outboxService: OutboxService;
  consultationsRepository: ConsultationsRepository;
}

export interface Viewer {
  userId: string;
  role: Role;
}

export class ConsultationsService {
  constructor(private readonly d: Deps) {}

  /** Patients see their own, doctors their assigned, admins everything (metadata only is audited). */
  async list(
    viewer: Viewer,
    filter: { status?: ConsultationStatus; from?: Date; to?: Date; limit: number; cursor?: string },
  ): Promise<Page<ConsultationView>> {
    const scope =
      viewer.role === 'patient'
        ? { patientId: viewer.userId }
        : viewer.role === 'doctor'
          ? { doctorId: viewer.userId }
          : {};
    const page = await this.d.consultationsRepository.list({ ...filter, ...scope });
    return { data: page.data.map((c) => this.present(c, viewer)), nextCursor: page.nextCursor };
  }

  async get(viewer: Viewer, id: string): Promise<ConsultationView> {
    const c = await this.d.consultationsRepository.findById(id);
    if (!c || !canView(viewer, c)) throw new NotFoundError('Consultation');
    if (viewer.userId !== c.patientId) {
      // Access to a patient's record by anyone else is a compliance event.
      await this.d.auditService.record({
        action: 'consultation.viewed',
        entityType: 'consultation',
        entityId: c.id,
      });
    }
    return this.present(c, viewer);
  }

  async start(doctorId: string, id: string): Promise<ConsultationView & { videoRoomId: string }> {
    const updated = await this.d.db.withTransaction(async (tx) => {
      const c = await this.loadAssigned(tx, doctorId, id);
      assertTransition(c.status, 'in_progress');
      const now = Date.now();
      if (now < c.scheduledStart.getTime() - EARLY_START_MINUTES * 60_000) {
        throw new ConflictError(
          'TOO_EARLY',
          `Consultations can be started at most ${EARLY_START_MINUTES} minutes early`,
        );
      }
      if (now > c.scheduledEnd.getTime())
        throw new ConflictError('SLOT_ELAPSED', 'The scheduled window has passed');
      const next = await this.d.consultationsRepository.transition(tx, c.id, ['confirmed'], 'in_progress', {
        startedAt: new Date(),
      });
      if (!next) throw new ConflictError('CONCURRENT_UPDATE', 'Consultation changed, please retry');
      await this.d.auditService.record(
        { action: 'consultation.started', entityType: 'consultation', entityId: c.id },
        tx,
      );
      return next;
    });
    this.d.metrics.consultationTransitions.inc({ to: 'in_progress' });
    // The video provider room is keyed by consultation id; tokens are minted by the client SDK flow.
    return {
      ...this.present(updated, { userId: doctorId, role: 'doctor' }),
      videoRoomId: `consult-${updated.id}`,
    };
  }

  async complete(doctorId: string, id: string, notes?: string): Promise<ConsultationView> {
    const updated = await this.d.db.withTransaction(async (tx) => {
      const c = await this.loadAssigned(tx, doctorId, id);
      assertTransition(c.status, 'completed');
      const next = await this.d.consultationsRepository.transition(tx, c.id, ['in_progress'], 'completed', {
        endedAt: new Date(),
        doctorNotesEnc: notes === undefined ? undefined : this.d.fieldCrypto.encrypt(notes),
      });
      if (!next) throw new ConflictError('CONCURRENT_UPDATE', 'Consultation changed, please retry');
      await this.d.outboxService.add(tx, {
        type: 'consultation.completed',
        aggregateType: 'consultation',
        aggregateId: c.id,
        payload: { patientId: c.patientId, doctorId: c.doctorId },
      });
      await this.d.auditService.record(
        { action: 'consultation.completed', entityType: 'consultation', entityId: c.id },
        tx,
      );
      return next;
    });
    this.d.metrics.consultationTransitions.inc({ to: 'completed' });
    return this.present(updated, { userId: doctorId, role: 'doctor' });
  }

  async markNoShow(doctorId: string, id: string): Promise<ConsultationView> {
    const updated = await this.d.db.withTransaction(async (tx) => {
      const c = await this.loadAssigned(tx, doctorId, id);
      assertTransition(c.status, 'no_show');
      if (Date.now() < c.scheduledStart.getTime() + NO_SHOW_GRACE_MINUTES * 60_000) {
        throw new ConflictError(
          'TOO_EARLY',
          `A no-show can be recorded ${NO_SHOW_GRACE_MINUTES} minutes after the start`,
        );
      }
      const next = await this.d.consultationsRepository.transition(tx, c.id, ['confirmed'], 'no_show');
      if (!next) throw new ConflictError('CONCURRENT_UPDATE', 'Consultation changed, please retry');
      await this.d.auditService.record(
        { action: 'consultation.no_show', entityType: 'consultation', entityId: c.id },
        tx,
      );
      return next;
    });
    this.d.metrics.consultationTransitions.inc({ to: 'no_show' });
    return this.present(updated, { userId: doctorId, role: 'doctor' });
  }

  private async loadAssigned(
    tx: Parameters<ConsultationsRepository['findById']>[1],
    doctorId: string,
    id: string,
  ): Promise<ConsultationRecord> {
    const c = await this.d.consultationsRepository.findById(id, tx, { forUpdate: true });
    if (!c || c.doctorId !== doctorId) throw new NotFoundError('Consultation');
    return c;
  }

  /**
   * Admins manage operations, not care: they get scheduling metadata but never the clinical
   * free text (minimum-necessary access).
   */
  private present(c: ConsultationRecord, viewer: Viewer): ConsultationView {
    const view = presentConsultation(c, this.d.fieldCrypto);
    return viewer.role === 'admin' ? { ...view, reason: null, doctorNotes: null } : view;
  }
}

export function canView(viewer: Viewer, c: Pick<ConsultationRecord, 'patientId' | 'doctorId'>): boolean {
  return (
    viewer.role === 'admin' ||
    (viewer.role === 'patient' && c.patientId === viewer.userId) ||
    (viewer.role === 'doctor' && c.doctorId === viewer.userId)
  );
}
