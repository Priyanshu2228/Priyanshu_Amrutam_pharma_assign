import type { Database, Queryable } from '../../db/database';
import { decodeCursor, toPage, type Page } from '../../lib/pagination';

export interface DoctorRecord {
  id: string;
  displayName: string;
  registrationNumber: string;
  specializations: string[];
  languages: string[];
  yearsExperience: number;
  consultationFeePaise: number;
  bio: string | null;
  city: string | null;
  rating: number;
  ratingCount: number;
  isVerified: boolean;
}

export interface DoctorSearch {
  q?: string;
  specialization?: string;
  city?: string;
  language?: string;
  minFeePaise?: number;
  maxFeePaise?: number;
  minRating?: number;
  minExperience?: number;
  availableOn?: string; // YYYY-MM-DD (UTC day)
  sort: 'rating' | 'fee_asc' | 'fee_desc' | 'experience';
  limit: number;
  cursor?: string;
}

interface DoctorRow {
  user_id: string;
  display_name: string;
  registration_number: string;
  specializations: string[];
  languages: string[];
  years_experience: number;
  consultation_fee_paise: number;
  bio: string | null;
  city: string | null;
  rating: string;
  rating_count: number;
  is_verified: boolean;
}

const toDoctor = (r: DoctorRow): DoctorRecord => ({
  id: r.user_id,
  displayName: r.display_name,
  registrationNumber: r.registration_number,
  specializations: r.specializations,
  languages: r.languages,
  yearsExperience: r.years_experience,
  consultationFeePaise: r.consultation_fee_paise,
  bio: r.bio,
  city: r.city,
  rating: Number(r.rating),
  ratingCount: r.rating_count,
  isVerified: r.is_verified,
});

// Sort column, direction and how to read the sort key back from a record for the cursor.
const SORTS = {
  rating: { column: 'rating', dir: 'DESC', key: (d: DoctorRecord) => d.rating },
  fee_asc: { column: 'consultation_fee_paise', dir: 'ASC', key: (d: DoctorRecord) => d.consultationFeePaise },
  fee_desc: {
    column: 'consultation_fee_paise',
    dir: 'DESC',
    key: (d: DoctorRecord) => d.consultationFeePaise,
  },
  experience: { column: 'years_experience', dir: 'DESC', key: (d: DoctorRecord) => d.yearsExperience },
} as const;

/** "cardio derm" -> "cardio:* & derm:*" (prefix search), stripping tsquery operators. */
export function toPrefixTsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
}

export class DoctorsRepository {
  private readonly db: Database;

  constructor({ db }: { db: Database }) {
    this.db = db;
  }

  async create(q: Queryable, d: Omit<DoctorRecord, 'rating' | 'ratingCount' | 'isVerified'>): Promise<void> {
    await q.query(
      `INSERT INTO doctors (user_id, display_name, registration_number, specializations, languages,
                            years_experience, consultation_fee_paise, bio, city)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        d.id,
        d.displayName,
        d.registrationNumber,
        d.specializations,
        d.languages,
        d.yearsExperience,
        d.consultationFeePaise,
        d.bio,
        d.city,
      ],
    );
  }

  async findById(id: string, q: Queryable = this.db): Promise<DoctorRecord | null> {
    const { rows } = await q.query<DoctorRow>('SELECT * FROM doctors WHERE user_id = $1', [id]);
    return rows[0] ? toDoctor(rows[0]) : null;
  }

  async update(
    q: Queryable,
    id: string,
    patch: Partial<
      Pick<
        DoctorRecord,
        | 'specializations'
        | 'languages'
        | 'yearsExperience'
        | 'consultationFeePaise'
        | 'bio'
        | 'city'
        | 'displayName'
      >
    >,
  ): Promise<DoctorRecord | null> {
    const columns: Record<string, string> = {
      displayName: 'display_name',
      specializations: 'specializations',
      languages: 'languages',
      yearsExperience: 'years_experience',
      consultationFeePaise: 'consultation_fee_paise',
      bio: 'bio',
      city: 'city',
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      values.push(value);
      sets.push(`${columns[key]} = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id, q);
    const { rows } = await q.query<DoctorRow>(
      `UPDATE doctors SET ${sets.join(', ')} WHERE user_id = $1 RETURNING *`,
      values,
    );
    return rows[0] ? toDoctor(rows[0]) : null;
  }

  async verify(q: Queryable, id: string, adminId: string): Promise<boolean> {
    const res = await q.query(
      'UPDATE doctors SET is_verified = true, verified_at = now(), verified_by = $2 WHERE user_id = $1',
      [id, adminId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Faceted search over verified doctors. Runs against the read replica; every filter
   * maps to a partial index (GIN for full-text/arrays, btree for city/fee/rating).
   */
  async search(s: DoctorSearch): Promise<Page<DoctorRecord>> {
    const where = ['d.is_verified'];
    const params: unknown[] = [];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const tsq = s.q ? toPrefixTsQuery(s.q) : null;
    if (tsq) where.push(`d.search_vector @@ to_tsquery('simple', ${p(tsq)})`);
    if (s.specialization)
      where.push(`d.specializations @> ARRAY[${p(s.specialization.toLowerCase())}]::text[]`);
    if (s.language) where.push(`d.languages @> ARRAY[${p(s.language.toLowerCase())}]::text[]`);
    if (s.city) where.push(`d.city = ${p(s.city)}`);
    if (s.minFeePaise !== undefined) where.push(`d.consultation_fee_paise >= ${p(s.minFeePaise)}`);
    if (s.maxFeePaise !== undefined) where.push(`d.consultation_fee_paise <= ${p(s.maxFeePaise)}`);
    if (s.minRating !== undefined) where.push(`d.rating >= ${p(s.minRating)}`);
    if (s.minExperience !== undefined) where.push(`d.years_experience >= ${p(s.minExperience)}`);
    if (s.availableOn) {
      const day = p(s.availableOn);
      where.push(`EXISTS (
        SELECT 1 FROM availability_slots sl
         WHERE sl.doctor_id = d.user_id AND sl.status = 'open' AND sl.start_at > now()
           AND sl.start_at >= ${day}::date AND sl.start_at < ${day}::date + 1)`);
    }

    const sort = SORTS[s.sort];
    const cursor = decodeCursor(s.cursor, 2);
    if (cursor) {
      const op = sort.dir === 'DESC' ? '<' : '>';
      where.push(`(d.${sort.column}, d.user_id) ${op} (${p(cursor[0])}, ${p(cursor[1])}::uuid)`);
    }

    const { rows } = await this.db.read.query<DoctorRow>(
      `SELECT d.* FROM doctors d
        WHERE ${where.join(' AND ')}
        ORDER BY d.${sort.column} ${sort.dir}, d.user_id ${sort.dir}
        LIMIT ${p(s.limit + 1)}`,
      params,
    );
    return toPage(rows.map(toDoctor), s.limit, (d) => [sort.key(d), d.id]);
  }
}
