-- Core schema for the Amrutam telemedicine backend.
-- Conventions: UUID primary keys, timestamptz (UTC) everywhere, money as integer paise,
-- PHI columns suffixed _enc hold application-level AES-256-GCM ciphertext.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended');
CREATE TYPE slot_status AS ENUM ('open', 'held', 'booked', 'blocked');
CREATE TYPE consultation_status AS ENUM (
  'pending_payment', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'
);
CREATE TYPE payment_status AS ENUM ('initiated', 'captured', 'failed', 'refund_pending', 'refunded');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 citext NOT NULL UNIQUE,
  password_hash         text NOT NULL,
  role                  user_role NOT NULL,
  status                user_status NOT NULL DEFAULT 'active',
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens are stored hashed and rotated on every use. A token family groups one
-- login's chain; presenting a revoked token revokes the whole family (theft detection).
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE profiles (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  phone_enc     text,
  date_of_birth date,
  gender        text CHECK (gender IN ('female', 'male', 'other', 'undisclosed')),
  city          citext,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- doctors
CREATE TABLE doctors (
  user_id                uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  display_name           text NOT NULL,
  registration_number    text NOT NULL UNIQUE,
  specializations        text[] NOT NULL CHECK (cardinality(specializations) > 0),
  languages              text[] NOT NULL DEFAULT '{}',
  years_experience       int NOT NULL CHECK (years_experience BETWEEN 0 AND 80),
  consultation_fee_paise int NOT NULL CHECK (consultation_fee_paise > 0),
  bio                    text,
  city                   citext,
  rating                 numeric(2, 1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  rating_count           int NOT NULL DEFAULT 0,
  is_verified            boolean NOT NULL DEFAULT false,
  verified_at            timestamptz,
  verified_by            uuid REFERENCES users (id),
  search_vector          tsvector,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER doctors_updated_at BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- array_to_string is not IMMUTABLE so a generated column is not allowed; maintain via trigger.
CREATE OR REPLACE FUNCTION doctors_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(NEW.specializations, ' ')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.city::text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.bio, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER doctors_search_vector_trg BEFORE INSERT OR UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_search_vector();

-- Search only ever targets verified doctors, so partial indexes stay small.
CREATE INDEX doctors_search_idx ON doctors USING gin (search_vector) WHERE is_verified;
CREATE INDEX doctors_specializations_idx ON doctors USING gin (specializations) WHERE is_verified;
CREATE INDEX doctors_languages_idx ON doctors USING gin (languages) WHERE is_verified;
CREATE INDEX doctors_city_idx ON doctors (city) WHERE is_verified;
CREATE INDEX doctors_rating_idx ON doctors (rating DESC, user_id DESC) WHERE is_verified;
CREATE INDEX doctors_fee_idx ON doctors (consultation_fee_paise, user_id) WHERE is_verified;

-- ---------------------------------------------------------------- availability
CREATE TABLE availability_slots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  uuid NOT NULL REFERENCES doctors (user_id) ON DELETE CASCADE,
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  status     slot_status NOT NULL DEFAULT 'open',
  held_until timestamptz,
  version    int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_time_order CHECK (end_at > start_at),
  -- A doctor can never have two overlapping slots, enforced by the database itself.
  CONSTRAINT slot_no_overlap EXCLUDE USING gist (doctor_id WITH =, tstzrange(start_at, end_at) WITH &&)
);
CREATE TRIGGER slots_updated_at BEFORE UPDATE ON availability_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX slots_doctor_start_idx ON availability_slots (doctor_id, start_at);
CREATE INDEX slots_open_start_idx ON availability_slots (start_at, doctor_id) WHERE status = 'open';

-- ---------------------------------------------------------------- consultations
CREATE TABLE consultations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid NOT NULL REFERENCES users (id),
  doctor_id           uuid NOT NULL REFERENCES doctors (user_id),
  slot_id             uuid NOT NULL REFERENCES availability_slots (id),
  status              consultation_status NOT NULL,
  scheduled_start     timestamptz NOT NULL,
  scheduled_end       timestamptz NOT NULL,
  hold_expires_at     timestamptz,
  fee_paise           int NOT NULL CHECK (fee_paise > 0),
  reason_enc          text,
  doctor_notes_enc    text,
  started_at          timestamptz,
  ended_at            timestamptz,
  cancelled_by        uuid REFERENCES users (id),
  cancellation_reason text,
  cancelled_at        timestamptz,
  version             int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER consultations_updated_at BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Second line of defence against double booking: at most one live consultation per slot.
CREATE UNIQUE INDEX consultations_active_slot_uq ON consultations (slot_id)
  WHERE status IN ('pending_payment', 'confirmed', 'in_progress', 'completed');
CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_start DESC, id DESC);
CREATE INDEX consultations_doctor_idx ON consultations (doctor_id, scheduled_start DESC, id DESC);
CREATE INDEX consultations_hold_expiry_idx ON consultations (hold_expires_at) WHERE status = 'pending_payment';
CREATE INDEX consultations_scheduled_idx ON consultations (scheduled_start);

-- ---------------------------------------------------------------- prescriptions
CREATE TABLE prescriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL UNIQUE REFERENCES consultations (id),
  doctor_id        uuid NOT NULL REFERENCES doctors (user_id),
  patient_id       uuid NOT NULL REFERENCES users (id),
  diagnosis_enc    text NOT NULL,
  medications_enc  text NOT NULL,
  advice_enc       text,
  follow_up_date   date,
  document_status  text NOT NULL DEFAULT 'pending' CHECK (document_status IN ('pending', 'ready', 'failed')),
  document_key     text,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER prescriptions_updated_at BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, issued_at DESC);

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id     uuid NOT NULL REFERENCES consultations (id),
  amount_paise        int NOT NULL CHECK (amount_paise > 0),
  currency            char(3) NOT NULL DEFAULT 'INR',
  status              payment_status NOT NULL DEFAULT 'initiated',
  provider            text NOT NULL,
  provider_payment_id text UNIQUE,
  provider_refund_id  text,
  failure_reason      text,
  captured_at         timestamptz,
  refunded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX payments_consultation_idx ON payments (consultation_id);
CREATE INDEX payments_captured_idx ON payments (captured_at) WHERE status = 'captured';

-- Provider webhooks are delivered at-least-once; this table makes processing exactly-once.
CREATE TABLE processed_webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------- reliability plumbing
-- Idempotency-Key store for client-retried writes (scoped per user).
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL,
  idem_key        text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status int,
  response_body   jsonb,
  locked_until    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Transactional outbox: domain events are written in the same transaction as the state
-- change and relayed to the job queue afterwards, so no event is lost or invented.
CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;
