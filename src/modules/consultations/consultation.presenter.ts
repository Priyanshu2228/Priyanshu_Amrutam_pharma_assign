import type { FieldCrypto } from '../../lib/field-crypto';
import type { ConsultationStatus } from './consultation-state';
import type { ConsultationRecord } from './consultations.repository';

export interface ConsultationView {
  id: string;
  patientId: string;
  doctorId: string;
  slotId: string;
  status: ConsultationStatus;
  scheduledStart: string;
  scheduledEnd: string;
  holdExpiresAt: string | null;
  feePaise: number;
  reason: string | null;
  doctorNotes: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cancellation: { by: string | null; reason: string | null; at: string } | null;
  createdAt: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Decrypts PHI only at the edge, for a caller already authorised to see it. */
export function presentConsultation(c: ConsultationRecord, crypto: FieldCrypto): ConsultationView {
  return {
    id: c.id,
    patientId: c.patientId,
    doctorId: c.doctorId,
    slotId: c.slotId,
    status: c.status,
    scheduledStart: c.scheduledStart.toISOString(),
    scheduledEnd: c.scheduledEnd.toISOString(),
    holdExpiresAt: iso(c.holdExpiresAt),
    feePaise: c.feePaise,
    reason: crypto.decryptNullable(c.reasonEnc),
    doctorNotes: crypto.decryptNullable(c.doctorNotesEnc),
    startedAt: iso(c.startedAt),
    endedAt: iso(c.endedAt),
    cancellation: c.cancelledAt
      ? { by: c.cancelledBy, reason: c.cancellationReason, at: c.cancelledAt.toISOString() }
      : null,
    createdAt: c.createdAt.toISOString(),
  };
}
