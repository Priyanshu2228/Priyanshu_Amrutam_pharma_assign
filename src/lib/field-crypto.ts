import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Application-level envelope for PHI columns (AES-256-GCM).
 *
 * Ciphertext format: `<kid>.<iv>.<tag>.<ciphertext>` (base64url parts). The key id makes
 * rotation possible without downtime: add a new key at the front of the keyring, deploy,
 * then run `npm run keys:reencrypt` to rewrite old rows; finally drop the old key.
 *
 * In production the keyring is sourced from a KMS-backed secret (see docs/security.md).
 */
export class FieldCrypto {
  private readonly keys = new Map<string, Buffer>();
  readonly activeKid: string;

  constructor(keyring: string) {
    const entries = keyring
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (entries.length === 0) throw new Error('FIELD_ENCRYPTION_KEYS is empty');
    for (const entry of entries) {
      const sep = entry.indexOf(':');
      if (sep <= 0) throw new Error('FIELD_ENCRYPTION_KEYS entries must be "<kid>:<base64key>"');
      const kid = entry.slice(0, sep);
      const key = Buffer.from(entry.slice(sep + 1), 'base64');
      if (key.length !== 32) throw new Error(`Encryption key "${kid}" must be 32 bytes`);
      if (!/^[a-zA-Z0-9_-]+$/.test(kid)) throw new Error(`Invalid key id "${kid}"`);
      this.keys.set(kid, key);
    }
    this.activeKid = entries[0]!.slice(0, entries[0]!.indexOf(':'));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keys.get(this.activeKid)!, iv);
    // Bind the key id as AAD so a ciphertext cannot be relabelled with another kid.
    cipher.setAAD(Buffer.from(this.activeKid));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      this.activeKid,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const [kid, iv, tag, ct] = payload.split('.');
    if (!kid || !iv || !tag || ct === undefined) throw new Error('Malformed ciphertext');
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Unknown encryption key id "${kid}"`);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(kid));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptNullable(value: string | null | undefined): string | null {
    return value == null ? null : this.encrypt(value);
  }

  decryptNullable(value: string | null | undefined): string | null {
    return value == null ? null : this.decrypt(value);
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(value: string): T {
    return JSON.parse(this.decrypt(value)) as T;
  }

  /** True when the value was encrypted with a key other than the active one. */
  needsRotation(payload: string): boolean {
    return !payload.startsWith(`${this.activeKid}.`);
  }
}
