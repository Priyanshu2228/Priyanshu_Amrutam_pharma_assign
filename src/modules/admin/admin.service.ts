import type { Database } from '../../db/database';
import type { CacheService } from '../../lib/cache';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import type { AuditService } from '../audit/audit.service';
import type { SessionGuard } from '../auth/session-guard';
import type { TokenService } from '../auth/token.service';
import { DOCTORS_CACHE_NS } from '../doctors/doctors.service';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import type { UsersRepository } from '../users/users.repository';

export interface AnalyticsSummary {
  range: { from: string; to: string };
  totals: { consultations: number; completed: number; cancelled: number; noShow: number; gmvPaise: number };
  completionRate: number;
  cancellationRate: number;
  revenue: { capturedPaise: number; refundedPaise: number; netPaise: number };
  daily: { day: string; status: string; consultations: number }[];
  topDoctors: { doctorId: string; displayName: string; completed: number }[];
  /** When the pre-aggregated view was last refreshed by the worker. */
  generatedAt: string;
}

const ANALYTICS_TTL_SEC = 60;
const MAX_RANGE_DAYS = 366;

interface Deps {
  db: Database;
  cacheService: CacheService;
  auditService: AuditService;
  usersRepository: UsersRepository;
  doctorsRepository: DoctorsRepository;
  tokenService: TokenService;
  sessionGuard: SessionGuard;
}

export class AdminService {
  constructor(private readonly d: Deps) {}

  /**
   * Dashboard numbers. Status breakdowns come from the `consultation_daily_stats`
   * materialized view and revenue from a ranged index scan; both run on the read replica
   * and are cached briefly, so dashboards never contend with the booking path.
   */
  async analytics(from: Date, to: Date): Promise<AnalyticsSummary> {
    if (to <= from) throw new BadRequestError('INVALID_RANGE', '`to` must be after `from`');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestError('RANGE_TOO_LARGE', `Range cannot exceed ${MAX_RANGE_DAYS} days`);
    }
    const key = `${from.toISOString().slice(0, 10)}|${to.toISOString().slice(0, 10)}`;
    return this.d.cacheService.wrap('analytics', key, ANALYTICS_TTL_SEC, async () => {
      const read = this.d.db.read;
      const [daily, revenue, top] = await Promise.all([
        read.query<{ day: string; status: string; consultations: number; gross_fee_paise: string }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, status::text, consultations, gross_fee_paise
             FROM consultation_daily_stats
            WHERE day >= $1::date AND day < $2::date
            ORDER BY day, status`,
          [from, to],
        ),
        read.query<{ captured: string; refunded: string }>(
          `SELECT coalesce(sum(amount_paise) FILTER (WHERE status IN ('captured', 'refund_pending', 'refunded')), 0) AS captured,
                  coalesce(sum(amount_paise) FILTER (WHERE status = 'refunded'), 0) AS refunded
             FROM payments
            WHERE captured_at >= $1 AND captured_at < $2`,
          [from, to],
        ),
        read.query<{ doctor_id: string; display_name: string; completed: number }>(
          `SELECT c.doctor_id, d.display_name, count(*)::int AS completed
             FROM consultations c JOIN doctors d ON d.user_id = c.doctor_id
            WHERE c.status = 'completed' AND c.scheduled_start >= $1 AND c.scheduled_start < $2
            GROUP BY c.doctor_id, d.display_name
            ORDER BY completed DESC
            LIMIT 10`,
          [from, to],
        ),
      ]);

      const sum = (status?: string) =>
        daily.rows.filter((r) => !status || r.status === status).reduce((acc, r) => acc + r.consultations, 0);
      const total = sum();
      const completed = sum('completed');
      const cancelled = sum('cancelled');
      const captured = Number(revenue.rows[0]?.captured ?? 0);
      const refunded = Number(revenue.rows[0]?.refunded ?? 0);
      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          consultations: total,
          completed,
          cancelled,
          noShow: sum('no_show'),
          gmvPaise: daily.rows
            .filter((r) => ['confirmed', 'in_progress', 'completed', 'no_show'].includes(r.status))
            .reduce((acc, r) => acc + Number(r.gross_fee_paise), 0),
        },
        completionRate: total ? round(completed / total) : 0,
        cancellationRate: total ? round(cancelled / total) : 0,
        revenue: { capturedPaise: captured, refundedPaise: refunded, netPaise: captured - refunded },
        daily: daily.rows.map((r) => ({ day: r.day, status: r.status, consultations: r.consultations })),
        topDoctors: top.rows.map((r) => ({
          doctorId: r.doctor_id,
          displayName: r.display_name,
          completed: r.completed,
        })),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async verifyDoctor(adminId: string, doctorId: string): Promise<void> {
    await this.d.db.withTransaction(async (tx) => {
      if (!(await this.d.doctorsRepository.verify(tx, doctorId, adminId))) throw new NotFoundError('Doctor');
      await this.d.auditService.record(
        { action: 'doctor.verified', entityType: 'doctor', entityId: doctorId },
        tx,
      );
    });
    await this.d.cacheService.bump(DOCTORS_CACHE_NS);
  }

  async setUserStatus(adminId: string, userId: string, status: 'active' | 'suspended'): Promise<void> {
    if (adminId === userId)
      throw new BadRequestError('CANNOT_MODIFY_SELF', 'Admins cannot change their own status');
    await this.d.db.withTransaction(async (tx) => {
      if (!(await this.d.usersRepository.setStatus(userId, status, tx))) throw new NotFoundError('User');
      if (status === 'suspended') await this.d.tokenService.revokeAllForUser(userId, tx);
      await this.d.auditService.record(
        {
          action: status === 'suspended' ? 'user.suspended' : 'user.reactivated',
          entityType: 'user',
          entityId: userId,
        },
        tx,
      );
    });
    // Kill live access tokens immediately rather than waiting for them to expire.
    if (status === 'suspended') await this.d.sessionGuard.blockUser(userId);
    else await this.d.sessionGuard.unblockUser(userId);
  }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
