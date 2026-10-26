import { createHash } from 'node:crypto';
import type { Database } from '../../db/database';
import type { CacheService } from '../../lib/cache';
import { NotFoundError } from '../../lib/errors';
import type { Page } from '../../lib/pagination';
import type { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/rbac';
import type { DoctorRecord, DoctorSearch, DoctorsRepository } from './doctors.repository';

const SEARCH_TTL_SEC = 60;
const PROFILE_TTL_SEC = 300;
export const DOCTORS_CACHE_NS = 'doctors';

/** Public projection: the registration number is verified by admins, not shown to patients. */
export type PublicDoctor = Omit<DoctorRecord, 'registrationNumber'>;

const toPublic = ({ registrationNumber: _r, ...rest }: DoctorRecord): PublicDoctor => rest;

interface Deps {
  db: Database;
  doctorsRepository: DoctorsRepository;
  cacheService: CacheService;
  auditService: AuditService;
}

export class DoctorsService {
  constructor(private readonly d: Deps) {}

  async search(params: DoctorSearch): Promise<Page<PublicDoctor>> {
    const key = createHash('sha1').update(JSON.stringify(params)).digest('hex');
    return this.d.cacheService.wrap(DOCTORS_CACHE_NS, `search:${key}`, SEARCH_TTL_SEC, async () => {
      const page = await this.d.doctorsRepository.search(params);
      return { data: page.data.map(toPublic), nextCursor: page.nextCursor };
    });
  }

  async getById(id: string, viewer: { userId: string; role: Role }): Promise<PublicDoctor | DoctorRecord> {
    // Owners and admins see the full record (including unverified state) uncached.
    if (viewer.role === 'admin' || viewer.userId === id) {
      const doctor = await this.d.doctorsRepository.findById(id);
      if (!doctor) throw new NotFoundError('Doctor');
      return doctor;
    }
    const doctor = await this.d.cacheService.wrap(DOCTORS_CACHE_NS, `id:${id}`, PROFILE_TTL_SEC, () =>
      this.d.doctorsRepository.findById(id),
    );
    if (!doctor || !doctor.isVerified) throw new NotFoundError('Doctor');
    return toPublic(doctor);
  }

  async updateOwnProfile(
    doctorId: string,
    patch: Partial<
      Pick<
        DoctorRecord,
        'specializations' | 'languages' | 'yearsExperience' | 'consultationFeePaise' | 'bio' | 'city'
      >
    >,
  ): Promise<DoctorRecord> {
    const updated = await this.d.db.withTransaction(async (tx) => {
      const doctor = await this.d.doctorsRepository.update(tx, doctorId, patch);
      if (!doctor) throw new NotFoundError('Doctor');
      await this.d.auditService.record(
        {
          action: 'doctor.profile.updated',
          entityType: 'doctor',
          entityId: doctorId,
          metadata: { fields: Object.keys(patch) },
        },
        tx,
      );
      return doctor;
    });
    await this.d.cacheService.bump(DOCTORS_CACHE_NS);
    return updated;
  }
}
