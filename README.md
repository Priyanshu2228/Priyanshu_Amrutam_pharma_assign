# Amrutam Telemedicine Backend

Production-grade backend for Amrutam's telemedicine platform. It is built with Node.js 22 LTS, TypeScript, Express 5, PostgreSQL 16, Redis 7 and BullMQ.

It covers:

- the user lifecycle, with TOTP MFA and role-based access control (RBAC);
- doctor discovery and availability;
- slot booking as a payment saga;
- the consultation lifecycle and prescriptions (asynchronous PDF);
- payments, with webhooks and refunds;
- a tamper-evident audit trail;
- admin analytics.

## Deliverables

| Deliverable                         | Where                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code and infrastructure as code     | [src/](src), [migrations/](migrations), [infra/terraform/](infra/terraform), [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml)                                                                                            |
| README with setup                   | This file                                                                                                                                                                                                                                  |
| API schema                          | [openapi/openapi.yaml](openapi/openapi.yaml) (OpenAPI 3.1; Swagger UI at `/docs` outside production)                                                                                                                                       |
| Architecture doc                    | [docs/architecture.md](docs/architecture.md): architecture and data flow, booking sequence diagram, ER diagram, API schema, retry and backoff, data partitioning, caching and concurrency, transactions and sagas, backup and DR, capacity |
| Tests and CI pipeline               | [tests/](tests) (unit + integration), [.github/workflows/ci.yml](.github/workflows/ci.yml), [.github/workflows/deploy.yml](.github/workflows/deploy.yml)                                                                                   |
| Observability setup                 | [src/telemetry/](src/telemetry), [infra/observability/](infra/observability) (Prometheus alert rules, Grafana dashboard, OpenTelemetry Collector)                                                                                          |
| Security checklist and threat model | [docs/security.md](docs/security.md): data classification, attack surface, STRIDE threat model, OWASP mapping, encryption and key rotation, audit logging, dependency scanning                                                             |

## Quick start

Prerequisites: Node 22 LTS (20.11+ also works), and Docker (for PostgreSQL and Redis).

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local config:

   ```bash
   cp .env.example .env
   ```

3. Start the data stores. This also creates the `amrutam_test` database for the integration tests.

   ```bash
   docker compose up -d postgres redis
   ```

   If a local PostgreSQL already uses port 5432, publish the container on another port with `POSTGRES_PORT=5433 docker compose up -d postgres redis`. Then point `DATABASE_URL` (in `.env`) and `TEST_DATABASE_URL` at `127.0.0.1:5433`.

4. Create the schema:

   ```bash
   npm run migrate:dev
   ```

5. Optionally load demo data (an admin, a patient and 3 verified doctors with slots):

   ```bash
   npm run seed
   ```

6. Start the API on http://localhost:3000:

   ```bash
   npm run dev
   ```

7. In a second terminal, start the worker (outbox relay, refunds, PDFs, hold expiry):

   ```bash
   npm run dev:worker
   ```

The seeded accounts are `admin@amrutam.local`, `patient@amrutam.local` and `dr.sharma@amrutam.local` (plus two more doctors). They all use the password `Amrutam@12345`, which you can override with `SEED_PASSWORD`. The admin and doctor accounts must enrol MFA on first login (`POST /v1/auth/mfa/setup`, then `/v1/auth/mfa/enable`).

### Full stack in containers

This runs the API, the worker, migrations, PostgreSQL, Redis, Prometheus, Grafana, the OpenTelemetry Collector and Jaeger:

```bash
docker compose up -d --build
```

| URL                        | What                                            |
| -------------------------- | ----------------------------------------------- |
| http://localhost:3000/docs | Swagger UI                                      |
| http://localhost:9090      | Prometheus (alert rules loaded)                 |
| http://localhost:3001      | Grafana, dashboard "Amrutam API — SLO overview" |
| http://localhost:16686     | Jaeger traces                                   |

## Tests

Unit tests need no infrastructure:

```bash
npm run test:unit
```

Integration tests need PostgreSQL and Redis running (from `docker compose up -d postgres redis`):

```bash
npm run test:integration
```

Coverage report:

```bash
npm run test:coverage
```

