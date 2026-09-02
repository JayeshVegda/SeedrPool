/**
 * Manages the set of storage accounts as one logical pool.
 *
 * Capacity is the binding constraint: each account is small (~6-7.5 GiB), so fit
 * matters when placing content.
 *
 * Concurrency is NOT account-bound. Measured on V1 (RESEARCH.md): a signed
 * `ff_get` URL serves 2 simultaneous range reads and returns HTTP 429 on the
 * third, but 12 concurrent reads across 6 freshly minted URLs on one account all
 * succeeded. Because `/play` mints a URL per playback, viewers do not contend for
 * an account. Stream counts are still tracked, as a bandwidth-fairness heuristic
 * for placement and for the admin page, not as a hard ceiling.
 *
 * The pool never throws for a single unhealthy account. An account whose
 * credentials are rejected is excluded from allocation and reported to the admin
 * page.
 */

import type { Quota, StorageProvider, Transfer } from './types.ts';

/** Live view of one account's state. */
export interface AccountStatus {
  accountId: string;
  label: string;
  healthy: boolean;
  /** Set when only fixing the credentials file can recover the account. */
  needsReauth: boolean;
  /** Null when the account is unhealthy and quota could not be read. */
  quota: Quota | null;
  /** Reason the account is unhealthy, when known. */
  reason?: string;
  /** Sustained streams currently attributed to this account. */
  activeStreams: number;
  /**
   * False when the account's CDN has been observed to 404 on freshly-minted
   * `ff_get` URLs. Until the next health probe succeeds, the pool skips
   * this account for new content. `null` when never observed.
   *
   * Separate from `healthy` because the underlying Seedr API is still
   * working (we can list folders, add magnets); only the playback CDN is
   * unreachable. The admin page surfaces this so Jay can see at a glance
   * which accounts to investigate.
   */
  cdnHealthy: boolean;
  /** Why the CDN is unhealthy, when known. */
  cdnReason?: string;
  /** Unix ms of the last CDN failure, when applicable. */
  cdnBrokenAt?: number;
}

/** Aggregate capacity across healthy accounts. */
export interface PoolCapacity {
  used: number;
  max: number;
  free: number;
  healthyAccounts: number;
  totalAccounts: number;
}

/** An allocation decision, with the reasoning kept for the admin page. */
export interface Allocation {
  provider: StorageProvider;
  accountId: string;
  /** Human-readable justification, e.g. "most free space (4.24 GiB), 0 streams". */
  reason: string;
}

/** Raised when no healthy account can hold the requested bytes. */
export class NoCapacityError extends Error {
  readonly requiredBytes: number;
  readonly largestFree: number;

  constructor(requiredBytes: number, largestFree: number) {
    super(
      `no account can hold ${requiredBytes} bytes; largest free is ${largestFree} bytes`,
    );
    this.name = 'NoCapacityError';
    this.requiredBytes = requiredBytes;
    this.largestFree = largestFree;
  }
}

/**
 * Streams per account above which placement prefers a quieter account.
 *
 * A fairness heuristic, not a hard limit: measured concurrency is per signed URL
 * (2 reads, then 429), not per account, and every playback mints its own URL. The
 * value spreads bandwidth rather than preventing throttling.
 */
export const STREAM_LIMIT_PER_ACCOUNT = 3;

/**
 * Simultaneous range reads one signed `ff_get` URL will serve before HTTP 429.
 *
 * Measured: 2 reads on one URL succeed, a 3rd returns 429; 12 reads spread over
 * 6 URLs from the same account all succeed. A client that opens more than this
 * many parallel connections to a single URL needs a freshly minted one.
 */
export const READS_PER_SIGNED_URL = 2;

/**
 * How long cached account status stays usable.
 *
 * Probing costs one API request per account against a per-client throttle, so
 * page renders reuse cached status rather than re-probing.
 */
export const STATUS_TTL_MS = 60_000;

export interface AccountPoolEntry {
  provider: StorageProvider;
  label: string;
  needsReauth: boolean;
}

/**
 * How long an account is excluded from placement after a CDN failure.
 *
 * Long enough that we don't keep routing new content to a broken host;
 * short enough that an external fix (Seedr fixes their CDN) eventually
 * clears the mark without a restart.
 */
export const CDN_QUARANTINE_MS = 30 * 60_000;

export class AccountPool {
  #entries: AccountPoolEntry[];
  /** Cached health and quota, refreshed by `refresh()`. */
  #status = new Map<string, AccountStatus>();
  /** In-flight stream counts, keyed by account id. */
  #streams = new Map<string, number>();
  /** Unix ms of the last completed probe, for TTL checks. */
  #lastRefreshAt = 0;
  /** Collapses concurrent probes into one. */
  #refreshInFlight: Promise<void> | null = null;

