import type { Database, Queryable } from '../../db/database';
import type { Role } from '../auth/rbac';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  status: 'active' | 'suspended';
  mfaEnabled: boolean;
  mfaSecretEnc: string | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

export interface ProfileRecord {
  userId: string;
  fullName: string;
  phoneEnc: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  city: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  status: 'active' | 'suspended';
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  status: r.status,
  mfaEnabled: r.mfa_enabled,
  mfaSecretEnc: r.mfa_secret_enc,
  failedLoginAttempts: r.failed_login_attempts,
  lockedUntil: r.locked_until,
  createdAt: r.created_at,
});

export class UsersRepository {
  private readonly db: Database;

  constructor({ db }: { db: Database }) {
    this.db = db;
  }

  async findByEmail(email: string, q: Queryable = this.db): Promise<UserRecord | null> {
    const { rows } = await q.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(id: string, q: Queryable = this.db): Promise<UserRecord | null> {
    const { rows } = await q.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async create(
    q: Queryable,
    input: { email: string; passwordHash: string; role: Role },
  ): Promise<UserRecord> {
    const { rows } = await q.query<UserRow>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *',
      [input.email, input.passwordHash, input.role],
    );
    return toUser(rows[0]!);
  }

  /** Atomically increments the failure counter and locks the account at the threshold. */
  async recordLoginFailure(id: string, threshold: number, lockMinutes: number): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE WHEN failed_login_attempts + 1 >= $2
                                  THEN now() + make_interval(mins => $3) ELSE locked_until END
        WHERE id = $1`,
      [id, threshold, lockMinutes],
    );
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await this.db.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [id],
    );
  }

  async setMfaSecret(id: string, secretEnc: string): Promise<void> {
    await this.db.query('UPDATE users SET mfa_secret_enc = $2, mfa_enabled = false WHERE id = $1', [
      id,
      secretEnc,
    ]);
  }

  async enableMfa(id: string, q: Queryable = this.db): Promise<void> {
    await q.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [id]);
  }

  async setStatus(id: string, status: 'active' | 'suspended', q: Queryable = this.db): Promise<boolean> {
    const res = await q.query('UPDATE users SET status = $2 WHERE id = $1', [id, status]);
    return (res.rowCount ?? 0) > 0;
  }

  async createProfile(
    q: Queryable,
    p: { userId: string; fullName: string; phoneEnc: string | null; city?: string | null },
  ): Promise<void> {
    await q.query('INSERT INTO profiles (user_id, full_name, phone_enc, city) VALUES ($1, $2, $3, $4)', [
      p.userId,
      p.fullName,
      p.phoneEnc,
      p.city ?? null,
    ]);
  }

  async getProfile(userId: string): Promise<ProfileRecord | null> {
    const { rows } = await this.db.query<{
      user_id: string;
      full_name: string;
      phone_enc: string | null;
      date_of_birth: string | null;
      gender: string | null;
      city: string | null;
    }>(
      `SELECT user_id, full_name, phone_enc, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth, gender, city
         FROM profiles WHERE user_id = $1`,
      [userId],
    );
    const r = rows[0];
    return r
      ? {
          userId: r.user_id,
          fullName: r.full_name,
          phoneEnc: r.phone_enc,
          dateOfBirth: r.date_of_birth,
          gender: r.gender,
          city: r.city,
        }
      : null;
  }

  async updateProfile(
    q: Queryable,
    userId: string,
    patch: Partial<{
      fullName: string;
      phoneEnc: string | null;
      dateOfBirth: string | null;
      gender: string | null;
      city: string | null;
    }>,
  ): Promise<void> {
    const columns: Record<string, string> = {
      fullName: 'full_name',
      phoneEnc: 'phone_enc',
      dateOfBirth: 'date_of_birth',
      gender: 'gender',
      city: 'city',
    };
    const sets: string[] = [];
    const values: unknown[] = [userId];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      values.push(value);
      sets.push(`${columns[key]} = $${values.length}`);
    }
    if (sets.length === 0) return;
    await q.query(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1`, values);
  }
}
