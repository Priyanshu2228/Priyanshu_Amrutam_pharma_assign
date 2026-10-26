# Security checklist and threat model

## 1. Data classification

| Class                     | Examples                                                                | Storage controls                                                                                                               | Access                                                                                    |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **PHI (restricted)**      | Chief complaint, doctor notes, diagnosis, medications, advice           | AES-256-GCM per field (app keyring, key id in ciphertext) on top of KMS disk encryption; never logged (redacted at the logger) | Patient (own), assigned doctor; admins get metadata only; every non-owner read is audited |
| **PII (confidential)**    | Phone, DOB, name, email                                                 | Phone encrypted per field; others protected by KMS at rest                                                                     | Owner, admins                                                                             |
| **Credentials / secrets** | Password hashes, TOTP secrets, refresh tokens, JWT/HMAC/encryption keys | scrypt (N=2^15, r=8, p=3); TOTP secret field-encrypted; refresh tokens stored as SHA-256; keys in Secrets Manager (KMS)        | Service only                                                                              |
| **Financial**             | Payment amounts, provider ids                                           | KMS at rest; no card data ever touches us (provider-hosted checkout), keeping PCI scope at SAQ-A                               | Owner, admins                                                                             |
| **Operational**           | Audit logs, metrics, traces                                             | Append-only and HMAC-signed (audit); traces scrubbed                                                                           | Admins, SRE                                                                               |

## 2. Attack surface

| Entry point               | Exposure                            | Controls                                                                                                                    |
| ------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Public REST API (`/v1/*`) | Internet via WAF + ALB              | TLS 1.2+/1.3 only; WAF managed rules + per-IP rate rule; app rate limits; JWT auth; RBAC; zod validation; 100 kB body limit |
| Auth endpoints            | Internet, unauthenticated           | Strict per-IP limiter; generic errors; constant-time path for unknown users; account lockout; MFA                           |
| Payment webhook           | Internet, unauthenticated           | HMAC-SHA256 over raw body with constant-time compare; event-id dedupe; schema validation                                    |
| `/metrics`, `/readyz`     | Internal                            | Bearer token on `/metrics` (`METRICS_TOKEN`); should be reachable only from the VPC (ALB rule or separate port)             |
| `/docs` (Swagger)         | Disabled in production              | —                                                                                                                           |
| Database / Redis          | Isolated subnets, no internet route | Security groups allow only app tasks; TLS enforced (`rds.force_ssl`, Redis in-transit encryption + AUTH)                    |
| CI/CD                     | GitHub                              | OIDC to AWS (no static keys), protected production environment with approval, signed image digests                          |
| Dependencies              | npm supply chain                    | Lockfile + `npm ci`, `npm audit` gate, Dependabot, CodeQL, Trivy image + IaC scans, gitleaks                                |

## 3. Threat model (STRIDE)

| Threat                     | Scenario                                       | Mitigation                                                                                                                             | Where                                    |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **S**poofing               | Credential stuffing or brute force             | Rate limit (20 per 15 min per IP), lockout after 5 failures, generic errors, scrypt cost                                               | `auth.service.ts`, `rate-limit.ts`       |
| Spoofing                   | Stolen password used against a doctor or admin | Mandatory TOTP for doctor/admin; codes single-use (replay cache); `MFA_REQUIRED` gate on privileged routes                             | `middleware/auth.ts`, `session-guard.ts` |
| Spoofing                   | Stolen refresh token                           | Rotation on every use; reuse revokes the whole family and is audited                                                                   | `token.service.ts`                       |
| Spoofing                   | Forged payment webhook                         | HMAC signature on raw body, timing-safe compare                                                                                        | `payment-gateway.ts`                     |
| **T**ampering              | Altering audit history                         | `UPDATE`/`DELETE` blocked by trigger; per-row HMAC re-verified on read (`signatureValid`)                                              | migration 002, `audit.service.ts`        |
| Tampering                  | Swapping ciphertext between key ids            | Key id bound as GCM AAD                                                                                                                | `field-crypto.ts`                        |
| Tampering                  | Mass assignment / unexpected fields            | `.strict()` zod schemas, explicit column maps in repositories                                                                          | routes, repositories                     |
| Tampering                  | SQL injection                                  | Parameterized queries only; dynamic SQL built from whitelisted column maps                                                             | repositories                             |
| **R**epudiation            | "I never viewed that record"                   | Audit row for every PHI read by non-owners, auth events, admin actions, and audit queries themselves, with request id, IP and UA       | `audit.service.ts`                       |
| **I**nformation disclosure | IDOR on consultations or prescriptions         | Ownership checks in services; `404` (not `403`) hides existence                                                                        | services                                 |
| Information disclosure     | PHI in logs or traces                          | Logger redaction paths; IDs-only notifications; OTel collector strips auth headers and hashes SQL                                      | `logger.ts`, `otel-collector.yaml`       |
| Information disclosure     | DB snapshot leak                               | KMS at rest plus field-level encryption for PHI                                                                                        | `data.tf`, `field-crypto.ts`             |
| Information disclosure     | Admin overreach                                | Admins have no `prescription:read` and see consultation metadata without clinical text                                                 | `rbac.ts`, `consultations.service.ts`    |
| **D**enial of service      | Request floods                                 | WAF rate rule, Redis-backed limiters with in-memory fallback, body size limit, statement timeouts, connection pool limits, autoscaling | `app.ts`, `rate-limit.ts`, `database.ts` |
| Denial of service          | Slot hoarding bots                             | 10-minute payment hold auto-expires; per-user booking limit; conflict-spike alert                                                      | `booking.service.ts`, alerts             |
| **E**levation of privilege | Self-registering as admin                      | Registration schema accepts only patient/doctor                                                                                        | `auth.schemas.ts`                        |
| Elevation of privilege     | Unverified doctor taking bookings              | `DOCTOR_NOT_VERIFIED` on slot publishing; search filters `is_verified`                                                                 | `availability.service.ts`                |
| Elevation of privilege     | JWT algorithm confusion                        | Algorithm pinned to HS256, issuer/audience/`typ` enforced; MFA challenge tokens cannot act as access tokens                            | `token.service.ts`                       |

