import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PaymentIntent {
  providerPaymentId: string;
  /** Handed to the client SDK to complete payment (card/UPI) with the provider. */
  clientSecret: string;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    /** Transient failures (timeouts, 5xx, 429) are worth retrying; declines are not. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Port for the payment provider (Razorpay/Stripe/etc). The domain never imports a vendor
 * SDK directly; swapping providers means adding an adapter, not touching booking code.
 */
export interface PaymentGateway {
  readonly name: string;
  createIntent(
    input: { paymentId: string; amountPaise: number; currency: string },
    idempotencyKey: string,
  ): Promise<PaymentIntent>;
  refund(
    input: { providerPaymentId: string; amountPaise: number },
    idempotencyKey: string,
  ): Promise<{ refundId: string }>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}

export function signWebhook(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Deterministic in-process provider for local development, tests and demos. Honours
 * idempotency keys exactly like a real provider would.
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';
  private readonly intents = new Map<string, PaymentIntent>();
  private readonly refunds = new Map<string, { refundId: string }>();
  /** Test hook: number of upcoming calls that should fail with a transient error. */
  failNext = 0;

  constructor(private readonly webhookSecret: string) {}

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new PaymentProviderError('mock provider unavailable', true);
    }
  }

  async createIntent(input: { paymentId: string }, idempotencyKey: string): Promise<PaymentIntent> {
    this.maybeFail();
    const existing = this.intents.get(idempotencyKey);
    if (existing) return existing;
    const intent = {
      providerPaymentId: `pay_mock_${input.paymentId.replace(/-/g, '').slice(0, 20)}`,
      clientSecret: `secret_${randomBytes(12).toString('hex')}`,
    };
    this.intents.set(idempotencyKey, intent);
    return intent;
  }

  async refund(input: { providerPaymentId: string }, idempotencyKey: string): Promise<{ refundId: string }> {
    this.maybeFail();
    const existing = this.refunds.get(idempotencyKey);
    if (existing) return existing;
    const refund = { refundId: `rfnd_mock_${input.providerPaymentId.slice(-12)}` };
    this.refunds.set(idempotencyKey, refund);
    return refund;
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const expected = Buffer.from(signWebhook(this.webhookSecret, rawBody));
    const actual = Buffer.from(signatureHeader);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
