import type { Database, Queryable } from '../../db/database';

export type PaymentStatus = 'initiated' | 'captured' | 'failed' | 'refund_pending' | 'refunded';

export interface PaymentRecord {
  id: string;
  consultationId: string;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  failureReason: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  consultation_id: string;
  amount_paise: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  provider_payment_id: string | null;
  provider_refund_id: string | null;
  failure_reason: string | null;
  created_at: Date;
}

const toRecord = (r: Row): PaymentRecord => ({
  id: r.id,
  consultationId: r.consultation_id,
  amountPaise: r.amount_paise,
  currency: r.currency,
  status: r.status,
  provider: r.provider,
  providerPaymentId: r.provider_payment_id,
  providerRefundId: r.provider_refund_id,
  failureReason: r.failure_reason,
  createdAt: r.created_at,
});

export class PaymentsRepository {
  private readonly db: Database;

  constructor({ db }: { db: Database }) {
    this.db = db;
  }

  async insert(
    q: Queryable,
    p: { consultationId: string; amountPaise: number; provider: string },
  ): Promise<PaymentRecord> {
    const { rows } = await q.query<Row>(
      'INSERT INTO payments (consultation_id, amount_paise, provider) VALUES ($1, $2, $3) RETURNING *',
      [p.consultationId, p.amountPaise, p.provider],
    );
    return toRecord(rows[0]!);
  }

  async findById(
    id: string,
    q: Queryable = this.db,
    opts: { forUpdate?: boolean } = {},
  ): Promise<PaymentRecord | null> {
    const { rows } = await q.query<Row>(
      `SELECT * FROM payments WHERE id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByProviderId(providerPaymentId: string, q: Queryable = this.db): Promise<PaymentRecord | null> {
    const { rows } = await q.query<Row>('SELECT * FROM payments WHERE provider_payment_id = $1', [
      providerPaymentId,
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Latest payment attempt for a consultation, locked for update. */
  async findLatestForConsultation(q: Queryable, consultationId: string): Promise<PaymentRecord | null> {
    const { rows } = await q.query<Row>(
      'SELECT * FROM payments WHERE consultation_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [consultationId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setProviderPaymentId(id: string, providerPaymentId: string): Promise<void> {
    await this.db.query(
      'UPDATE payments SET provider_payment_id = $2 WHERE id = $1 AND provider_payment_id IS NULL',
      [id, providerPaymentId],
    );
  }

  async setStatus(
    q: Queryable,
    id: string,
    from: PaymentStatus[],
    to: PaymentStatus,
    extra: { failureReason?: string; providerRefundId?: string } = {},
  ): Promise<boolean> {
    const res = await q.query(
      `UPDATE payments
          SET status = $3::payment_status,
              failure_reason = coalesce($4, failure_reason),
              provider_refund_id = coalesce($5, provider_refund_id),
              captured_at = CASE WHEN $3::payment_status IN ('captured', 'refund_pending') AND captured_at IS NULL THEN now() ELSE captured_at END,
              refunded_at = CASE WHEN $3::payment_status = 'refunded' THEN now() ELSE refunded_at END
        WHERE id = $1 AND status = ANY($2::payment_status[])`,
      [id, from, to, extra.failureReason ?? null, extra.providerRefundId ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async failInitiatedForConsultations(
    q: Queryable,
    consultationIds: string[],
    reason: string,
  ): Promise<void> {
    if (consultationIds.length === 0) return;
    await q.query(
      `UPDATE payments SET status = 'failed', failure_reason = $2
        WHERE consultation_id = ANY($1::uuid[]) AND status = 'initiated'`,
      [consultationIds, reason],
    );
  }

  /** Exactly-once guard for at-least-once webhook delivery. */
  async markEventProcessed(q: Queryable, provider: string, eventId: string): Promise<boolean> {
    const res = await q.query(
      'INSERT INTO processed_webhook_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [provider, eventId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
