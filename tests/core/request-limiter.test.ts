import { describe, it, expect } from 'vitest';
import {
  RequestLimiter,
  clientKey,
  tooManyRequests,
  PEER_ADDRESS_HEADER,
} from '../../src/core/request-limiter.ts';

/**
 * The playback route is the only unauthenticated endpoint that mints a real
 * Seedr CDN URL, and its path is enumerable (`accN` plus a dense file id). The
 * limiter is what makes walking the library uneconomic, so its edges matter:
 * a household must never be throttled, and a sweep must always be.
 */
describe('RequestLimiter', () => {
  it('allows a burst up to the limit, then refuses', () => {
    const limiter = new RequestLimiter({ limit: 3, windowMs: 60_000 });
    const at = 1_000_000;

    expect(limiter.check('a', at).allowed).toBe(true);
    expect(limiter.check('a', at).allowed).toBe(true);
    expect(limiter.check('a', at).allowed).toBe(true);
    expect(limiter.check('a', at).allowed).toBe(false);
  });

  it('starts a new client with a full bucket, so first playback is never delayed', () => {
    const limiter = new RequestLimiter({ limit: 5, windowMs: 60_000 });
    const d = limiter.check('fresh', 0);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(4);
  });

  it('keeps clients independent', () => {
    const limiter = new RequestLimiter({ limit: 1, windowMs: 60_000 });
    const at = 1_000;

    expect(limiter.check('a', at).allowed).toBe(true);
    expect(limiter.check('a', at).allowed).toBe(false);
    // One client exhausting its budget must not affect anyone else.
    expect(limiter.check('b', at).allowed).toBe(true);
  });

  it('refills continuously rather than in fixed windows', () => {
    // A fixed window lets a client spend its whole budget at the end of one
    // window and again at the start of the next — double the intended burst
    // at the moment it matters most. A bucket refills smoothly instead.
    const limiter = new RequestLimiter({ limit: 10, windowMs: 10_000 });
    const start = 500_000;
    for (let i = 0; i < 10; i += 1) expect(limiter.check('a', start).allowed).toBe(true);
    expect(limiter.check('a', start).allowed).toBe(false);

    // One tenth of the window has passed: exactly one token is back.
    expect(limiter.check('a', start + 1_000).allowed).toBe(true);
    expect(limiter.check('a', start + 1_000).allowed).toBe(false);
  });

  it('recovers the full budget after a whole window', () => {
    const limiter = new RequestLimiter({ limit: 4, windowMs: 60_000 });
    const start = 0;
    for (let i = 0; i < 4; i += 1) limiter.check('a', start);
    expect(limiter.check('a', start).allowed).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      expect(limiter.check('a', start + 60_000).allowed).toBe(true);
    }
  });

  it('never refills past the limit, however long a client idles', () => {
    const limiter = new RequestLimiter({ limit: 3, windowMs: 1_000 });
    limiter.check('a', 0);
    // A week later the bucket is full, not overflowing.
    const far = 7 * 24 * 3600 * 1000;
    for (let i = 0; i < 3; i += 1) expect(limiter.check('a', far).allowed).toBe(true);
    expect(limiter.check('a', far).allowed).toBe(false);
  });

  it('reports a Retry-After of at least one second', () => {
    // Reporting 0 would invite an immediate retry that also fails.
    const limiter = new RequestLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('a', 0);
    const d = limiter.check('a', 0);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('reports a Retry-After that actually covers the wait', () => {
    const limiter = new RequestLimiter({ limit: 2, windowMs: 10_000 });
    limiter.check('a', 0);
    limiter.check('a', 0);
    const d = limiter.check('a', 0);
    expect(d.allowed).toBe(false);
    // Waiting the advertised time must be enough to get a token.
    expect(limiter.check('a', d.retryAfterSeconds * 1000).allowed).toBe(true);
  });

  it('reports remaining as 0 when refusing, never negative', () => {
    const limiter = new RequestLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('a', 0);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check('a', 0).remaining).toBe(0);
    }
  });

  it('counts rejections for operator visibility', () => {
    const limiter = new RequestLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('a', 0);
    limiter.check('a', 0);
    limiter.check('a', 0);
    expect(limiter.rejectedCount).toBe(2);
  });

  it('bounds memory, since the endpoint is unauthenticated', () => {
    // An attacker rotating source addresses would otherwise grow the map
    // without limit on a 256 MB container.
    const limiter = new RequestLimiter({ limit: 5, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 500; i += 1) limiter.check(`client-${i}`, i);
    expect(limiter.trackedCount).toBeLessThanOrEqual(10);
  });

  it('does not reward a hammering client with a fresh bucket when evicting', () => {
    // The eviction must not become a way to bypass the limit: a client that
    // keeps trying stays tracked and stays refused.
    const limiter = new RequestLimiter({ limit: 2, windowMs: 600_000, maxKeys: 4 });
    const at = 1_000;
    limiter.check('attacker', at);
    limiter.check('attacker', at);
    expect(limiter.check('attacker', at).allowed).toBe(false);

    // Churn well past maxKeys, interleaving the attacker so it stays recent.
    for (let i = 0; i < 50; i += 1) {
      limiter.check(`noise-${i}`, at);
      expect(limiter.check('attacker', at).allowed).toBe(false);
    }
  });

  it('prefers evicting idle clients over active ones', () => {
    const limiter = new RequestLimiter({ limit: 2, windowMs: 1_000, maxKeys: 3 });
    // `idle` used a token long ago, so its bucket has since refilled and is
    // indistinguishable from a client we have never seen: free to drop.
    limiter.check('idle', 0);
    limiter.check('active', 100_000);
    limiter.check('active', 100_000);
    // Adding a third and fourth key forces eviction.
    limiter.check('new1', 100_000);
    limiter.check('new2', 100_000);

    // `active` is still limited, meaning it survived.
    expect(limiter.check('active', 100_000).allowed).toBe(false);
  });

  it('clears state on reset', () => {
    const limiter = new RequestLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('a', 0);
    limiter.check('a', 0);
    limiter.reset();
    expect(limiter.trackedCount).toBe(0);
    expect(limiter.rejectedCount).toBe(0);
    expect(limiter.check('a', 0).allowed).toBe(true);
  });

  it('applies a real-world budget that passes household use but stops a sweep', () => {
    // Default is 30/min. A household starting films hits this a handful of
    // times an hour; an enumeration sweep needs hundreds per minute.
    const limiter = new RequestLimiter();
    const at = 0;
    for (let i = 0; i < 30; i += 1) expect(limiter.check('home', at).allowed).toBe(true);
    expect(limiter.check('home', at).allowed).toBe(false);
  });
});

