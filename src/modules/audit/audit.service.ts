import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config/env';
import type { Database, Queryable } from '../../db/database';
import { decodeCursor, toPage, type Page } from '../../lib/pagination';
import { requestContext } from '../../telemetry/context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  /** Overrides the actor from the request context (e.g. failed login for a known user). */
  actorId?: string | null;
  actorRole?: string | null;
}

export interface AuditRecord {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  signatureValid: boolean;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  signature: string;
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

/**
 * Compliance audit trail. Each row carries an HMAC over its canonical content, so any
 * out-of-band tampering (even by someone with DB write access) is detectable. The table
 * itself rejects UPDATE/DELETE via trigger.
 *
 * Pass the transaction executor so the audit row commits atomically with the change it
 * describes.
 */
export class AuditService {
  private readonly db: Database;
  private readonly key: string;

  constructor({ db, config }: { db: Database; config: AppConfig }) {
    this.db = db;
    this.key = config.crypto.auditHmacKey;
  }

  private sign(fields: Record<string, unknown>): string {
    return createHmac('sha256', this.key).update(canonicalJson(fields)).digest('base64url');
  }

  async record(entry: AuditEntry, executor: Queryable = this.db): Promise<void> {
    const ctx = requestContext.get();
    const occurredAt = new Date();
    const row = {
      occurredAt: occurredAt.toISOString(),
      actorId: entry.actorId !== undefined ? entry.actorId : (ctx?.actorId ?? null),
      actorRole: entry.actorRole !== undefined ? entry.actorRole : (ctx?.actorRole ?? null),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      requestId: ctx?.requestId ?? null,
      metadata: entry.metadata ?? {},
    };
    await executor.query(
      `INSERT INTO audit_logs
         (occurred_at, actor_id, actor_role, action, entity_type, entity_id, request_id, ip, user_agent, metadata, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        occurredAt,
        row.actorId,
        row.actorRole,
        row.action,
        row.entityType,
        row.entityId,
        row.requestId,
        ctx?.ip ?? null,
        ctx?.userAgent?.slice(0, 512) ?? null,
        row.metadata,
        this.sign(row),
      ],
    );
  }

  async query(q: AuditQuery): Promise<Page<AuditRecord>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.entityType) add('entity_type = ?', q.entityType);
    if (q.entityId) add('entity_id = ?', q.entityId);
    if (q.actorId) add('actor_id = ?', q.actorId);
    if (q.action) add('action = ?', q.action);
    if (q.from) add('occurred_at >= ?', q.from);
    if (q.to) add('occurred_at < ?', q.to);
    const cursor = decodeCursor(q.cursor, 2);
    if (cursor) {
      params.push(cursor[0], cursor[1]);
      where.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await this.db.read.query<AuditRow>(
      `SELECT id, occurred_at, actor_id, actor_role, action, entity_type, entity_id, request_id,
              host(ip) AS ip, metadata, signature
         FROM audit_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    const records = rows.map((r) => this.toRecord(r));
    return toPage(records, q.limit, (r) => [r.occurredAt, r.id]);
  }

  private toRecord(r: AuditRow): AuditRecord {
    const expected = this.sign({
      occurredAt: r.occurred_at.toISOString(),
      actorId: r.actor_id,
      actorRole: r.actor_role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      requestId: r.request_id,
      metadata: r.metadata,
    });
    const a = Buffer.from(expected);
    const b = Buffer.from(r.signature);
    return {
      id: r.id,
      occurredAt: r.occurred_at.toISOString(),
      actorId: r.actor_id,
      actorRole: r.actor_role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      requestId: r.request_id,
      ip: r.ip,
      metadata: r.metadata,
      signatureValid: a.length === b.length && timingSafeEqual(a, b),
    };
  }
}

/** Deterministic JSON (sorted keys) so the signature does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}
