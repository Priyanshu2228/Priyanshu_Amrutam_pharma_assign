import { authenticator } from 'otplib';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env';
import type { Database } from '../../db/database';
import { ConflictError, ForbiddenError, PgCodes, pgCode, UnauthorizedError } from '../../lib/errors';
import type { FieldCrypto } from '../../lib/field-crypto';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import type { AuditService } from '../audit/audit.service';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import type { UsersRepository, UserRecord } from '../users/users.repository';
import type { RegisterInput } from './auth.schemas';
import type { SessionGuard } from './session-guard';
import type { TokenPair, TokenService } from './token.service';

authenticator.options = { window: 1 }; // accept +/- one 30s step for clock skew

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

export type LoginResult =
  ({ mfaRequired: false; mfaSetupRequired: boolean } & TokenPair) | { mfaRequired: true; mfaToken: string };

interface Deps {
  config: AppConfig;
  db: Database;
  logger: Logger;
  usersRepository: UsersRepository;
  doctorsRepository: DoctorsRepository;
  tokenService: TokenService;
  sessionGuard: SessionGuard;
  auditService: AuditService;
  fieldCrypto: FieldCrypto;
}

export class AuthService {
  constructor(private readonly d: Deps) {}

  async register(input: RegisterInput): Promise<{ userId: string } & TokenPair> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.d.db.withTransaction(async (tx) => {
        const user = await this.d.usersRepository.create(tx, {
          email: input.email,
          passwordHash,
          role: input.role,
        });
        await this.d.usersRepository.createProfile(tx, {
          userId: user.id,
          fullName: input.fullName,
          phoneEnc: this.d.fieldCrypto.encryptNullable(input.phone),
          city: input.role === 'patient' ? input.city : input.doctor.city,
        });
        if (input.role === 'doctor') {
          await this.d.doctorsRepository.create(tx, {
            id: user.id,
            displayName: input.fullName,
            registrationNumber: input.doctor.registrationNumber,
            specializations: input.doctor.specializations,
            languages: input.doctor.languages,
            yearsExperience: input.doctor.yearsExperience,
            consultationFeePaise: input.doctor.consultationFeePaise,
            bio: input.doctor.bio ?? null,
            city: input.doctor.city ?? null,
          });
        }
        await this.d.auditService.record(
          {
            action: 'user.registered',
            entityType: 'user',
            entityId: user.id,
            actorId: user.id,
            actorRole: user.role,
          },
          tx,
        );
        const pair = await this.d.tokenService.issuePair(user, false, tx);
        return { userId: user.id, ...pair };
      });
    } catch (err) {
      if (pgCode(err) === PgCodes.UNIQUE_VIOLATION) {
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (constraint.includes('registration_number')) {
          throw new ConflictError(
            'REGISTRATION_NUMBER_TAKEN',
            'This medical registration number is already registered',
          );
        }
        throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.d.usersRepository.findByEmail(email);
    if (!user) {
      await burnPasswordCheck(password);
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    // Locked accounts get the same generic answer, so lockout cannot be used to probe emails.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await burnPasswordCheck(password);
      await this.audit('auth.login.locked', user);
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.d.usersRepository.recordLoginFailure(user.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES);
      await this.audit('auth.login.failed', user, { attempt: user.failedLoginAttempts + 1 });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') {
      throw new ForbiddenError('This account is suspended', 'ACCOUNT_SUSPENDED');
    }

    if (user.mfaEnabled) {
      await this.audit('auth.login.mfa_challenge', user);
      return { mfaRequired: true, mfaToken: this.d.tokenService.issueMfaChallenge(user.id) };
    }

    await this.d.usersRepository.recordLoginSuccess(user.id);
    await this.audit('auth.login.success', user, { mfa: false });
    const pair = await this.d.tokenService.issuePair(user, false);
    return {
      mfaRequired: false,
      mfaSetupRequired: this.d.config.auth.mfaRequiredRoles.includes(user.role),
      ...pair,
    };
  }

  async verifyMfa(mfaToken: string, code: string): Promise<TokenPair> {
    const userId = this.d.tokenService.verifyMfaChallenge(mfaToken);
    const user = await this.d.usersRepository.findById(userId);
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new UnauthorizedError('Invalid or expired token', 'INVALID_TOKEN');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedError('Invalid code', 'INVALID_MFA_CODE');
    }
    if (!(await this.checkTotp(user, code))) {
      await this.d.usersRepository.recordLoginFailure(user.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES);
      await this.audit('auth.mfa.failed', user);
      throw new UnauthorizedError('Invalid code', 'INVALID_MFA_CODE');
    }
    await this.d.usersRepository.recordLoginSuccess(user.id);
    await this.audit('auth.login.success', user, { mfa: true });
    return this.d.tokenService.issuePair(user, true);
  }

  async setupMfa(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabled) throw new ConflictError('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    const secret = authenticator.generateSecret();
    await this.d.usersRepository.setMfaSecret(user.id, this.d.fieldCrypto.encrypt(secret));
    return { secret, otpauthUrl: authenticator.keyuri(user.email, 'Amrutam', secret) };
  }

  /** Confirms enrolment and upgrades the current session to an MFA-verified one. */
  async enableMfa(userId: string, code: string): Promise<TokenPair> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabled) throw new ConflictError('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    if (!user.mfaSecretEnc) throw new ConflictError('MFA_NOT_SETUP', 'Call /auth/mfa/setup first');
    if (!(await this.checkTotp(user, code))) {
      throw new UnauthorizedError('Invalid code', 'INVALID_MFA_CODE');
    }
    return this.d.db.withTransaction(async (tx) => {
      await this.d.usersRepository.enableMfa(user.id, tx);
      // Sessions created before enrolment were single-factor; end them.
      await this.d.tokenService.revokeAllForUser(user.id, tx);
      await this.d.auditService.record(
        { action: 'auth.mfa.enabled', entityType: 'user', entityId: user.id },
        tx,
      );
      return this.d.tokenService.issuePair(user, true, tx);
    });
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const result = await this.d.tokenService.rotate(refreshToken, (id, q) =>
      this.d.usersRepository.findById(id, q),
    );
    if (result.kind === 'reuse') {
      await this.d.auditService.record({
        action: 'auth.refresh.reuse_detected',
        entityType: 'user',
        entityId: result.userId,
        actorId: result.userId,
      });
      this.d.logger.warn({ userId: result.userId }, 'refresh token reuse detected; session family revoked');
      throw new UnauthorizedError('Session revoked', 'SESSION_REVOKED');
    }
    if (result.kind === 'invalid') throw new UnauthorizedError('Invalid refresh token', 'INVALID_TOKEN');
    return result.pair;
  }

  async logout(sessionId: string, refreshToken?: string): Promise<void> {
    if (refreshToken) await this.d.tokenService.revokeFamilyByToken(refreshToken);
    await this.d.sessionGuard.revokeSession(sessionId);
    await this.d.auditService.record({ action: 'auth.logout', entityType: 'session', entityId: sessionId });
  }

  private async checkTotp(user: UserRecord, code: string): Promise<boolean> {
    const secret = this.d.fieldCrypto.decrypt(user.mfaSecretEnc!);
    if (!authenticator.check(code, secret)) return false;
    return this.d.sessionGuard.claimTotp(user.id, code);
  }

  private async requireUser(userId: string): Promise<UserRecord> {
    const user = await this.d.usersRepository.findById(userId);
    if (!user) throw new UnauthorizedError();
    return user;
  }

  private audit(action: string, user: UserRecord, metadata?: Record<string, unknown>) {
    return this.d.auditService.record({
      action,
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorRole: user.role,
      metadata,
    });
  }
}
