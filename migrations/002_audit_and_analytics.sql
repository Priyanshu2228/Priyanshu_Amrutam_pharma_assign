-- Audit trail: append-only, HMAC-signed rows, range-partitioned by month so that
-- retention is a cheap DROP of an old partition instead of a massive DELETE.

CREATE TABLE audit_logs (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  request_id  text,
  ip          inet,
  user_agent  text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  signature   text NOT NULL,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at DESC, id DESC);

-- Creates the partition for the month containing `month_start` if missing.
CREATE OR REPLACE FUNCTION ensure_audit_partition(month_start date) RETURNS text AS $$
DECLARE
  start_d date := date_trunc('month', month_start)::date;
  end_d   date := (date_trunc('month', month_start) + interval '1 month')::date;
  part    text := format('audit_logs_%s', to_char(start_d, 'YYYY_MM'));
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)', part, start_d, end_d);
  END IF;
  RETURN part;
END;
$$ LANGUAGE plpgsql;

-- Current month plus two ahead; the maintenance job keeps rolling this window forward.
SELECT ensure_audit_partition((date_trunc('month', now()) + make_interval(months => m))::date)
FROM generate_series(0, 2) AS m;
-- Safety net so an insert never fails if the maintenance job falls behind.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

-- Application roles may insert and read but never rewrite history.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ---------------------------------------------------------------- analytics
-- Pre-aggregated daily stats; refreshed CONCURRENTLY by a background job so admin
-- dashboards never scan the consultations table on the request path.
CREATE MATERIALIZED VIEW consultation_daily_stats AS
SELECT
  (scheduled_start AT TIME ZONE 'UTC')::date AS day,
  status,
  count(*)::int AS consultations,
  coalesce(sum(fee_paise), 0)::bigint AS gross_fee_paise
FROM consultations
GROUP BY 1, 2;
CREATE UNIQUE INDEX consultation_daily_stats_uq ON consultation_daily_stats (day, status);
