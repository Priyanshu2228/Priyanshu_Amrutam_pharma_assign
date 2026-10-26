# 5-minute demo script

Setup (before recording):

```bash
docker compose up -d --build
curl -s localhost:3000/readyz   # expect {"status":"ok",...}
npm run seed   # with DATABASE_URL pointing at localhost:5432
```

Open Swagger at http://localhost:3000/docs, Grafana at http://localhost:3001 and Jaeger at http://localhost:16686.

| Time      | Show                                                                                                                                                                                                    | Say                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:40 | `docs/architecture.md` diagram                                                                                                                                                                          | Modular monolith, API and worker split, read replica, Redis, outbox, 3-AZ deployment                                    |
| 0:40–1:30 | Patient: `POST /v1/auth/login`, `GET /v1/doctors?specialization=ayurveda&sort=rating`, then `GET /v1/doctors/{id}/slots`                                                                                | Faceted search on the replica, cached; cursor pagination                                                                |
| 1:30–2:30 | `POST /v1/consultations` with an `Idempotency-Key`; send the **same request again** and point at the `Idempotent-Replayed: true` header and the identical body; change the body with the same key → 422 | Exactly-once booking; then run `npx vitest run -t "exactly one"` to show 10 concurrent bookings → one 201 and nine 409s |
| 2:30–3:15 | `POST /v1/payments/{id}/mock-confirm` → confirmed; doctor logs in (MFA challenge → TOTP), starts the consultation, issues a prescription; the worker renders the PDF; patient downloads it              | Saga, outbox, async job, MFA for doctors                                                                                |
| 3:15–4:00 | Admin: `GET /v1/admin/audit-logs?entityType=prescription` (`signatureValid: true`), then `GET /v1/admin/analytics/summary`                                                                              | PHI access audit, tamper evidence, materialized-view analytics                                                          |
| 4:00–4:40 | Grafana dashboard (latency vs SLO, booking outcomes), a Jaeger trace of the booking (http → pg → redis), and a log line carrying the same `traceId`                                                     | Metrics, logs and traces correlated                                                                                     |
| 4:40–5:00 | GitHub Actions run (lint, types, tests, audit, CodeQL, Trivy) and `infra/terraform`                                                                                                                     | CI/CD and IaC; next steps                                                                                               |
