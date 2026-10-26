import type { Logger } from 'pino';

export interface Notification {
  userId: string;
  template:
    'consultation_confirmed' | 'consultation_cancelled' | 'consultation_completed' | 'prescription_ready';
  data: Record<string, string | number | boolean>;
}

/**
 * Notification port (email/SMS/push). Templates carry identifiers only; message bodies are
 * rendered by the provider so no PHI transits our logs or the queue.
 */
export interface NotificationSender {
  send(n: Notification): Promise<void>;
}

/** Development adapter: logs the notification instead of delivering it. */
export class LogNotificationSender implements NotificationSender {
  private readonly logger: Logger;

  constructor({ logger }: { logger: Logger }) {
    this.logger = logger;
  }

  async send(n: Notification): Promise<void> {
    this.logger.info(
      { notification: { userId: n.userId, template: n.template, data: n.data } },
      'notification dispatched',
    );
  }
}
