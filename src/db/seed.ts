/**
 * Development seed: one admin, a few verified doctors with upcoming slots, and a patient.
 * Idempotent — safe to run repeatedly. Never run against production.
 */
import { buildContainer } from '../container';
import { hashPassword } from '../lib/password';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Amrutam@12345';

const DOCTORS = [
  {
    email: 'dr.sharma@amrutam.local',
    name: 'Dr. Ananya Sharma',
    reg: 'AYU-MH-10021',
    spec: ['ayurveda', 'dermatology'],
    langs: ['english', 'hindi', 'marathi'],
    exp: 12,
    fee: 59900,
    city: 'Mumbai',
    rating: 4.8,
  },
  {
    email: 'dr.iyer@amrutam.local',
    name: 'Dr. Karthik Iyer',
    reg: 'AYU-TN-20444',
    spec: ['ayurveda', 'gastroenterology'],
    langs: ['english', 'tamil'],
    exp: 8,
    fee: 49900,
    city: 'Chennai',
    rating: 4.6,
  },
  {
    email: 'dr.verma@amrutam.local',
    name: 'Dr. Meera Verma',
    reg: 'AYU-DL-30987',
    spec: ['panchakarma', 'nutrition'],
    langs: ['english', 'hindi'],
    exp: 15,
    fee: 79900,
    city: 'Delhi',
    rating: 4.9,
  },
];

async function main() {
  const container = buildContainer();
  const { db, config, fieldCrypto } = container.cradle;
  if (config.isProduction) throw new Error('Refusing to seed a production database');
  const hash = await hashPassword(PASSWORD);

  await db.withTransaction(async (tx) => {
    const upsertUser = async (email: string, role: string, fullName: string, city: string | null) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [email, hash, role],
      );
      const id = rows[0]!.id;
      await tx.query(
        `INSERT INTO profiles (user_id, full_name, phone_enc, city) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
        [id, fullName, fieldCrypto.encrypt('+919800000000'), city],
      );
      return id;
    };

    const adminId = await upsertUser('admin@amrutam.local', 'admin', 'Platform Admin', null);
    await upsertUser('patient@amrutam.local', 'patient', 'Riya Patel', 'Pune');

    for (const d of DOCTORS) {
      const id = await upsertUser(d.email, 'doctor', d.name, d.city);
      await tx.query(
        `INSERT INTO doctors (user_id, display_name, registration_number, specializations, languages, years_experience,
                              consultation_fee_paise, bio, city, rating, rating_count, is_verified, verified_at, verified_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 120, true, now(), $11)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          id,
          d.name,
          d.reg,
          d.spec,
          d.langs,
          d.exp,
          d.fee,
          `${d.name} practises ${d.spec.join(' and ')}.`,
          d.city,
          d.rating,
          adminId,
        ],
      );
      // 30-minute slots, 10:00-13:00 UTC, for the next 7 days.
      await tx.query(
        `INSERT INTO availability_slots (doctor_id, start_at, end_at)
         SELECT $1, s, s + interval '30 minutes'
           FROM generate_series(date_trunc('day', now()) + interval '1 day 10 hours',
                                date_trunc('day', now()) + interval '7 days 12 hours 30 minutes',
                                interval '30 minutes') AS s
          WHERE extract(hour FROM s) BETWEEN 10 AND 12
         ON CONFLICT DO NOTHING`,
        [id],
      );
    }
  });

  console.log(
    `Seeded. Users: admin@amrutam.local, patient@amrutam.local, ${DOCTORS.map((d) => d.email).join(', ')}`,
  );
  console.log('Password for all seeded users is the SEED_PASSWORD env var (default documented in README).');
  await container.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
