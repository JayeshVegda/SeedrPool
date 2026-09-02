/**
 * Background poller that notices when a torrent finishes downloading and triggers
 * a reindex of the account that holds it.
 *
 * Why: Seedr V1 has no completion event. An in-progress torrent sits in the
 * root listing's `torrents[]`; once it finishes, it disappears from there and a
 * new folder appears. The library would otherwise wait for the operator to
 * click "Reindex now" before the new content became browsable in Stremio.
 *
 * Strategy: remember the set of active transfer ids per account, and on each
 * tick compare against the freshly-fetched set. Anything that has vanished is
 * treated as "finished since the last poll", and the account's indexer pass
 * runs. Polling is the only way to do this with V1: a push mechanism would
 * require a Seedr webhook, and there is no public one.
 *
 * The poll interval is conservative (30 s). Seedr rate-limits on a 250 ms
 * minimum gap per account, and eight accounts polled in sequence complete in
 * well under the cooldown window, so the cost is dominated by the wait, not
 * the requests.
 *
 * When a completion is detected, the optional `onCompletion` hook is called
 * after the per-account reindex resolves. The enricher is wired in here so a
 * finished torrent is matched against TMDB and gains an IMDb id within
 * seconds, not the next 30-minute enricher tick.
 */

import type { AccountPool } from './account-pool.ts';
import type { Indexer } from '../library/indexer.ts';
import type { MetadataEnricher } from '../library/metadata-enricher.ts';

const POLL_INTERVAL_MS = 30_000;
/** Skip an account for this long after a poll error to avoid hammering it. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

interface AccountState {
  /** Active transfer ids seen in the previous poll. */
  activeIds: Set<string>;
  /** Unix ms of the next allowed poll for this account. */
  nextAllowedAt: number;
}

export class TransferWatcher {
  #pool: () => AccountPool;
  #indexer: Indexer;
  /** Optional callback fired after a per-account reindex triggered by a completion. */
  #onCompletion:
    | ((accountId: string, finishedTransferIds: string[]) => Promise<void>)
    | null = null;
  #state = new Map<string, AccountState>();
  #timer: NodeJS.Timeout | null = null;

  constructor(pool: () => AccountPool, indexer: Indexer) {
    this.#pool = pool;
    this.#indexer = indexer;
  }

  /**
   * Attaches a hook to fire after each account reindex triggered by a
   * completion. The enricher is the only caller today; its `tick()` looks
   * up any title still missing an IMDb id and writes the result back.
   *
   * Pass `null` to detach.
   */
  setOnCompletion(
    hook:
      | ((enricher: MetadataEnricher, accountId: string, finished: string[]) => Promise<void>)
      | null,
    enricher: MetadataEnricher | null,
  ): void {
    if (hook === null || enricher === null) {
      this.#onCompletion = null;
      return;
    }
    this.#onCompletion = async (accountId, finished) => hook(enricher, accountId, finished);
  }

  /** Begins polling. Safe to call multiple times; subsequent calls are no-ops. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    // `unref` so a running watcher does not prevent process exit.
    this.#timer.unref();
    // First tick fires after one interval, but a one-off kick gives faster
    // feedback when the server boots.
    void this.tick();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** True while at least one transfer is being tracked. */
  get tracking(): boolean {
    for (const state of this.#state.values()) {
      if (state.activeIds.size > 0) return true;
    }
    return false;
  }

  /** Forces a tick to run now. Used by tests. */
  async tick(): Promise<void> {
    const now = Date.now();
    const pool = this.#pool();
    // Probe every account; the rate limiter on the V1 client serializes the
    // actual API requests so this loop is just deciding who to ask.
    for (const provider of pool.healthyProviders()) {
      const accountId = provider.accountId;
      const state = this.#state.get(accountId) ?? {
        activeIds: new Set(),
        nextAllowedAt: 0,
      };

      if (now < state.nextAllowedAt) continue;

      let active: Set<string>;
      try {
        const transfers = await provider.listTransfers();
        active = new Set(transfers.map((t) => t.id));
      } catch {
        // Back off the failing account. Other accounts still get polled.
        state.nextAllowedAt = now + FAILURE_BACKOFF_MS;
        this.#state.set(accountId, state);
        continue;
      }

      // An id that was active on the previous poll but missing on this one has
      // completed: Seedr's V1 deletes finished torrents from `torrents[]` and
      // turns them into folders. Anything new in `active` is just starting.
      const finished: string[] = [];
      for (const id of state.activeIds) {
        if (!active.has(id)) finished.push(id);
      }
      state.activeIds = active;
      state.nextAllowedAt = 0;
      this.#state.set(accountId, state);

      if (finished.length === 0) continue;

      // Reindex just this account, then fire the completion hook so a fresh
      // title gets an IMDb id straight away. The hook is fire-and-forget so
      // a slow TMDB response never blocks the next poll.
      const finishedIds = finished.slice();
      void this.#indexer
        .scanAccount(provider)
        .then(() => this.#onCompletion?.(accountId, finishedIds));
    }
  }
}
