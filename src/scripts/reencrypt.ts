/**
 * Key rotation, step 2 of 3: rewrite every encrypted column with the active key.
 *
 *   1. Prepend the new key to FIELD_ENCRYPTION_KEYS and deploy (new writes use it; old
 *      rows still decrypt with the old key).
 *   2. Run `npm run keys:reencrypt` (batched, resumable, safe to run while serving traffic).
 *   3. Remove the old key from the keyring and deploy.
 */
import { buildContainer } from '../container';

const TARGETS: { table: string; pk: string; columns: string[] }[] = [
  { table: 'users', pk: 'id', columns: ['mfa_secret_enc'] },
  { table: 'profiles', pk: 'user_id', columns: ['phone_enc'] },
  { table: 'consultations', pk: 'id', columns: ['reason_enc', 'doctor_notes_enc'] },
  { table: 'prescriptions', pk: 'id', columns: ['diagnosis_enc', 'medications_enc', 'advice_enc'] },
];
const BATCH = 500;

async function main() {
  const container = buildContainer();
  const { db, fieldCrypto } = container.cradle;
  const prefix = `${fieldCrypto.activeKid}.`;

  for (const { table, pk, columns } of TARGETS) {
    for (const column of columns) {
      let total = 0;
      for (;;) {
        // Each batch is its own short transaction; FOR UPDATE SKIP LOCKED avoids fighting live writes.
        const n = await db.withTransaction(async (tx) => {
          const { rows } = await tx.query<{ pk: string; value: string }>(
            `SELECT ${pk} AS pk, ${column} AS value FROM ${table}
              WHERE ${column} IS NOT NULL AND left(${column}, $1) <> $2
              LIMIT $3 FOR UPDATE SKIP LOCKED`,
            [prefix.length, prefix, BATCH],
          );
          for (const row of rows) {
            const rotated = fieldCrypto.encrypt(fieldCrypto.decrypt(row.value));
            await tx.query(`UPDATE ${table} SET ${column} = $2 WHERE ${pk} = $1`, [row.pk, rotated]);
          }
          return rows.length;
        });
        total += n;
        if (n < BATCH) break;
      }
      console.log(`${table}.${column}: re-encrypted ${total} value(s) with key ${fieldCrypto.activeKid}`);
    }
  }
  await container.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