## 4. OWASP Top 10 (2021) mapping

| #   | Risk                                       | Mitigation                                                                                                                             |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Broken access control                      | Route RBAC + service ownership checks + MFA gate; tests for cross-user access                                                          |
| A02 | Cryptographic failures                     | TLS 1.3 at ALB, KMS at rest, AES-256-GCM field encryption, scrypt, SHA-256 token hashing, HMAC audit                                   |
| A03 | Injection                                  | Parameterized SQL, zod validation, tsquery sanitisation for search                                                                     |
| A04 | Insecure design                            | State machine, sagas with compensation, idempotency keys, threat model (this doc)                                                      |
| A05 | Security misconfiguration                  | helmet headers, CORS allow-list, Swagger off in prod, env validated at boot (fails fast on weak secrets), non-root read-only container |
| A06 | Vulnerable components                      | `npm audit` gate, Dependabot, Trivy image scan, pinned base image                                                                      |
| A07 | Identification and authentication failures | MFA, lockout, rotation with reuse detection, short-lived access tokens (15 min), immediate revocation via denylist                     |
| A08 | Software and data integrity failures       | Lockfile `npm ci`, CI-built immutable images, signed webhooks, OIDC deploys                                                            |
| A09 | Security logging and monitoring failures   | Tamper-evident audit trail, structured logs with request/trace ids, alerting                                                           |
| A10 | SSRF                                       | No user-controlled outbound URLs; egress only to the payment provider and AWS APIs                                                     |

## 5. Encryption and key rotation

| Key                                     | Location                                | Rotation                                                                                                                                                                |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS CMK (RDS, Redis, S3, logs, secrets) | AWS KMS                                 | Automatic yearly (`enable_key_rotation`)                                                                                                                                |
| Field-encryption keyring                | Secrets Manager `FIELD_ENCRYPTION_KEYS` | Zero-downtime: prepend the new key, deploy, run `npm run keys:reencrypt` (batched, `SKIP LOCKED`), then remove the old key. Recommended every 12 months or on suspicion |
| JWT signing secret                      | Secrets Manager                         | Rotate with a dual-key verify window (old key verifies for one access-token TTL); production upgrade path is RS256/ES256 via KMS asymmetric keys                        |
| Audit HMAC key                          | Secrets Manager                         | Version the key (the `signature` can be prefixed with a key id); old keys are kept to verify historical rows                                                            |
| DB master password                      | RDS-managed secret                      | Automatic rotation by Secrets Manager                                                                                                                                   |
| Webhook secret                          | Provider dashboard + Secrets Manager    | Provider-supported rolling secrets                                                                                                                                      |

## 6. Audit logging

- **What is recorded:** authentication events (success, failure, lockout, MFA, refresh-token reuse, logout), registrations, profile changes (field names only), doctor verification, suspensions, slot publishing, the consultation lifecycle, every prescription issue/view/download, payment capture/fail/refund, and audit-log queries.
- **Row contents:** actor, role, action, entity, request id, IP, user agent, metadata (no PHI values), and an HMAC-SHA256 signature.
- **Integrity:** an append-only trigger blocks changes, and signatures are verified on read.
- **Retention:** monthly partitions are dropped after the retention period (archived first), which also supports the DPDP and medical-records retention policies.

## 7. Checklist

- [x] TLS everywhere (ALB TLS 1.3 policy, RDS `force_ssl`, Redis TLS)
- [x] Encryption at rest (KMS) and field-level PHI encryption
- [x] Password hashing with scrypt; password policy; generic auth errors
- [x] TOTP MFA, mandatory for doctors and admins; replay-safe
- [x] RBAC + ownership checks + minimum-necessary admin view
- [x] Short-lived JWT + rotating refresh tokens with reuse detection; instant revocation
- [x] Account lockout and rate limiting (app + WAF)
- [x] Input validation (zod), body size limits, strict schemas
- [x] Idempotency for all unsafe client writes; webhook dedupe
- [x] Tamper-evident, append-only audit trail incl. PHI access
- [x] Secrets only via env/Secrets Manager; config validated at startup
- [x] Security headers (helmet), CORS allow-list, `x-powered-by` off
- [x] Non-root, minimal container; read-only root FS in ECS
- [x] Dependency, SAST, secret, container and IaC scanning in CI
- [x] Data residency in India (ap-south-1 / ap-south-2)
- [ ] Penetration test before go-live (external)
- [ ] S3 `DocumentStorage` adapter with pre-signed URLs (port exists; local adapter in repo)
- [ ] Consent records and data-subject export/erasure workflow for DPDP (design: async export job; erasure = PII anonymisation with medical records retained per law)
