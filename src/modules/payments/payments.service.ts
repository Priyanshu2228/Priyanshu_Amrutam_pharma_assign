import type { Logger } from 'pino';
import { z } from 'zod';
import type { Database } from '../../db/database';
import { CircuitBreaker } from '../../lib/circuit-breaker';
import { ForbiddenError, NotFoundError, UnauthorizedError, ConflictError } from '../../lib/errors';
import { retry } from '../../lib/retry';
import type { Metrics } from '../../telemetry/metrics';
import type { AuditService } from '../audit/audit.service';
import type { ConsultationsRepository } from '../consultations/consultations.repository';
import { PaymentProviderError, type PaymentGateway, type PaymentIntent } from './payment-gateway';
import type { PaymentRecord, PaymentsRepository } from './payments.repository';

const webhookEvent = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.captured', 'payment.failed']),
  data: z.object({ providerPaymentId: z.string().min(1).max(200), reason: z.string().max(500).optional() }),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;

interface Deps {
  db: Database;
  logger: Logger;
  metrics: Metrics;
  paymentGateway: PaymentGateway;
  paymentsRepository: PaymentsRepository;
  consultationsRepository: ConsultationsRepository;
  auditService: AuditService;
}

export class PaymentsService {
  /** Fail fast while the provider is down instead of stacking timeouts on every request. */
  private readonly breaker = new CircuitBreaker({
    name: 'payment-provider',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
  });

  constructor(private readonly d: Deps) {}

  /**
   * Calls the provider with bounded, jittered retries for transient failures. The payment
   * id doubles as the provider idempotency key, so a retry can never create two intents.
   */
  async createIntent(payment: PaymentRecord): Promise<PaymentIntent> {
    const intent = await this.callProvider('create_intent', () =>
      this.d.paymentGateway.createIntent(
        { paymentId: payment.id, amountPaise: payment.amountPaise, currency: payment.currency },
        `intent-${payment.id}`,
      ),
    );
    await this.d.paymentsRepository.setProviderPaymentId(payment.id, intent.providerPaymentId);
    return intent;
  }

  /** Executes a refund that the booking saga scheduled. Safe to call repeatedly. */
  async processRefund(paymentId: string): Promise<'refunded' | 'skipped'> {
    const payment = await this.d.paymentsRepository.findById(paymentId);
    if (!payment || payment.status !== 'refund_pending' || !payment.providerPaymentId) return 'skipped';
    const { refundId } = await this.callProvider('refund', () =>
      this.d.paymentGateway.refund(
        { providerPaymentId: payment.providerPaymentId!, amountPaise: payment.amountPaise },
        `refund-${payment.id}`,
      ),
    );
    await this.d.db.withTransaction(async (tx) => {
      const updated = await this.d.paymentsRepository.setStatus(
        tx,
        payment.id,
        ['refund_pending'],
        'refunded',
        {
          providerRefundId: refundId,
        },
      );
      if (updated) {
        await this.d.auditService.record(
          {
            action: 'payment.refunded',
            entityType: 'payment',
            entityId: payment.id,
            actorRole: 'system',
            metadata: { amountPaise: payment.amountPaise, refundId },
          },
          tx,
        );
      }
    });
    return 'refunded';
  }

  /** Authenticates and parses a provider webhook. */
  parseWebhook(rawBody: Buffer | undefined, signature: string | undefined): WebhookEvent {
    if (!rawBody || !this.d.paymentGateway.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedError('Invalid webhook signature', 'INVALID_SIGNATURE');
    }
    return webhookEvent.parse(JSON.parse(rawBody.toString('utf8')));
  }

  /** Demo-only: lets the patient complete a mock payment without a provider round trip. */
  async getMockCapturable(patientId: string, paymentId: string): Promise<PaymentRecord> {
    if (this.d.paymentGateway.name !== 'mock') throw new NotFoundError('Route');
    const payment = await this.d.paymentsRepository.findById(paymentId);
    if (!payment) throw new NotFoundError('Payment');
    const consultation = await this.d.consultationsRepository.findById(payment.consultationId);
    if (consultation?.patientId !== patientId) throw new ForbiddenError();
    if (!payment.providerPaymentId)
      throw new ConflictError('PAYMENT_NOT_READY', 'Payment intent has not been created');
    return payment;
  }

  get providerName(): string {
    return this.d.paymentGateway.name;
  }

  private async callProvider<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const provider = this.d.paymentGateway.name;
    try {
      const result = await retry(() => this.breaker.exec(fn), {
        retries: 3,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        shouldRetry: (err) => err instanceof PaymentProviderError && err.retryable,
        onRetry: (err, attempt, delayMs) =>
          this.d.logger.warn(
            { err, attempt, delayMs, provider, operation },
            'retrying payment provider call',
          ),
      });
      this.d.metrics.externalCalls.inc({ provider, operation, outcome: 'success' });
      return result;
    } catch (err) {
      this.d.metrics.externalCalls.inc({ provider, operation, outcome: 'failure' });
      throw err;
    }
  }
}
