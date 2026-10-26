export interface RetryOptions {
  /** Attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Return false to stop retrying (e.g. 4xx from a provider). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Full jitter" exponential backoff (AWS Architecture Blog): delay = random(0, min(cap, base * 2^n)).
 * Spreads retries from many clients so a recovering dependency is not hit by a synchronized wave.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt < opts.retries && (opts.shouldRetry?.(err, attempt) ?? true);
      if (!canRetry) throw err;
      const delay = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.random);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
