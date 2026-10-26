import { ConflictError } from '../../lib/errors';

export const CONSULTATION_STATUSES = [
  'pending_payment',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

/**
 * The consultation lifecycle as an explicit state machine. Every status change goes through
 * `assertTransition` and a conditional UPDATE (`WHERE status = ANY(from)`), so an illegal or
 * racing transition can never be persisted.
 *
 *   pending_payment ──payment captured──▶ confirmed ──doctor starts──▶ in_progress ──▶ completed
 *         │                                  │  └──────patient absent──▶ no_show
 *         └── hold expired / cancelled ──▶ cancelled ◀── cancelled by patient/doctor/admin
 */
export const TRANSITIONS: Record<ConsultationStatus, readonly ConsultationStatus[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: ConsultationStatus, to: ConsultationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ConsultationStatus, to: ConsultationStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot move a consultation from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

/** Statuses from which `to` is reachable; used to build the conditional UPDATE. */
export function sourcesOf(to: ConsultationStatus): ConsultationStatus[] {
  return CONSULTATION_STATUSES.filter((s) => TRANSITIONS[s].includes(to));
}
