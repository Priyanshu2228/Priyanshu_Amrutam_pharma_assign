import { ServiceUnavailableError } from './errors';

type State = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** How long to fail fast before letting a probe request through. */
  resetTimeoutMs: number;
  now?: () => number;
}

/**
 * Minimal circuit breaker for calls to external providers. While open, calls fail fast
 * instead of piling up behind a dependency that is already down.
 */
export class CircuitBreaker {
  private state: State = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get currentState(): State {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.resetTimeoutMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentState === 'open') {
      throw new ServiceUnavailableError('CIRCUIT_OPEN', `${this.opts.name} is temporarily unavailable`);
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (err) {
      this.failures++;
      if (this.state === 'half_open' || this.failures >= this.opts.failureThreshold) {
        this.state = 'open';
        this.openedAt = this.now();
      }
      throw err;
    }
  }
}
