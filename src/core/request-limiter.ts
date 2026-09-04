/**
 * Per-client request limiting for the public addon routes.
 *
 * `/{secret}/play/:accountId/:fileId` is the one endpoint that must stay
 * unauthenticated — Stremio's player follows it directly and cannot send a
 * basic-auth header. It is also the most expensive and most sensitive route in
 * the app: each call mints a fresh Seedr CDN URL for a real file.
 *
 * That combination is enumerable. Account ids are `acc1..accN` and Seedr file
 * ids are dense integers, so anyone holding the manifest URL could walk the
 * whole library by iterating the path — and each attempt costs us a Seedr API
 * call against that account's rate budget. This limiter makes that walk
 * uneconomic without getting in the way of real playback: a household starting
 * films hits this a handful of times an hour, not dozens of times a minute.
 *
 * It is a token bucket rather than a fixed window. A fixed window lets a
 * client spend its whole budget in the last millisecond of one window and
 * again in the first of the next, which is double the intended burst at the
 * exact moment it matters. The bucket refills continuously, so the long-run
 * rate is the configured one and a short burst is still allowed.
 *
 * Memory is bounded deliberately. An unauthenticated endpoint keyed by client
 * address is a memory-exhaustion vector — an attacker rotating addresses would
 * otherwise grow the map without limit. The bucket count is capped and the
 * stalest entries are dropped when it fills, which is safe because a dropped
 * entry means a full bucket for that client next time: we lose enforcement
 * precision at the edges, never correctness of the process.
 */

/** Requests per window allowed for one client on the playback route. */
const DEFAULT_LIMIT = 30;

/** Window the limit refills over. */
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Largest number of tracked clients.
 *
 * At ~40 bytes per entry this caps the limiter at well under a megabyte, which
 * matters on the 256 MB container.
 */
const DEFAULT_MAX_KEYS = 10_000;

interface Bucket {
  /** Tokens remaining, fractional between refills. */
  tokens: number;
  /** Unix ms of the last refill, also used as the eviction clock. */
  updatedAt: number;
}

export interface LimitDecision {
  allowed: boolean;
  /** Whole seconds a rejected caller should wait, for the Retry-After header. */
  retryAfterSeconds: number;
  /** Tokens left after this decision, floored. Useful for a debug header. */
  remaining: number;
}

export class RequestLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  /** Tokens added per millisecond. */
  readonly #refillPerMs: number;
  #buckets = new Map<string, Bucket>();
  /** Requests rejected since start, surfaced to the admin for visibility. */
  #rejected = 0;

  constructor(options: { limit?: number; windowMs?: number; maxKeys?: number } = {}) {
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#refillPerMs = this.#limit / this.#windowMs;
  }

  /** Total rejections since start. */
  get rejectedCount(): number {
    return this.#rejected;
  }

  /** Number of clients currently tracked. */
  get trackedCount(): number {
    return this.#buckets.size;
  }

  /**
   * Spends one token for `key`, or refuses.
   *
   * A brand-new key starts with a full bucket, so a first request is never
   * delayed — including after an eviction.
   */
  check(key: string, now = Date.now()): LimitDecision {
    const existing = this.#buckets.get(key);
    let tokens: number;

    if (existing === undefined) {
      this.#evictIfFull(now);
      tokens = this.#limit;
    } else {
      const elapsed = Math.max(0, now - existing.updatedAt);
      tokens = Math.min(this.#limit, existing.tokens + elapsed * this.#refillPerMs);
    }

    if (tokens < 1) {
      // Re-insert so the entry keeps its place as recently seen; a client that
      // keeps hammering must not be evicted and handed a fresh bucket.
      this.#buckets.delete(key);
      this.#buckets.set(key, { tokens, updatedAt: now });
      this.#rejected += 1;
      return {
        allowed: false,
        // Round up: reporting 0 would invite an immediate retry that also fails.
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.#refillPerMs / 1000)),
        remaining: 0,
      };
    }

    const left = tokens - 1;
    this.#buckets.delete(key);
    this.#buckets.set(key, { tokens: left, updatedAt: now });
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(left) };
  }

  /**
   * Makes room for one new key.
   *
   * Fully-refilled buckets go first: they are indistinguishable from a client
   * we have never seen, so dropping them costs nothing at all. Only if none
   * are idle does this fall back to the least recently seen, which `Map`
   * insertion order gives us for free because `check` re-inserts on every hit.
   */
  #evictIfFull(now: number): void {
    if (this.#buckets.size < this.#maxKeys) return;

    for (const [key, bucket] of this.#buckets) {
      const elapsed = now - bucket.updatedAt;
      if (bucket.tokens + elapsed * this.#refillPerMs >= this.#limit) {
        this.#buckets.delete(key);
        return;
      }
    }

    const oldest = this.#buckets.keys().next();
    if (!oldest.done) this.#buckets.delete(oldest.value);
  }

  /** Clears all state. Test seam. */
  reset(): void {
    this.#buckets.clear();
    this.#rejected = 0;
  }
}

/**
 * Header carrying the TCP peer address, written by the HTTP server.
 *
 * Any value a client sends under this name is overwritten before routing, so
 * it cannot be spoofed from outside.
 */
export const PEER_ADDRESS_HEADER = 'x-seedrpool-peer';

/**
 * Best available identifier for the client behind a request.
 *
 * Order matters and each step is a deliberate trust decision:
 *
 *   1. `X-Real-IP`, which our own Caddy sets from `{remote_host}` — its view
 *      of the TCP peer, which a client cannot influence.
 *   2. The **first** entry of `X-Forwarded-For`. Caddy appends, so the first
 *      entry is the original client.
 *   3. The peer address the HTTP server recorded.
 *
 * A client that reaches the container directly could forge (1) and (2), which
 * is why the compose file publishes no port and Caddy is the only ingress. The
 * fallback exists so the limiter still functions if that ever changes.
 */
export function clientKey(request: Request): string {
  const realIp = request.headers.get('x-real-ip');
  if (realIp !== null && realIp.trim() !== '') return realIp.trim();

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }

  const peer = request.headers.get(PEER_ADDRESS_HEADER);
  if (peer !== null && peer.trim() !== '') return peer.trim();

  // One shared bucket is the safe default: it limits rather than exempts.
  return 'unknown';
}

/** The 429 a rejected caller receives. */
export function tooManyRequests(decision: LimitDecision): Response {
  return new Response('too many requests', {
    status: 429,
    headers: {
      'Retry-After': String(decision.retryAfterSeconds),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Process-wide limiter for the playback route.
 *
 * Shared so every worker path sees the same buckets. Sized for a household:
 * 30 starts a minute is far more than real viewing produces, and far less than
 * an enumeration sweep needs.
 */
export const playbackLimiter = new RequestLimiter();
