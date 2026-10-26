import type { Database, Queryable } from '../../db/database';

export type SlotStatus = 'open' | 'held' | 'booked' | 'blocked';

export interface SlotRecord {
  id: string;
  doctorId: string;
  startAt: string;
  endAt: string;
  status: SlotStatus;
}

interface SlotRow {
  id: string;
  doctor_id: string;
  start_at: Date;
  end_at: Date;
  status: SlotStatus;
}

const toSlot = (r: SlotRow): SlotRecord => ({
  id: r.id,
  doctorId: r.doctor_id,
  startAt: r.start_at.toISOString(),
  endAt: r.end_at.toISOString(),
  status: r.status,
});

const COLUMNS = 'id, doctor_id, start_at, end_at, status';

export class SlotsRepository {
  private readonly db: Database;

  constructor({ db }: { db: Database }) {
    this.db = db;
  }

  async findById(id: string, q: Queryable = this.db): Promise<SlotRecord | null> {
    const { rows } = await q.query<SlotRow>(`SELECT ${COLUMNS} FROM availability_slots WHERE id = $1`, [id]);
    return rows[0] ? toSlot(rows[0]) : null;
  }

  async list(doctorId: string, from: Date, to: Date, statuses: SlotStatus[]): Promise<SlotRecord[]> {
    const { rows } = await this.db.read.query<SlotRow>(
      `SELECT ${COLUMNS} FROM availability_slots
        WHERE doctor_id = $1 AND start_at >= $2 AND start_at < $3 AND status = ANY($4::slot_status[])
        ORDER BY start_at
        LIMIT 500`,
      [doctorId, from, to, statuses],
    );
    return rows.map(toSlot);
  }

  /** Bulk insert in one statement; the exclusion constraint rejects any overlap atomically. */
  async createMany(
    q: Queryable,
    doctorId: string,
    slots: { startAt: Date; endAt: Date }[],
  ): Promise<SlotRecord[]> {
    const { rows } = await q.query<SlotRow>(
      `INSERT INTO availability_slots (doctor_id, start_at, end_at)
       SELECT $1, s, e FROM unnest($2::timestamptz[], $3::timestamptz[]) AS t(s, e)
       RETURNING ${COLUMNS}`,
      [doctorId, slots.map((s) => s.startAt), slots.map((s) => s.endAt)],
    );
    return rows.map(toSlot).sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  /** Withdraws an open slot. Slots with booking history are blocked, never deleted. */
  async block(doctorId: string, slotId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE availability_slots SET status = 'blocked', version = version + 1
        WHERE id = $1 AND doctor_id = $2 AND status = 'open'`,
      [slotId, doctorId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Atomic compare-and-set from open -> held. Under READ COMMITTED a concurrent booker
   * blocks on the row lock, then re-evaluates the WHERE clause against the committed row
   * and matches nothing — so exactly one request can win a slot, with no explicit locking.
   */
  async hold(q: Queryable, slotId: string, holdUntil: Date): Promise<SlotRecord | null> {
    const { rows } = await q.query<SlotRow>(
      `UPDATE availability_slots
          SET status = 'held', held_until = $2, version = version + 1
        WHERE id = $1 AND status = 'open' AND start_at > now()
        RETURNING ${COLUMNS}`,
      [slotId, holdUntil],
    );
    return rows[0] ? toSlot(rows[0]) : null;
  }

  async markBooked(q: Queryable, slotId: string): Promise<void> {
    await q.query(
      `UPDATE availability_slots SET status = 'booked', held_until = NULL, version = version + 1
        WHERE id = $1 AND status IN ('held', 'booked')`,
      [slotId],
    );
  }

  /** Returns a slot to the pool if it is still in the future; past slots stay closed. */
  async release(q: Queryable, slotIds: string[]): Promise<void> {
    if (slotIds.length === 0) return;
    await q.query(
      `UPDATE availability_slots
          SET status = CASE WHEN start_at > now() THEN 'open'::slot_status ELSE 'blocked'::slot_status END,
              held_until = NULL, version = version + 1
        WHERE id = ANY($1::uuid[]) AND status IN ('held', 'booked')`,
      [slotIds],
    );
  }
}
