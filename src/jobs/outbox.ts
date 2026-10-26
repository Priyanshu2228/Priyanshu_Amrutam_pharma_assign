import type { Queryable } from '../db/database';

export type DomainEvent =
  | 'consultation.held'
  | 'consultation.confirmed'
  | 'consultation.cancelled'
  | 'consultation.completed'
  | 'payment.refund_requested'
  | 'prescription.issued';

/**
 * Writes a domain event in the caller's transaction (transactional outbox). The relay in
 * the worker publishes it to the queue only after commit, so side effects (notifications,
 * refunds, PDFs) can never fire for a rolled-back change.
 */
export class OutboxService {
  async add(
    tx: Queryable,
    event: {
      type: DomainEvent;
      aggregateType: string;
      aggregateId: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.query(
      'INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4)',
      [event.aggregateType, event.aggregateId, event.type, event.payload ?? {}],
    );
  }
}