The integration tests run against a real PostgreSQL and Redis. They always target `*_test` databases (`TEST_DATABASE_URL` and `TEST_REDIS_URL` override the defaults) and refuse to touch anything else. They cover:

- **Auth:** lockout, refresh-token rotation and reuse detection, instant logout and suspension, the MFA flow and TOTP replay.
- **Booking:** 10 concurrent bookings of one slot (exactly one wins), idempotent replay and key-reuse rejection, the full lifecycle, IDOR protection, the admin minimum-necessary view, and encryption at rest.
- **Sagas:** cancellation and refund via the outbox and worker, refund-window policy, hold expiry, late-capture compensation, a provider outage handled with retry and compensation, and webhook signature and dedupe.
- **Admin and operations:** async PDF rendering and download, analytics, audit tamper detection and append-only enforcement, metrics and readiness.

## Project layout

```
src/
  app.ts                 Express app: middleware pipeline, routers, health/metrics/docs
  server.ts / worker.ts  Process entrypoints (graceful shutdown, OTel first)
  container.ts           Composition root (awilix constructor DI)
  config/env.ts          Validated configuration (fails fast on weak secrets)
  db/                    Pool + transaction helper, migration runner, seed
  lib/                   Errors, retry/backoff, circuit breaker, field crypto, cache, pagination
  middleware/            Auth/RBAC/MFA, idempotency, rate limiting, error envelope
  modules/<domain>/      repository → service → routes per business area
  jobs/                  Transactional outbox, relay, queue definitions
  telemetry/             Logger (redaction, trace correlation), metrics, tracing, request context
migrations/              Forward-only SQL migrations
openapi/                 API contract
infra/terraform/         AWS: VPC (3 AZ), RDS Multi-AZ + replica, ElastiCache, ECS Fargate, ALB+WAF, KMS, Backup/DR
infra/observability/     Prometheus rules, Grafana dashboard, OTel collector
.github/workflows/       CI (lint, types, tests, audit, CodeQL, gitleaks, Trivy) and CD (OIDC, migrate, roll)
```

## Configuration

All configuration comes from environment variables; see [.env.example](.env.example). The process refuses to start if a required secret is missing or too short. In AWS, secrets are injected from Secrets Manager into the task definition, so none are baked into the image or stored in Terraform state.

## API at a glance

| Area          | Endpoints                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth          | `POST /v1/auth/register` `login` `mfa/verify` `mfa/setup` `mfa/enable` `refresh` `logout`                                                                                |
| Users         | `GET/PATCH /v1/users/me`                                                                                                                                                 |
| Doctors       | `GET /v1/doctors` (search: q, specialization, city, language, fee range, rating, experience, availableOn, sort, cursor) · `GET /v1/doctors/:id` · `PATCH /v1/doctors/me` |
| Availability  | `GET /v1/doctors/:id/slots` · `GET/POST /v1/doctors/me/slots` · `DELETE /v1/doctors/me/slots/:id`                                                                        |
| Consultations | `POST /v1/consultations` (idempotent) · `GET /v1/consultations[/:id]` · `POST /:id/cancel` `start` `complete` `no-show`                                                  |
| Prescriptions | `POST/GET /v1/consultations/:id/prescription` · `GET /v1/prescriptions/:id/document`                                                                                     |
| Payments      | `POST /v1/payments/webhook` (HMAC) · `POST /v1/payments/:id/mock-confirm` (mock provider)                                                                                |
| Admin         | `GET /v1/admin/analytics/summary` · `POST /v1/admin/doctors/:id/verify` · `POST /v1/admin/users/:id/suspend` and `reactivate` · `GET /v1/admin/audit-logs`               |
| Ops           | `GET /healthz` `readyz` `metrics` `openapi.json`                                                                                                                         |

## Known gaps / next steps

- **Payments:** the payment provider is a deterministic mock adapter behind the `PaymentGateway` port. A Razorpay or Stripe adapter is the production step.
- **Document storage:** documents are stored on local disk (`LocalDocumentStorage`). Production needs the S3 adapter with pre-signed URLs, because the API and worker run as separate tasks.
- **Data-subject requests:** DPDP export and erasure workflows are designed in [docs/security.md](docs/security.md) but not implemented.
