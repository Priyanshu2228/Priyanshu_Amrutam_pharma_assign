import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const QUEUES = {
  notifications: 'notifications',
  payments: 'payments',
  documents: 'documents',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Every job retries with exponential backoff (2s, 4s, 8s, ...). Jobs that exhaust their
 * attempts stay in the queue's failed set, which acts as the dead-letter queue and is
 * alerted on (see infra/observability/prometheus/alerts.yml).
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 1_000, age: 24 * 3600 },
  removeOnFail: { count: 10_000 },
};

export class JobQueues {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  get(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, q);
    }
    return q;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
