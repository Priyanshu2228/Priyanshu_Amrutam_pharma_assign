import type { Logger } from 'pino';
import type { Database } from '../db/database';
import type { Metrics } from '../telemetry/metrics';
import type { DomainEvent } from './outbox';
import { QUEUES, type JobQueues, type QueueName } from './queues';

interface OutboxRow {
  id: string;
  event_type: DomainEvent;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

/** Which background job each domain event triggers. */
const ROUTES: Partial<Record<DomainEvent, { queue: QueueName; job: string }>> = {
  'consultation.confirmed': { queue: QUEUES.notifications, job: 'consultation-event' },
  'consultation.cancelled': { queue: QUEUES.notifications, job: 'consultation-event' },
  'consultation.completed': { queue: QUEUES.notifications, job: 'consultation-event' },
  'payment.refund_requested': { queue: QUEUES.payments, job: 'refund' },
  'prescription.issued': { queue: QUEUES.documents, job: 'render-prescription' },
};

/**
 * Publishes committed outbox events to BullMQ. Delivery is at-least-once: the job id is
 * the event id (BullMQ drops duplicates while the job is retained) and every consumer is
 * idempotent, which together give effectively-once processing.
 */
export class OutboxRelay {
  constructor(
    private readonly db: Database,
    private readonly queues: JobQueues,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async relayBatch(limit = 100): Promise<number> {
    const published = await this.db.withTransaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, event_type, aggregate_id, payload FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      for (const row of rows) {
        const route = ROUTES[row.event_type];
        if (!route) continue;
        await this.queues
          .get(route.queue)
          .add(
            route.job,
            { eventId: row.id, eventType: row.event_type, aggregateId: row.aggregate_id, ...row.payload },
            { jobId: row.id },
          );
      }
      if (rows.length) {
        await tx.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::uuid[])', [
          rows.map((r) => r.id),
        ]);
      }
      return rows.length;
    });
    if (published) this.logger.debug({ published }, 'outbox events relayed');
    return published;
  }

  async refreshLagMetric(): Promise<void> {
    const { rows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL',
    );
    this.metrics.outboxLag.set(rows[0]?.n ?? 0);
  }
}
