import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env';
import { PgCodes, pgCode } from '../lib/errors';
import { retry } from '../lib/retry';

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Thin wrapper over node-postgres with a primary/replica split and a transaction helper
 * that retries serialization failures and deadlocks with jittered backoff.
 */
export class Database implements Queryable {
  readonly primary: Pool;
  private readonly replica?: Pool;
  private readonly logger: Logger;

  constructor({ config, logger }: { config: AppConfig; logger: Logger }) {
    this.logger = logger;
    const common = {
      max: config.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Bound every statement so one slow query cannot exhaust the pool.
      statement_timeout: config.db.statementTimeoutMs,
      idle_in_transaction_session_timeout: 10_000,
      application_name: 'amrutam-api',
    };
    this.primary = new Pool({ connectionString: config.db.url, ...common });
    this.primary.on('error', (err) => logger.error({ err }, 'idle primary client error'));
    if (config.db.replicaUrl) {
      this.replica = new Pool({ connectionString: config.db.replicaUrl, ...common });
      this.replica.on('error', (err) => logger.error({ err }, 'idle replica client error'));
    }
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.primary.query<R>(text, values);
  }

  /**
   * Read-only, lag-tolerant queries (search, analytics). Falls back to the primary when
   * no replica is configured. Never use for read-your-own-write paths.
   */
  get read(): Queryable {
    return this.replica ?? this.primary;
  }

  async withTransaction<T>(
    fn: (tx: Queryable) => Promise<T>,
    opts: { isolation?: IsolationLevel; retries?: number } = {},
  ): Promise<T> {
    const isolation = opts.isolation ?? 'READ COMMITTED';
    return retry(
      async () => {
        const client: PoolClient = await this.primary.connect();
        try {
          await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      },
      {
        retries: opts.retries ?? 3,
        baseDelayMs: 20,
        maxDelayMs: 250,
        shouldRetry: (err) => {
          const code = pgCode(err);
          return code === PgCodes.SERIALIZATION_FAILURE || code === PgCodes.DEADLOCK_DETECTED;
        },
        onRetry: (err, attempt) => this.logger.warn({ err, attempt }, 'retrying transaction'),
      },
    );
  }

  async ping(): Promise<void> {
    await this.primary.query('SELECT 1');
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.end(), this.replica?.end()]);
  }
}
