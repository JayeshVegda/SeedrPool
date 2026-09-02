/**
 * Global rate-limit coordination for the Seedr API.
 *
 * Seedr throttles per client, not per endpoint or per account, so every caller
 * shares one budget. Without coordination each account retries independently and
 * they starve each other — which is exactly how a working account was pushed into
 * a throttled state during development (RESEARCH.md).
 *
 * Two mechanisms:
 *   - a minimum gap between requests, so bursts are smoothed;
 *   - a shared cooldown, so one 429 pauses every caller rather than each
 *     discovering the throttle separately.
 */

/** Minimum spacing between outbound API requests. */
const MIN_REQUEST_GAP_MS = 250;

/** How long to pause all callers after a throttle response. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Ceiling on escalating cooldowns from repeated throttling. */
const MAX_COOLDOWN_MS = 300_000;

export class RateLimiter {
  #minGapMs: number;
  #lastRequestAt = 0;
  /** Unix ms until which all requests must wait. */
  #cooldownUntil = 0;
  /** Current cooldown length, doubling while throttling persists. */
  #cooldownMs: number;
  #maxCooldownMs: number;
  /** Serializes gap enforcement so concurrent callers queue rather than race. */
  #queue: Promise<void> = Promise.resolve();

  constructor(
    options: { minGapMs?: number; cooldownMs?: number; maxCooldownMs?: number } = {},
  ) {
    this.#minGapMs = options.minGapMs ?? MIN_REQUEST_GAP_MS;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
  }

  /** True while a cooldown from a previous throttle is still in effect. */
  get throttled(): boolean {
    return Date.now() < this.#cooldownUntil;
  }

  /** Milliseconds until requests may resume, or 0 when clear. */
  get retryAfterMs(): number {
    return Math.max(0, this.#cooldownUntil - Date.now());
  }

  /**
   * Waits until a request may be sent.
   *
   * Callers queue behind one another so the minimum gap is honoured across all
   * accounts, not per account.
   */
  async acquire(): Promise<void> {
    const wait = this.#queue.then(async () => {
      if (this.throttled) {
        await sleep(this.retryAfterMs);
      }

      const since = Date.now() - this.#lastRequestAt;
      if (since < this.#minGapMs) {
        await sleep(this.#minGapMs - since);
      }

      this.#lastRequestAt = Date.now();
    });

    this.#queue = wait.catch(() => undefined);
    return wait;
  }

  /**
   * Records a throttle response and starts or extends the shared cooldown.
   *
   * `retryAfterSeconds` comes from a `Retry-After` header when present; Seedr
   * does not always send one, so a default applies.
   */
  penalize(retryAfterSeconds?: number): void {
    const explicit = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : null;
    const duration = explicit ?? this.#cooldownMs;

    this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + duration);

    // Escalate only when guessing; an explicit Retry-After is authoritative.
    if (explicit === null) {
      this.#cooldownMs = Math.min(this.#cooldownMs * 2, this.#maxCooldownMs);
    }
  }

  /** Resets the escalation after a clean request. */
  succeed(): void {
    this.#cooldownMs = DEFAULT_COOLDOWN_MS;
  }

  /** Clears all state. Test seam. */
  reset(): void {
    this.#cooldownUntil = 0;
    this.#cooldownMs = DEFAULT_COOLDOWN_MS;
    this.#lastRequestAt = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process-wide limiter.
 *
 * Deliberately module-level: the throttle is per Seedr client id, so one shared
 * instance is correct. A second instance would defeat the purpose.
 */
export const seedrRateLimiter = new RateLimiter();
