import { asClass, asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/env';
import { Database } from './db/database';
import { OutboxService } from './jobs/outbox';
import { CacheService } from './lib/cache';
import { LocalDocumentStorage, type DocumentStorage } from './lib/document-storage';
import { FieldCrypto } from './lib/field-crypto';
import { AdminService } from './modules/admin/admin.service';
import { AuditService } from './modules/audit/audit.service';
import { AuthService } from './modules/auth/auth.service';
import { SessionGuard } from './modules/auth/session-guard';
import { TokenService } from './modules/auth/token.service';
import { AvailabilityService } from './modules/availability/availability.service';
import { SlotsRepository } from './modules/availability/slots.repository';
import { BookingService } from './modules/consultations/booking.service';
import { ConsultationsRepository } from './modules/consultations/consultations.repository';
import { ConsultationsService } from './modules/consultations/consultations.service';
import { DoctorsRepository } from './modules/doctors/doctors.repository';
import { DoctorsService } from './modules/doctors/doctors.service';
import { LogNotificationSender, type NotificationSender } from './modules/notifications/notification.service';
import { MockPaymentGateway, type PaymentGateway } from './modules/payments/payment-gateway';
import { PaymentsRepository } from './modules/payments/payments.repository';
import { PaymentsService } from './modules/payments/payments.service';
import { PrescriptionsRepository } from './modules/prescriptions/prescriptions.repository';
import { PrescriptionsService } from './modules/prescriptions/prescriptions.service';
import { UsersRepository } from './modules/users/users.repository';
import { UsersService } from './modules/users/users.service';
import { createLogger } from './telemetry/logger';
import { Metrics } from './telemetry/metrics';

export interface Cradle {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  db: Database;
  redis: Redis;
  cacheService: CacheService;
  fieldCrypto: FieldCrypto;
  documentStorage: DocumentStorage;
  auditService: AuditService;
  outboxService: OutboxService;
  usersRepository: UsersRepository;
  doctorsRepository: DoctorsRepository;
  slotsRepository: SlotsRepository;
  consultationsRepository: ConsultationsRepository;
  paymentsRepository: PaymentsRepository;
  prescriptionsRepository: PrescriptionsRepository;
  tokenService: TokenService;
  sessionGuard: SessionGuard;
  authService: AuthService;
  usersService: UsersService;
  doctorsService: DoctorsService;
  availabilityService: AvailabilityService;
  bookingService: BookingService;
  consultationsService: ConsultationsService;
  paymentGateway: PaymentGateway;
  paymentsService: PaymentsService;
  prescriptionsService: PrescriptionsService;
  adminService: AdminService;
  notificationSender: NotificationSender;
}

export type AppContainer = AwilixContainer<Cradle>;

/**
 * Composition root. Every collaborator is constructor-injected, so tests can override any
 * registration (e.g. the payment gateway) without module mocking.
 */
export function buildContainer(overrides: Partial<{ config: AppConfig; logger: Logger }> = {}): AppContainer {
  const config = overrides.config ?? loadConfig();
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });

  container.register({
    config: asValue(config),
    logger: asValue(overrides.logger ?? createLogger(config)),
    metrics: asClass(Metrics).singleton(),
    db: asClass(Database)
      .singleton()
      .disposer((db) => db.close()),
    redis: asFunction(({ logger }: { logger: Logger }) => {
      const redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
        lazyConnect: true,
      });
      redis.on('error', (err) => logger.warn({ err }, 'redis error'));
      return redis;
    })
      .singleton()
      .disposer(async (redis) => {
        await redis.quit().catch(() => redis.disconnect());
      }),
    cacheService: asClass(CacheService).singleton(),
    fieldCrypto: asFunction(() => new FieldCrypto(config.crypto.fieldKeys)).singleton(),
    documentStorage: asClass(LocalDocumentStorage).singleton(),
    auditService: asClass(AuditService).singleton(),
    outboxService: asClass(OutboxService).singleton(),

    usersRepository: asClass(UsersRepository).singleton(),
    doctorsRepository: asClass(DoctorsRepository).singleton(),
    slotsRepository: asClass(SlotsRepository).singleton(),
    consultationsRepository: asClass(ConsultationsRepository).singleton(),
    paymentsRepository: asClass(PaymentsRepository).singleton(),
    prescriptionsRepository: asClass(PrescriptionsRepository).singleton(),

    tokenService: asClass(TokenService).singleton(),
    sessionGuard: asClass(SessionGuard).singleton(),
    authService: asClass(AuthService).singleton(),
    usersService: asClass(UsersService).singleton(),
    doctorsService: asClass(DoctorsService).singleton(),
    availabilityService: asClass(AvailabilityService).singleton(),
    bookingService: asClass(BookingService).singleton(),
    consultationsService: asClass(ConsultationsService).singleton(),
    paymentGateway: asFunction(() => new MockPaymentGateway(config.payments.webhookSecret)).singleton(),
    paymentsService: asClass(PaymentsService).singleton(),
    prescriptionsService: asClass(PrescriptionsService).singleton(),
    adminService: asClass(AdminService).singleton(),
    notificationSender: asClass(LogNotificationSender).singleton(),
  });

  return container;
}
