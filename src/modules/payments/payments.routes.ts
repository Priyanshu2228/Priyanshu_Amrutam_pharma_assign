import { Router } from 'express';
import { z } from 'zod';
import type { Cradle } from '../../container';
import type { Middleware } from '../../middleware';
import { authUser } from '../../middleware/auth';

export function paymentsRouter({ paymentsService, bookingService }: Cradle, mw: Middleware): Router {
  const r = Router();

  /**
   * Provider webhook. Authenticated by HMAC signature over the raw body (not by JWT) and
   * deduplicated by event id, so provider retries are harmless.
   */
  r.post('/webhook', async (req, res) => {
    const event = paymentsService.parseWebhook(req.rawBody, req.header('X-Signature'));
    const result =
      event.type === 'payment.captured'
        ? await bookingService.onPaymentCaptured(event.data.providerPaymentId, event.id)
        : await bookingService.onPaymentFailed(event.data.providerPaymentId, event.id, event.data.reason);
    res.json({ received: true, ...result });
  });

  /** Mock provider only: simulates the patient completing checkout. */
  r.post(
    '/:id/mock-confirm',
    mw.auth.authenticate,
    mw.auth.authorize('payment:confirm'),
    mw.idempotent(),
    async (req, res) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const payment = await paymentsService.getMockCapturable(authUser(req).userId, id);
      res.json(
        await bookingService.onPaymentCaptured(payment.providerPaymentId!, `mock-capture-${payment.id}`),
      );
    },
  );

  return r;
}
