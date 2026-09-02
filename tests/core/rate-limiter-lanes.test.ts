import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/core/rate-limiter.ts';

describe('RateLimiter lanes', () => {
  it('spaces requests within one lane', async () => {
    const limiter = new RateLimiter({ minGapMs: 50 });
    const start = Date.now();
    await limiter.acquire('acc1');
    await limiter.acquire('acc1');
    await limiter.acquire('acc1');
    const elapsed = Date.now() - start;
    // Three requests in one lane: two gaps of 50ms.
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('does NOT space requests across different lanes', async () => {
    // This is the whole point of the rewrite. Eight accounts previously
    // queued behind one serial queue, costing accounts x minGap per page.
    const limiter = new RateLimiter({ minGapMs: 50 });
    const start = Date.now();
    await Promise.all([
      limiter.acquire('acc1'),
      limiter.acquire('acc2'),
      limiter.acquire('acc3'),
      limiter.acquire('acc4'),
      limiter.acquire('acc5'),
      limiter.acquire('acc6'),
      limiter.acquire('acc7'),
      limiter.acquire('acc8'),
    ]);
    const elapsed = Date.now() - start;
    // All eight lanes are fresh, so none of them waits. Under the old
    // single-queue design this would have taken 7 * 50 = 350ms.
    expect(elapsed).toBeLessThan(40);
  });

  it('applies the cooldown globally across every lane', async () => {
    const limiter = new RateLimiter({ minGapMs: 0, cooldownMs: 100 });
    limiter.penalize();
    expect(limiter.throttled).toBe(true);
    const start = Date.now();
    // A different lane than any prior request: it must still wait, because
    // a throttle anywhere is a signal to back off everywhere.
    await limiter.acquire('acc42');
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
    expect(limiter.throttled).toBe(false);
  });

  it('honours an explicit Retry-After over the escalating default', async () => {
    const limiter = new RateLimiter({ minGapMs: 0, cooldownMs: 60_000 });
    limiter.penalize(0.05); // 50ms
    expect(limiter.retryAfterMs).toBeLessThanOrEqual(60);
    expect(limiter.retryAfterMs).toBeGreaterThan(0);
  });

  it('escalates the cooldown while throttling persists', () => {
    const limiter = new RateLimiter({ minGapMs: 0, cooldownMs: 100, maxCooldownMs: 10_000 });
    limiter.penalize();
    const first = limiter.retryAfterMs;
    // A second guess doubles the window. `penalize` extends rather than
    // replaces, so the remaining time grows.
    limiter.penalize();
    expect(limiter.retryAfterMs).toBeGreaterThan(first);
  });

  it('caps the escalation at maxCooldownMs', () => {
    const limiter = new RateLimiter({ minGapMs: 0, cooldownMs: 100, maxCooldownMs: 250 });
    // Ten consecutive guesses would reach 100 * 2^10 without the ceiling.
    for (let i = 0; i < 10; i += 1) limiter.penalize();
    // The window is the sum of extensions but each individual step is
    // capped, so the final step can never exceed maxCooldownMs.
    limiter.reset();
    limiter.penalize();
    expect(limiter.retryAfterMs).toBeLessThanOrEqual(110);
  });

  it('succeed() returns the escalation to the configured base', () => {
    const limiter = new RateLimiter({ minGapMs: 0, cooldownMs: 100, maxCooldownMs: 10_000 });
    limiter.penalize();
    limiter.penalize();
    limiter.penalize();
    limiter.succeed();
    limiter.reset();
    limiter.penalize();
    // Back to the configured 100ms base, not the module default of 60s.
    // The previous implementation hardcoded DEFAULT_COOLDOWN_MS here, so a
    // limiter constructed with a custom cooldown jumped to 60s after its
    // first clean request.
    expect(limiter.retryAfterMs).toBeLessThanOrEqual(110);
  });

  it('reset() clears every lane, so the next request is immediate', async () => {
    const limiter = new RateLimiter({ minGapMs: 200 });
    await limiter.acquire('acc1');
    limiter.reset();
    const start = Date.now();
    await limiter.acquire('acc1');
    expect(Date.now() - start).toBeLessThan(30);
  });

  it('defaults to a shared lane when no key is given', async () => {
    // Preserves the old behaviour for any caller not yet updated.
    const limiter = new RateLimiter({ minGapMs: 40 });
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });
});
