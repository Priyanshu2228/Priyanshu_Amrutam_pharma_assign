import type { Database } from '../../db/database';
import { NotFoundError } from '../../lib/errors';
import type { FieldCrypto } from '../../lib/field-crypto';
import type { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/rbac';
import type { UsersRepository } from './users.repository';

export interface MeView {
  id: string;
  email: string;
  role: Role;
  mfaEnabled: boolean;
  createdAt: string;
  profile: {
    fullName: string;
    phone: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    city: string | null;
  } | null;
}

export interface ProfilePatch {
  fullName?: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: 'female' | 'male' | 'other' | 'undisclosed' | null;
  city?: string | null;
}

interface Deps {
  db: Database;
  fieldCrypto: FieldCrypto;
  auditService: AuditService;
  usersRepository: UsersRepository;
}

export class UsersService {
  constructor(private readonly d: Deps) {}

  async getMe(userId: string): Promise<MeView> {
    const [user, profile] = await Promise.all([
      this.d.usersRepository.findById(userId),
      this.d.usersRepository.getProfile(userId),
    ]);
    if (!user) throw new NotFoundError('User');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      mfaEnabled: user.mfaEnabled,
      createdAt: user.createdAt.toISOString(),
      profile: profile && {
        fullName: profile.fullName,
        phone: this.d.fieldCrypto.decryptNullable(profile.phoneEnc),
        dateOfBirth: profile.dateOfBirth,
        gender: profile.gender,
        city: profile.city,
      },
    };
  }

  async updateMe(userId: string, patch: ProfilePatch): Promise<MeView> {
    const { phone, ...rest } = patch;
    await this.d.db.withTransaction(async (tx) => {
      await this.d.usersRepository.updateProfile(tx, userId, {
        ...rest,
        ...(phone !== undefined ? { phoneEnc: this.d.fieldCrypto.encryptNullable(phone) } : {}),
      });
      // Record which fields changed, never their values.
      await this.d.auditService.record(
        {
          action: 'user.profile.updated',
          entityType: 'user',
          entityId: userId,
          metadata: { fields: Object.keys(patch) },
        },
        tx,
      );
    });
    return this.getMe(userId);
  }
}
