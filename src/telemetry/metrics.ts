import client from 'prom-client';

/**
 * Application metrics. A dedicated registry keeps tests isolated and lets the API and
 * worker processes expose only what they own.
 */
export class Metrics {
  readonly registry = new client.Registry();

  readonly httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route',
    labelNames: ['method', 'route', 'status_code'] as const,
    // Bucket edges straddle the SLOs: 200ms p95 reads, 500ms p95 writes.
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly bookingAttempts = new client.Counter({
    name: 'booking_attempts_total',
    help: 'Consultation booking attempts by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly consultationTransitions = new client.Counter({
    name: 'consultation_transitions_total',
    help: 'Consultation state transitions',
    labelNames: ['to'] as const,
    registers: [this.registry],
  });

  readonly idempotentReplays = new client.Counter({
    name: 'idempotent_replays_total',
    help: 'Write requests answered from the idempotency store',
    registers: [this.registry],
  });

  readonly cacheRequests = new client.Counter({
    name: 'cache_requests_total',
    help: 'Cache lookups by namespace and result',
    labelNames: ['namespace', 'result'] as const,
    registers: [this.registry],
  });

  readonly rateLimited = new client.Counter({
    name: 'rate_limited_requests_total',
    help: 'Requests rejected by the rate limiter',
    labelNames: ['limiter'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new client.Histogram({
    name: 'job_duration_seconds',
    help: 'Background job processing time',
    labelNames: ['queue', 'job', 'status'] as const,
    buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [this.registry],
  });

  readonly outboxLag = new client.Gauge({
    name: 'outbox_unpublished_events',
    help: 'Outbox events waiting to be published',
    registers: [this.registry],
  });

  readonly externalCalls = new client.Counter({
    name: 'external_calls_total',
    help: 'Calls to external providers by outcome',
    labelNames: ['provider', 'operation', 'outcome'] as const,
    registers: [this.registry],
  });

  constructor() {
    client.collectDefaultMetrics({ register: this.registry });
  }
}