describe('clientKey', () => {
  function req(headers: Record<string, string>): Request {
    return new Request('http://x/play', { headers });
  }

  it('prefers X-Real-IP, which our own Caddy sets from the TCP peer', () => {
    expect(clientKey(req({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('takes the first X-Forwarded-For entry, which is the original client', () => {
    // Caddy appends, so the first entry is the client and the rest are proxies.
    expect(clientKey(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' })))
      .toBe('203.0.113.9');
  });

  it('falls back to the peer address the server recorded', () => {
    expect(clientKey(req({ [PEER_ADDRESS_HEADER]: '172.18.0.5' }))).toBe('172.18.0.5');
  });

  it('prefers X-Real-IP over X-Forwarded-For and the peer', () => {
    const key = clientKey(
      req({
        'x-real-ip': '1.1.1.1',
        'x-forwarded-for': '2.2.2.2',
        [PEER_ADDRESS_HEADER]: '3.3.3.3',
      }),
    );
    expect(key).toBe('1.1.1.1');
  });

  it('ignores blank header values rather than keying on empty string', () => {
    const key = clientKey(
      req({ 'x-real-ip': '   ', 'x-forwarded-for': ' ', [PEER_ADDRESS_HEADER]: '9.9.9.9' }),
    );
    expect(key).toBe('9.9.9.9');
  });

  it('limits rather than exempts a request it cannot identify', () => {
    // One shared bucket is the safe default. Returning a unique value would
    // hand every unidentifiable request a full budget.
    expect(clientKey(req({}))).toBe('unknown');
  });

  it('groups unidentifiable requests into one bucket', () => {
    const limiter = new RequestLimiter({ limit: 2, windowMs: 60_000 });
    const anon = new Request('http://x/play');
    limiter.check(clientKey(anon), 0);
    limiter.check(clientKey(anon), 0);
    expect(limiter.check(clientKey(anon), 0).allowed).toBe(false);
  });
});

describe('tooManyRequests', () => {
  it('answers 429 with a Retry-After the client can act on', () => {
    const res = tooManyRequests({ allowed: false, retryAfterSeconds: 7, remaining: 0 });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
  });

  it('is never cached, since the limit changes by the second', () => {
    const res = tooManyRequests({ allowed: false, retryAfterSeconds: 1, remaining: 0 });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
