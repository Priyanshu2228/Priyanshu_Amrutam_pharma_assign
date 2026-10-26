import type { Database } from '../../db/database';
import type { CacheService } from '../../lib/cache';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PgCodes,
  pgCode,
} from '../../lib/errors';
import type { AuditService } from '../audit/audit.service';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import type { SlotRecord, SlotsRepository } from './slots.repository';

const MIN_SLOT_MINUTES = 10;
const MAX_SLOT_MINUTES = 120;
const MAX_RANGE_DAYS = 31;
const SLOT_CACHE_TTL_SEC = 15;

interface Deps {
  db: Database;
  slotsRepository: SlotsRepository;
  doctorsRepository: DoctorsRepository;
  cacheService: CacheService;
  auditService: AuditService;
}

export const slotCacheNamespace = (doctorId: string) => `slots:${doctorId}`;

export class AvailabilityService {
  constructor(private readonly d: Deps) {}

  /** Public listing of bookable slots; short TTL + explicit invalidation on every change. */
  async listOpenSlots(doctorId: string, from: Date, to: Date): Promise<SlotRecord[]> {
    this.assertRange(from, to);
    const doctor = await this.d.doctorsRepository.findById(doctorId);
    if (!doctor || !doctor.isVerified) throw new NotFoundError('Doctor');
    const effectiveFrom = new Date(Math.max(from.getTime(), Date.now()));
    return this.d.cacheService.wrap(
      slotCacheNamespace(doctorId),
      `${effectiveFrom.toISOString().slice(0, 16)}|${to.toISOString()}`,
      SLOT_CACHE_TTL_SEC,
      () => this.d.slotsRepository.list(doctorId, effectiveFrom, to, ['open']),
    );
  }

  /** The doctor's own calendar, including held/booked/blocked slots; never cached. */
  async listOwnSlots(doctorId: string, from: Date, to: Date): Promise<SlotRecord[]> {
    this.assertRange(from, to);
    return this.d.slotsRepository.list(doctorId, from, to, ['open', 'held', 'booked', 'blocked']);
  }

  async createSlots(doctorId: string, input: { startAt: Date; endAt: Date }[]): Promise<SlotRecord[]> {
    const doctor = await this.d.doctorsRepository.findById(doctorId);
    if (!doctor) throw new NotFoundError('Doctor');
    if (!doctor.isVerified) {
      throw new ForbiddenError(
        'Your profile must be verified before publishing availability',
        'DOCTOR_NOT_VERIFIED',
      );
    }
    const now = Date.now();
    for (const [i, s] of input.entries()) {
      const minutes = (s.endAt.getTime() - s.startAt.getTime()) / 60_000;
      if (s.startAt.getTime() <= now)
        throw new BadRequestError('SLOT_IN_PAST', `slots[${i}] starts in the past`);
      if (minutes < MIN_SLOT_MINUTES || minutes > MAX_SLOT_MINUTES) {
        throw new BadRequestError(
          'INVALID_SLOT_DURATION',
          `slots[${i}] must last between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES} minutes`,
        );
      }
    }
    try {
      const created = await this.d.db.withTransaction(async (tx) => {
        const slots = await this.d.slotsRepository.createMany(tx, doctorId, input);
        await this.d.auditService.record(
          {
            action: 'slots.created',
            entityType: 'doctor',
            entityId: doctorId,
            metadata: { count: slots.length },
          },
          tx,
        );
        return slots;
      });
      await this.d.cacheService.bump(slotCacheNamespace(doctorId));
      return created;
    } catch (err) {
      if (pgCode(err) === PgCodes.EXCLUSION_VIOLATION) {
        throw new ConflictError('SLOT_OVERLAP', 'One or more slots overlap existing availability');
      }
      throw err;
    }
  }

  async withdrawSlot(doctorId: string, slotId: string): Promise<void> {
    if (!(await this.d.slotsRepository.block(doctorId, slotId))) {
      const slot = await this.d.slotsRepository.findById(slotId);
      if (!slot || slot.doctorId !== doctorId) throw new NotFoundError('Slot');
      throw new ConflictError(
        'SLOT_NOT_OPEN',
        'Only open slots can be withdrawn; cancel the consultation instead',
      );
    }
    await this.d.auditService.record({ action: 'slot.withdrawn', entityType: 'slot', entityId: slotId });
    await this.d.cacheService.bump(slotCacheNamespace(doctorId));
  }

  private assertRange(from: Date, to: Date) {
    if (to <= from) throw new BadRequestError('INVALID_RANGE', '`to` must be after `from`');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestError('RANGE_TOO_LARGE', `Range cannot exceed ${MAX_RANGE_DAYS} days`);
    }
  }
}
