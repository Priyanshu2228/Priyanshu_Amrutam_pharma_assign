import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { loadConfig } from '../../src/config/env';
import { decodeCursor, encodeCursor, toPage } from '../../src/lib/pagination';
import {
  assertTransition,
  canTransition,
  CONSULTATION_STATUSES,
  sourcesOf,
  TRANSITIONS,
} from '../../src/modules/consultations/consultation-state';
import { toPrefixTsQuery } from '../../src/modules/doctors/doctors.repository';

describe('consultation state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('pending_payment', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('forbids skipping payment or reviving terminal states', () => {
    expect(canTransition('pending_payment', 'in_progress')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
    expect(() => assertTransition('in_progress', 'cancelled')).toThrow(/Cannot move/);
  });

  it('has terminal states with no exits', () => {
    for (const s of ['completed', 'cancelled', 'no_show'] as const) expect(TRANSITIONS[s]).toHaveLength(0);
  });

  it('derives the source states of a transition', () => {
    expect(sourcesOf('cancelled').sort()).toEqual(['confirmed', 'pending_payment']);
    for (const to of CONSULTATION_STATUSES)
      for (const from of sourcesOf(to)) expect(canTransition(from, to)).toBe(true);
  });
});

describe('cursor pagination', () => {
  it('round-trips cursors', () => {
    const c = encodeCursor(['2026-01-01T00:00:00.000Z', 'abc']);
    expect(decodeCursor(c, 2)).toEqual(['2026-01-01T00:00:00.000Z', 'abc']);
  });

  it('rejects tampered cursors', () => {
    expect(() => decodeCursor('not-base64-json', 2)).toThrow(/Cursor/);
    expect(() => decodeCursor(encodeCursor(['a']), 2)).toThrow(/Cursor/);
  });

  it('emits nextCursor only when more rows exist', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(toPage(rows, 2, (r) => [r.id]).nextCursor).not.toBeNull();
    expect(toPage(rows, 3, (r) => [r.id]).nextCursor).toBeNull();
    expect(toPage(rows, 2, (r) => [r.id]).data).toHaveLength(2);
  });
});

describe('search query builder', () => {
  it('builds a prefix tsquery and strips operators', () => {
    expect(toPrefixTsQuery('Derma  ayur')).toBe('derma:* & ayur:*');
    expect(toPrefixTsQuery("a' | b & !c")).toBe('a:* & b:* & c:*');
    expect(toPrefixTsQuery('  !!  ')).toBeNull();
  });
});

describe('config', () => {
  it('rejects weak secrets', () => {
    expect(() => loadConfig({ ...process.env, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('parses list and boolean env vars', () => {
    const cfg = loadConfig({ ...process.env, MFA_REQUIRED_ROLES: 'doctor, admin', OTEL_ENABLED: 'true' });
    expect(cfg.auth.mfaRequiredRoles).toEqual(['doctor', 'admin']);
    expect(cfg.otel.enabled).toBe(true);
  });
});

describe('OpenAPI document', () => {
  const spec = YAML.parse(readFileSync(path.join(__dirname, '../../openapi/openapi.yaml'), 'utf8'));

  it('is OpenAPI 3.1 and documents every core workflow', () => {
    expect(spec.openapi).toBe('3.1.0');
    for (const p of [
      '/v1/auth/login',
      '/v1/auth/mfa/verify',
      '/v1/doctors',
      '/v1/doctors/{id}/slots',
      '/v1/consultations',
      '/v1/consultations/{id}/prescription',
      '/v1/payments/webhook',
      '/v1/admin/analytics/summary',
      '/v1/admin/audit-logs',
    ]) {
      expect(spec.paths[p], p).toBeDefined();
    }
  });

  it('marks every idempotent write with the Idempotency-Key parameter', () => {
    const booking = spec.paths['/v1/consultations'].post.parameters;
    expect(booking).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
  });

  it('resolves every $ref', () => {
    const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) ?? [];
    for (const ref of new Set(refs)) {
      const parts = ref.slice(3, -1).split('/');
      let node = spec;
      for (const part of parts) node = node?.[part];
      expect(node, ref).toBeDefined();
    }
  });
});
