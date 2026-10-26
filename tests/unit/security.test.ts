import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCrypto } from '../../src/lib/field-crypto';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { canonicalJson } from '../../src/modules/audit/audit.service';
import { hasPermission, PERMISSIONS, ROLES } from '../../src/modules/auth/rbac';
import { MockPaymentGateway, signWebhook } from '../../src/modules/payments/payment-gateway';

const key = () => randomBytes(32).toString('base64');

describe('FieldCrypto', () => {
  it('round-trips and produces a fresh IV every time', () => {
    const c = new FieldCrypto(`k1:${key()}`);
    const a = c.encrypt('chronic migraine');
    const b = c.encrypt('chronic migraine');
    expect(a).not.toEqual(b);
    expect(c.decrypt(a)).toBe('chronic migraine');
    expect(a.startsWith('k1.')).toBe(true);
  });

  it('detects tampering (GCM auth tag)', () => {
    const c = new FieldCrypto(`k1:${key()}`);
    const parts = c.encrypt('secret').split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => c.decrypt(parts.join('.'))).toThrow();
  });

  it('rejects ciphertext relabelled with another key id', () => {
    const k = key();
    const c = new FieldCrypto(`k2:${k},k1:${k}`);
    const relabelled = c.encrypt('x').replace(/^k2\./, 'k1.');
    expect(() => c.decrypt(relabelled)).toThrow();
  });

  it('supports rotation: old ciphertext decrypts after a new key is prepended', () => {
    const k1 = key();
    const old = new FieldCrypto(`k1:${k1}`);
    const legacy = old.encrypt('phone');
    const rotated = new FieldCrypto(`k2:${key()},k1:${k1}`);
    expect(rotated.decrypt(legacy)).toBe('phone');
    expect(rotated.needsRotation(legacy)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('phone'))).toBe(false);
  });

  it('validates the keyring', () => {
    expect(() => new FieldCrypto('')).toThrow();
    expect(() => new FieldCrypto('k1:c2hvcnQ=')).toThrow(/32 bytes/);
    expect(() => new FieldCrypto(`bad kid:${key()}`)).toThrow();
  });

  it('round-trips JSON', () => {
    const c = new FieldCrypto(`k1:${key()}`);
    const meds = [{ name: 'Ashwagandha', dosage: '500mg' }];
    expect(c.decryptJson(c.encryptJson(meds))).toEqual(meds);
  });
});

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('Correct-Horse-9');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-9', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-9', hash)).toBe(false);
  });

  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
  });
});

describe('RBAC', () => {
  it('denies patients admin and clinical-write permissions', () => {
    expect(hasPermission('patient', 'admin:audit')).toBe(false);
    expect(hasPermission('patient', 'prescription:write')).toBe(false);
    expect(hasPermission('patient', 'consultation:book')).toBe(true);
  });

  it('keeps admins away from clinical content', () => {
    expect(hasPermission('admin', 'prescription:read')).toBe(false);
    expect(hasPermission('admin', 'prescription:write')).toBe(false);
  });

  it('only references known roles', () => {
    for (const roles of Object.values(PERMISSIONS)) {
      for (const role of roles) expect(ROLES).toContain(role);
    }
  });
});

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
  });

  it('omits undefined values', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('webhook signatures', () => {
  it('accepts only an exact HMAC over the raw body', () => {
    const gw = new MockPaymentGateway('whsec_test_123456');
    const body = Buffer.from('{"id":"evt_1"}');
    expect(gw.verifyWebhookSignature(body, signWebhook('whsec_test_123456', body))).toBe(true);
    expect(gw.verifyWebhookSignature(body, signWebhook('other-secret-000000', body))).toBe(false);
    expect(
      gw.verifyWebhookSignature(Buffer.from('{"id":"evt_2"}'), signWebhook('whsec_test_123456', body)),
    ).toBe(false);
    expect(gw.verifyWebhookSignature(body, undefined)).toBe(false);
  });

  it('honours provider idempotency keys', async () => {
    const gw = new MockPaymentGateway('whsec_test_123456');
    const a = await gw.createIntent({ paymentId: 'p1' }, 'intent-p1');
    const b = await gw.createIntent({ paymentId: 'p1' }, 'intent-p1');
    expect(a).toEqual(b);
  });
});
