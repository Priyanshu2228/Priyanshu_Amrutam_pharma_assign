import type { Database, Queryable } from '../../db/database';
import { decodeCursor, toPage, type Page } from '../../lib/pagination';
import type { ConsultationStatus } from './consultation-state';

export interface ConsultationRecord {
  id: string;
  patientId: string;
  doctorId: string;
  slotId: string;
  status: ConsultationStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  holdExpiresAt: Date | null;
  feePaise: number;
  reasonEnc: string | null;
  doctorNotesEnc: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

interface Row {
  id: string;
  patient_id: string;
  doctor_id: string;
  slot_id: string;
  status: ConsultationStatus;
  scheduled_start: Date;
  scheduled_end: Date;
  hold_expires_at: Date | null;
  fee_paise: number;
  reason_enc: string | null;
  doctor_notes_enc: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  cancelled_at: Date | null;
  created_at: Date;
}

const toRecord = (r: Row): ConsultationRecord => ({
  id: r.id,
  patientId: r.patient_id,
  doctorId: r.doctor_id,
  slotId: r.slot_id,
  status: r.status,
  scheduledStart: r.scheduled_start,
  scheduledEnd: r.scheduled_end,
  holdExpiresAt: r.hold_expires_at,
  feePaise: r.fee_paise,
  reasonEnc: r.reason_enc,
  doctorNotesEnc: r.doctor_notes_enc,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  cancelledBy: r.cancelled_by,
  cancellationReason: r.cancellation_reason,
  cancelledAt: r.cancelled_at,
  createdAt: r.created_at,
});

export interface ConsultationFilter {
  patientId?: string;
  doctorId?: string;
  status?: ConsultationStatus;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

/** Columns a transition may set alongside the status. */
export interface TransitionFields {
  holdExpiresAt?: Date | null;
  startedAt?: Date;
  endedAt?: Date;
  doctorNotesEnc?: string | null;
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  cancelledAt?: Date;
}

const FIELD_COLUMNS: Record<keyof TransitionFields, string> = {
  holdExpiresAt: 'hold_expires_at',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  doctorNotesEnc: 'doctor_notes_enc',
  cancelledBy: 'cancelled_by',
  cancellationReason: 'cancellation_reason',
  cancelledAt: 'cancelled_at',
};

export class ConsultationsRepository {
  private readonly db: Database;

  constructor({ db }: { db: Database }) {
    this.db = db;
  }

  async insert(
    q: Queryable,
    c: {
      patientId: string;
      doctorId: string;
      slotId: string;
      scheduledStart: string;
      scheduledEnd: string;
      holdExpiresAt: Date;
      feePaise: number;
      reasonEnc: string | null;
    },
  ): Promise<ConsultationRecord> {
    const { rows } = await q.query<Row>(
      `INSERT INTO consultations
         (patient_id, doctor_id, slot_id, status, scheduled_start, scheduled_end, hold_expires_at, fee_paise, reason_enc)
       VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        c.patientId,
        c.doctorId,
        c.slotId,
        c.scheduledStart,
        c.scheduledEnd,
        c.holdExpiresAt,
        c.feePaise,
        c.reasonEnc,
      ],
    );
    return toRecord(rows[0]!);
  }

  async findById(
    id: string,
    q: Queryable = this.db,
    opts: { forUpdate?: boolean } = {},
  ): Promise<ConsultationRecord | null> {
    const { rows } = await q.query<Row>(
      `SELECT * FROM consultations WHERE id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Conditional state change: only applies if the row is still in one of `from`.
   * Returns null when a concurrent request already moved it.
   */
  async transition(
    q: Queryable,
    id: string,
    from: ConsultationStatus[],
    to: ConsultationStatus,
    fields: TransitionFields = {},
  ): Promise<ConsultationRecord | null> {
    const values: unknown[] = [id, from, to];
    const sets = ['status = $3', 'version = version + 1'];
    for (const [key, value] of Object.entries(fields) as [keyof TransitionFields, unknown][]) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${FIELD_COLUMNS[key]} = $${values.length}`);
    }
    const { rows } = await q.query<Row>(
      `UPDATE consultations SET ${sets.join(', ')}
        WHERE id = $1 AND status = ANY($2::consultation_status[])
        RETURNING *`,
      values,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(f: ConsultationFilter): Promise<Page<ConsultationRecord>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (f.patientId) where.push(`patient_id = ${p(f.patientId)}`);
    if (f.doctorId) where.push(`doctor_id = ${p(f.doctorId)}`);
    if (f.status) where.push(`status = ${p(f.status)}`);
    if (f.from) where.push(`scheduled_start >= ${p(f.from)}`);
    if (f.to) where.push(`scheduled_start < ${p(f.to)}`);
    const cursor = decodeCursor(f.cursor, 2);
    if (cursor) where.push(`(scheduled_start, id) < (${p(cursor[0])}::timestamptz, ${p(cursor[1])}::uuid)`);
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM consultations
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY scheduled_start DESC, id DESC
        LIMIT ${p(f.limit + 1)}`,
      params,
    );
    return toPage(rows.map(toRecord), f.limit, (c) => [c.scheduledStart.toISOString(), c.id]);
  }

  /**
   * Cancels pending consultations whose payment hold has lapsed. SKIP LOCKED lets several
   * workers run this concurrently without blocking each other or a payment in flight.
   */
  async expireHolds(
    q: Queryable,
    batchSize: number,
  ): Promise<{ id: string; slotId: string; doctorId: string; patientId: string }[]> {
    const { rows } = await q.query<{ id: string; slot_id: string; doctor_id: string; patient_id: string }>(
      `WITH expired AS (
         SELECT id FROM consultations
          WHERE status = 'pending_payment' AND hold_expires_at < now()
          ORDER BY hold_expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE consultations c
          SET status = 'cancelled', cancellation_reason = 'payment_timeout', cancelled_at = now(),
              hold_expires_at = NULL, version = version + 1
         FROM expired
        WHERE c.id = expired.id
       RETURNING c.id, c.slot_id, c.doctor_id, c.patient_id`,
      [batchSize],
    );
    return rows.map((r) => ({ id: r.id, slotId: r.slot_id, doctorId: r.doctor_id, patientId: r.patient_id }));
  }
}
