import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

// OWASP Password Storage Cheat Sheet: N=2^15, r=8, p=3 is equivalent in cost to N=2^17,p=1 but
// needs 32 MiB per hash instead of 128 MiB, which matters under concurrent logins.
// Tests use a cheap profile; hashes embed their parameters so either verifies anywhere.
const PARAMS =
  process.env.NODE_ENV === 'test'
    ? { N: 2 ** 12, r: 8, p: 1, keylen: 64 }
    : { N: 2 ** 15, r: 8, p: 3, keylen: 64 };
const maxmem = 128 * 1024 * 1024;

/** Format: scrypt$N$r$p$salt$hash — parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used when the account does not exist so response time does not reveal which emails are registered. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(password, await dummyHash);
}