  constructor(entries: AccountPoolEntry[]) {
    this.#entries = entries;
    for (const entry of entries) {
      this.#status.set(entry.provider.accountId, {
        accountId: entry.provider.accountId,
        label: entry.label,
        // Unknown until refreshed; assumed unhealthy so nothing is allocated to
        // an account that has never answered.
        healthy: false,
        needsReauth: entry.needsReauth,
        quota: null,
        reason: 'not yet checked',
        activeStreams: 0,
        cdnHealthy: true,
      });
    }
  }

  /**
   * Probes every account and caches the result.
   *
   * Results are cached for `staleAfterMs`, because probing costs API requests
   * against a per-client throttle. Rendering a page must never force a probe of
   * every account — doing so on an auto-refreshing page is what previously
   * throttled a healthy account into failure.
   */
  async refresh(options: { force?: boolean; staleAfterMs?: number } = {}): Promise<AccountStatus[]> {
    const staleAfterMs = options.staleAfterMs ?? STATUS_TTL_MS;
    const fresh = Date.now() - this.#lastRefreshAt < staleAfterMs;

    if (!options.force && fresh && this.#lastRefreshAt > 0) {
      return this.statuses();
    }

    // Collapse concurrent refreshes so several page loads cost one probe.
    this.#refreshInFlight ??= this.#doRefresh().finally(() => {
      this.#refreshInFlight = null;
    });
    await this.#refreshInFlight;

    return this.statuses();
  }

  async #doRefresh(): Promise<void> {
    await Promise.all(
      this.#entries.map(async (entry) => {
        const accountId = entry.provider.accountId;
        const previous = this.#status.get(accountId);

        if (entry.needsReauth) {
          this.#status.set(accountId, {
            accountId,
            label: entry.label,
            healthy: false,
            needsReauth: true,
            quota: null,
            reason: 'needs re-authorization',
            activeStreams: this.#streams.get(accountId) ?? 0,
            cdnHealthy: previous?.cdnHealthy ?? true,
            ...(previous?.cdnReason !== undefined ? { cdnReason: previous.cdnReason } : {}),
            ...(previous?.cdnBrokenAt !== undefined ? { cdnBrokenAt: previous.cdnBrokenAt } : {}),
          });
          return;
        }

        try {
          const quota = await entry.provider.getQuota();
          this.#status.set(accountId, {
            accountId,
            label: entry.label,
            healthy: true,
            needsReauth: false,
            quota,
            activeStreams: this.#streams.get(accountId) ?? 0,
            cdnHealthy: previous?.cdnHealthy ?? true,
            ...(previous?.cdnReason !== undefined ? { cdnReason: previous.cdnReason } : {}),
            ...(previous?.cdnBrokenAt !== undefined ? { cdnBrokenAt: previous.cdnBrokenAt } : {}),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const name = err instanceof Error ? err.name : '';
          const previous2 = this.#status.get(accountId);

          this.#status.set(accountId, {
            accountId,
            label: entry.label,
            healthy: false,
            // A rejected password (V1) or revoked token chain (V2) needs a human.
            // Throttling says nothing about credentials, so it must not qualify.
            needsReauth: name === 'ReauthRequiredError' || name === 'InvalidCredentialsError',
            // Keep the last known quota through a transient failure, so the UI
            // shows stale numbers rather than blanking out.
            quota: name === 'RateLimitError' ? (previous2?.quota ?? null) : null,
            reason:
              name === 'RateLimitError'
                ? `rate limited by Seedr — retrying automatically (${reason})`
                : reason,
            activeStreams: this.#streams.get(accountId) ?? 0,
            cdnHealthy: previous2?.cdnHealthy ?? true,
            ...(previous2?.cdnReason !== undefined ? { cdnReason: previous2.cdnReason } : {}),
            ...(previous2?.cdnBrokenAt !== undefined ? { cdnBrokenAt: previous2.cdnBrokenAt } : {}),
          });
        }
      }),
    );

    this.#lastRefreshAt = Date.now();
  }

  /** Cached status for every account, in id order. */
  statuses(): AccountStatus[] {
    const now = Date.now();
    return [...this.#status.values()]
      .map((s) => {
        // Auto-clear a CDN failure once the quarantine window has elapsed.
        // The next `play` against this account will set it again if Seedr
        // is still broken, so the loop is bounded.
        const cdnExpired =
          s.cdnHealthy === false &&
          s.cdnBrokenAt !== undefined &&
          now - s.cdnBrokenAt > CDN_QUARANTINE_MS;
        const result: AccountStatus = {
          ...s,
          cdnHealthy: cdnExpired ? true : s.cdnHealthy,
          activeStreams: this.#streams.get(s.accountId) ?? 0,
        };
        if (cdnExpired) {
          delete result.cdnReason;
          delete result.cdnBrokenAt;
        }
        return result;
      })
      .sort((a, b) => a.accountId.localeCompare(b.accountId));
  }

  /** Aggregate capacity across healthy accounts only. */
  capacity(): PoolCapacity {
    let used = 0;
    let max = 0;
    let healthyAccounts = 0;

    for (const status of this.#status.values()) {
      if (!status.healthy || !status.quota) continue;
      used += status.quota.used;
      max += status.quota.max;
      healthyAccounts += 1;
    }

    return {
      used,
      max,
      free: Math.max(0, max - used),
      healthyAccounts,
      totalAccounts: this.#entries.length,
    };
  }

  /** Providers for accounts currently believed healthy. */
  healthyProviders(): StorageProvider[] {
    return this.#entries
      .filter((e) => this.#status.get(e.provider.accountId)?.healthy === true)
      .map((e) => e.provider);
  }

  provider(accountId: string): StorageProvider | undefined {
    return this.#entries.find((e) => e.provider.accountId === accountId)?.provider;
  }

  /**
   * Chooses where to place `requiredBytes` of new content.
   *
   * Prefers accounts that can hold the content and are not already busy serving
   * streams, then the account with the most free space. Busy accounts are still
   * used when no quieter account has room: throttling is per signed URL rather
   * than per account, so a busy account is a bandwidth-fairness concern, whereas
   * refusing the download fails outright.
   */
  allocate(requiredBytes: number): Allocation {
    const candidates = this.statuses().filter(
      (s) =>
        s.healthy && s.cdnHealthy && s.quota !== null && s.quota.free >= requiredBytes,
    );

    if (candidates.length === 0) {
      const largestFree = Math.max(
        0,
        ...this.statuses().map(
          (s) => (s.healthy && s.cdnHealthy && s.quota ? s.quota.free : 0),
        ),
      );
      throw new NoCapacityError(requiredBytes, largestFree);
    }

    // Quieter accounts first, so viewers' bandwidth is spread out.
    const idle = candidates.filter((s) => s.activeStreams < STREAM_LIMIT_PER_ACCOUNT);
    const pool = idle.length > 0 ? idle : candidates;

    const best = pool.reduce((a, b) => {
      if (a.activeStreams !== b.activeStreams) {
        return a.activeStreams < b.activeStreams ? a : b;
      }
      // Deliberately most-free rather than tightest-fit: these accounts are
      // small enough that leaving headroom matters more than packing densely.
      return (a.quota?.free ?? 0) >= (b.quota?.free ?? 0) ? a : b;
    });

    const provider = this.provider(best.accountId);
    if (!provider) throw new Error(`no provider for account ${best.accountId}`);

    const freeGib = ((best.quota?.free ?? 0) / 1024 ** 3).toFixed(2);
    const saturated = idle.length === 0 ? ', all accounts busy' : '';
    return {
      provider,
      accountId: best.accountId,
      reason: `most free space (${freeGib} GiB), ${best.activeStreams} active stream(s)${saturated}`,
    };
  }

  /**
   * Registers a stream against an account and returns a release function.
   *
   * Counts inform placement so that new content lands away from accounts
   * currently serving viewers.
   */
  acquireStream(accountId: string): () => void {
    this.#streams.set(accountId, (this.#streams.get(accountId) ?? 0) + 1);
    let released = false;
    return () => {
      // Guard against double-release, which would understate load.
      if (released) return;
      released = true;
      const next = (this.#streams.get(accountId) ?? 1) - 1;
      this.#streams.set(accountId, Math.max(0, next));
    };
  }

  activeStreams(accountId: string): number {
    return this.#streams.get(accountId) ?? 0;
  }

  /** True when the account is carrying more than its share of streams. */
  isSaturated(accountId: string): boolean {
    return this.activeStreams(accountId) >= STREAM_LIMIT_PER_ACCOUNT;
  }

  /**
   * Flags an account's CDN as broken. The pool stops allocating to it for
   * `CDN_QUARANTINE_MS`; existing files on the account still play via
   * the HLS fallback the V1 provider discovered, so the user is not
   * stranded.
   *
   * `at` is for tests that need to simulate a long-ago failure. Production
   * callers leave it unset.
   */
  markCdnBroken(accountId: string, reason: string, at: number = Date.now()): void {
    const current = this.#status.get(accountId);
    if (current === undefined) return;
    this.#status.set(accountId, {
      ...current,
      cdnHealthy: false,
      cdnReason: reason,
      cdnBrokenAt: at,
    });
  }

  markCdnHealthy(accountId: string): void {
    const current = this.#status.get(accountId);
    if (current === undefined) return;
    const next: AccountStatus = { ...current, cdnHealthy: true };
    delete next.cdnReason;
    delete next.cdnBrokenAt;
    this.#status.set(accountId, next);
  }

  /** Transfers across all healthy accounts, tagged with their account. */
  async listAllTransfers(): Promise<Array<Transfer & { accountId: string }>> {
    const results = await Promise.all(
      this.healthyProviders().map(async (provider) => {
        try {
          const transfers = await provider.listTransfers();
          return transfers.map((t) => ({ ...t, accountId: provider.accountId }));
        } catch {
          // One unreachable account must not hide the others' transfers.
          return [];
        }
      }),
    );
    return results.flat();
  }
}

/**
 * True when a transfer is almost certainly a dead magnet.
 *
 * Seedr reports magnets with no available peers as indefinitely running with
 * zero progress rather than failing them, so this is the only available signal.
 */
export function isDeadTransfer(transfer: Transfer, ageSeconds: number): boolean {
  return (
    transfer.state === 'running' &&
    transfer.progress === 0 &&
    transfer.seeders === 0 &&
    ageSeconds > 120
  );
}
