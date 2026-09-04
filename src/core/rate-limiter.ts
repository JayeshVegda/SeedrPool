/**
 * Rate-limit coordination for the Seedr API.
 *
 * Two facts drive the design, both measured (RESEARCH.md, and re-measured
 * 2026-09-02 against the live 8-account pool):
 *
 *   1. Throttling is enforced per account/token, not per client id. Eight
 *      accounts issuing `list_contents` simultaneously all return 200 in
 *      ~0.4s total. Eight parallel password grants likewise.
 *   2. When a throttle *does* land, it is worth pausing every caller: the
 *      original 429 came from hammering one account, and letting the other
 *      seven keep going while one is cooling down risks the same escalation.
 *
 * So the limiter is split in two:
 *
 *   - a per-account **lane** enforces the minimum request gap. Requests on
 *     different accounts never queue behind each other, which is what turns a
 *     2.4s page render into a 0.3s one;
 *   - a **shared cooldown** is global. One 429 anywhere pauses everyone, which
 *     is the property the original design got right.
 *
 * The previous version funnelled every request through a single serial queue,
 * making per-page latency `accounts × 250ms`. That is pure self-inflicted
 * latency: the gap exists to avoid bursting one account, and requests to
 * different accounts do not burst anything.
 *
 * Not to be confused with `core/request-limiter.ts`, which limits *inbound*
 * requests from clients on the public playback route. This one paces our
 * *outbound* requests to Seedr.
 */

/** Minimum spacing between outbound API requests *on the same account*. */
const MIN_REQUEST_GAP_MS = 250;

/** How long to pause all callers after a throttle response. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Ceiling on escalating cooldowns from repeated throttling. */
const MAX_COOLDOWN_MS = 300_000;

/** Serial queue plus last-send timestamp for one account. */
interface Lane {
  queue: Promise<void>;
  lastRequestAt: number;
}

export class RateLimiter {
  #minGapMs: number;
  /**
   * One lane per account key. Requests within a lane are spaced by
   * `minGapMs`; requests in different lanes run concurrently.
   */
  #lanes = new Map<string, Lane>();
  /** Unix ms until which all requests must wait. Shared across lanes. */
  #cooldownUntil = 0;
  /** Current cooldown length, doubling while throttling persists. */
  #cooldownMs: number;
  /**
   * The configured starting cooldown.
   *
   * Kept separate from `#cooldownMs` because `succeed()` and `reset()` need
   * to return to the *configured* base, not the module default. The previous
   * version hardcoded `DEFAULT_COOLDOWN_MS` in both, so a limiter built with
   * a custom cooldown silently jumped to 60 s after its first clean request.
   */
  #baseCooldownMs: number;
  #maxCooldownMs: number;

  constructor(
    options: { minGapMs?: number; cooldownMs?: number; maxCooldownMs?: number } = {},
  ) {
    this.#minGapMs = options.minGapMs ?? MIN_REQUEST_GAP_MS;
    this.#baseCooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#cooldownMs = this.#baseCooldownMs;
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
   * Waits until a request may be sent on `lane`.
   *
   * `lane` should be the account id. Callers that genuinely share a budget
   * (there are none today) can pass the same key. Omitting it puts the
   * request in a shared `default` lane, which preserves the old serial
   * behaviour for any caller that has not been updated.
   */
  async acquire(lane = 'default'): Promise<void> {
    const entry = this.#lanes.get(lane) ?? { queue: Promise.resolve(), lastRequestAt: 0 };
    this.#lanes.set(lane, entry);

    const wait = entry.queue.then(async () => {
      // The cooldown is global and re-checked inside the lane, so a throttle
      // that lands while this request is queued still delays it.
      if (this.throttled) {
        await sleep(this.retryAfterMs);
      }

      const since = Date.now() - entry.lastRequestAt;
      if (since < this.#minGapMs) {
        await sleep(this.#minGapMs - since);
      }

      entry.lastRequestAt = Date.now();
    });

    entry.queue = wait.catch(() => undefined);
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
    this.#cooldownMs = this.#baseCooldownMs;
  }

  /** Clears all state. Test seam. */
  reset(): void {
    this.#cooldownUntil = 0;
    this.#cooldownMs = this.#baseCooldownMs;
    this.#lanes.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
