import { shutdownTracing } from './telemetry/tracing';
import http from 'node:http';
import { Worker, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { buildContainer, type Cradle } from './container';
import { OutboxRelay } from './jobs/outbox-relay';
import { JobQueues, QUEUES, type QueueName } from './jobs/queues';
import { requestContext } from './telemetry/context';

/**
 * Background worker process: runs the outbox relay loop and BullMQ consumers. Scaled
 * independently of the API so heavy work (PDFs, refunds, aggregates) never competes with
 * request latency.
 */
async function main() {
  const container = buildContainer();
  const c = container.cradle;
  const { logger, config, metrics } = c;

  // BullMQ needs a blocking connection with unlimited retries per request.
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const queues = new JobQueues(connection);
  const relay = new OutboxRelay(c.db, queues, metrics, logger);

  const processors = buildProcessors(c);
  const workers = (Object.keys(processors) as QueueName[]).map((queue) => {
    const worker = new Worker(queue, instrument(queue, processors[queue], c), {
      connection,
      concurrency: queue === QUEUES.documents ? 2 : 10,
    });
    worker.on('failed', (job, err) =>
      logger.error({ err, queue, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade }, 'job failed'),
    );
    return worker;
  });

  // Periodic maintenance as BullMQ repeatable jobs: exactly one run per tick cluster-wide.
  const maintenance = queues.get(QUEUES.maintenance);
  await maintenance.upsertJobScheduler('expire-holds', { every: 30_000 }, { name: 'expire-holds' });
  await maintenance.upsertJobScheduler(
    'refresh-analytics',
    { every: 5 * 60_000 },
    { name: 'refresh-analytics' },
  );
  await maintenance.upsertJobScheduler(
    'audit-partitions',
    { pattern: '0 3 * * *' },
    { name: 'audit-partitions' },
  );
  await maintenance.upsertJobScheduler(
    'purge-idempotency-keys',
    { every: 60 * 60_000 },
    { name: 'purge-idempotency-keys' },
  );

  // Outbox relay: tight loop with backoff when idle. SKIP LOCKED makes multiple workers safe.
  let running = true;
  const relayLoop = (async () => {
    let lagTick = 0;
    while (running) {
      try {
        const n = await relay.relayBatch();
        if (++lagTick % 10 === 0) await relay.refreshLagMetric();
        if (n === 0) await sleep(500);
      } catch (err) {
        logger.error({ err }, 'outbox relay iteration failed');
        await sleep(2_000);
      }
    }
  })();

  // Liveness + metrics for the worker.
  const port = Number(process.env.WORKER_METRICS_PORT ?? 9464);
  const probe = http
    .createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', metrics.registry.contentType);
        res.end(await metrics.registry.metrics());
        return;
      }
      res.end(JSON.stringify({ status: running ? 'ok' : 'stopping' }));
    })
    .listen(port, () => logger.info({ port }, 'worker started'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    running = false;
    await relayLoop;
    await Promise.all(workers.map((w) => w.close()));
    await queues.close();
    await connection.quit();
    probe.close();
    await container.dispose();
    await shutdownTracing();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

type JobData = Record<string, string | undefined> & { aggregateId?: string; eventType?: string };

export function buildProcessors(c: Cradle): Record<QueueName, Processor<JobData>> {
  return {
    [QUEUES.notifications]: async (job) => {
      const consultation = await c.consultationsRepository.findById(job.data.aggregateId!);
      if (!consultation) return;
      const template = (
        {
          'consultation.confirmed': 'consultation_confirmed',
          'consultation.cancelled': 'consultation_cancelled',
          'consultation.completed': 'consultation_completed',
        } as const
      )[job.data.eventType as 'consultation.confirmed'];
      if (!template) return;
      const data = {
        consultationId: consultation.id,
        scheduledStart: consultation.scheduledStart.toISOString(),
      };
      await c.notificationSender.send({ userId: consultation.patientId, template, data });
      await c.notificationSender.send({ userId: consultation.doctorId, template, data });
    },

    [QUEUES.payments]: async (job) => {
      if (job.name === 'refund') await c.paymentsService.processRefund(job.data.aggregateId!);
    },

    [QUEUES.documents]: async (job) => {
      if (job.name !== 'render-prescription') return;
      await c.prescriptionsService.renderDocument(job.data.aggregateId!);
      if (job.data.patientId) {
        await c.notificationSender.send({
          userId: job.data.patientId,
          template: 'prescription_ready',
          data: { prescriptionId: job.data.aggregateId! },
        });
      }
    },

    [QUEUES.maintenance]: async (job) => {
      switch (job.name) {
        case 'expire-holds': {
          const n = await c.bookingService.expireHolds();
          if (n) c.logger.info({ expired: n }, 'expired unpaid holds');
          return;
        }
        case 'refresh-analytics':
          await c.db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY consultation_daily_stats');
          return;
        case 'audit-partitions':
          await c.db.query(
            `SELECT ensure_audit_partition((date_trunc('month', now()) + make_interval(months => m))::date)
               FROM generate_series(0, 2) AS m`,
          );
          return;
        case 'purge-idempotency-keys':
          await c.db.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
          return;
      }
    },
  };
}

function instrument(queue: QueueName, fn: Processor<JobData>, c: Cradle): Processor<JobData> {
  return async (job: Job<JobData>, token?: string) => {
    const end = c.metrics.jobDuration.startTimer({ queue, job: job.name });
    try {
      const result = await requestContext.run({ requestId: `job:${job.id}`, actorRole: 'system' }, () =>
        fn(job, token),
      );
      end({ status: 'success' });
      return result;
    } catch (err) {
      end({ status: 'failure' });
      throw err;
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('worker failed to start', err);
    process.exit(1);
  });
}
