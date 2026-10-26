import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, retry } from '../../src/lib/retry';
import { CircuitBreaker } from '../../src/lib/circuit-breaker';
import { ServiceUnavailableError } from '../../src/lib/errors';

describe('backoffDelay (full jitter)', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffDelay(0, 100, 10_000, () => 0.999)).toBe(99);
    expect(backoffDelay(3, 100, 10_000, () => 0.999)).toBe(799);
    expect(backoffDelay(20, 100, 1_000, () => 0.999)).toBe(999);
  });

  it('can return zero (jitter spreads retries across the whole window)', () => {
    expect(backoffDelay(5, 100, 10_000, () => 0)).toBe(0);
  });
});

describe('retry', () => {
  const noSleep = () => Promise.resolve();

  it('retries until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('ok');
    await expect(retry(fn, { retries: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry budget', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(retry(fn, { retries: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep })).rejects.toThrow(
      'down',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('declined'));
    await expect(
      retry(fn, { retries: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep, shouldRetry: () => false }),
    ).rejects.toThrow('declined');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry with its delay', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(1);
    await retry(fn, {
      retries: 1,
      baseDelayMs: 100,
      maxDelayMs: 100,
      sleep: noSleep,
      random: () => 0.5,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 50);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold and fails fast', async () => {
    let now = 0;
    const cb = new CircuitBreaker({ name: 'psp', failureThreshold: 2, resetTimeoutMs: 1000, now: () => now });
    const failing = () => Promise.reject(new Error('boom'));
    await expect(cb.exec(failing)).rejects.toThrow('boom');
    await expect(cb.exec(failing)).rejects.toThrow('boom');
    expect(cb.currentState).toBe('open');

    const probe = vi.fn().mockResolvedValue('ok');
    await expect(cb.exec(probe)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(probe).not.toHaveBeenCalled();

    now = 1000;
    expect(cb.currentState).toBe('half_open');
    await expect(cb.exec(probe)).resolves.toBe('ok');
    expect(cb.currentState).toBe('closed');
  });

  it('re-opens immediately when the half-open probe fails', async () => {
    let now = 0;
    const cb = new CircuitBreaker({ name: 'psp', failureThreshold: 1, resetTimeoutMs: 10, now: () => now });
    await expect(cb.exec(() => Promise.reject(new Error('x')))).rejects.toThrow();
    now = 10;
    await expect(cb.exec(() => Promise.reject(new Error('y')))).rejects.toThrow('y');
    expect(cb.currentState).toBe('open');
  });
});
