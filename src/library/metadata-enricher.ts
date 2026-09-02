/**
 * Background metadata enrichment.
 *
 * For every title in the index that does not yet have an IMDb id, looks up
 * the matching TMDB entry, fetches the IMDb id and the poster/background URL,
 * and writes them back to the row.
 *
 * The lookup is the slowest thing the addon does at startup, so it runs after
 * the initial scan and on a long interval. A new title (added by user)
 * waits at most one tick before it is enriched, which is fine for a small
 * personal library.
 *
 * Cinemeta does the heavy lifting for the user-facing fields (cast, director,
 * runtime, rating). What this worker adds is:
 *   1. The IMDb id itself, so Stremio can match our catalog entry to Cinemeta;
 *   2. The TMDB poster and background URLs, so the detail page has artwork
 *      even when Cinemeta has none (older or obscure titles).
 *
 * If no TMDB key is configured, the worker is a no-op.
 */

import type { LibraryStore } from './store.ts';
import { TmdbClient } from './tmdb.ts';

const ENRICH_INTERVAL_MS = 30 * 60_000;
/** Cap on lookups per tick so a backlog of unmatched titles does not hammer TMDB. */
const LOOKUPS_PER_TICK = 20;

export class MetadataEnricher {
  #store: LibraryStore;
  #tmdb: TmdbClient | null;
  #timer: NodeJS.Timeout | null = null;

  constructor(store: LibraryStore, tmdb: TmdbClient | null) {
    this.#store = store;
    this.#tmdb = tmdb;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, ENRICH_INTERVAL_MS);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Whether the background timer is running. Useful for tests. */
  get isRunning(): boolean {
    return this.#timer !== null;
  }

  /**
   * One enrichment pass. Public for tests and for the manual reindex button,
   * so a fresh title can be matched on demand.
   */
  async tick(): Promise<number> {
    if (this.#tmdb === null) return 0;
    const pending = this.#store.titlesNeedingLookup().slice(0, LOOKUPS_PER_TICK);
    let enriched = 0;

    for (const title of pending) {
      try {
        const match = await this.#tmdb.findMatch({
          name: title.name,
          year: title.year,
          kind: title.kind,
        });
        if (match === null) continue;
        this.#store.setTitleIds(title.key, {
          imdbId: match.imdbId,
          tmdbId: match.tmdbId,
        });
        this.#store.recordActivity(
          'success',
          `TMDB match: ${title.name}`,
          `${match.imdbId} (tmdb ${match.tmdbId})`,
        );
        console.log(
          `enrich: ${title.name} (${title.year ?? '—'}) → ${match.imdbId} (tmdb ${match.tmdbId})`,
        );
        enriched += 1;
      } catch (err) {
        console.warn(
          `enrich: ${title.name} failed:`,
          err instanceof Error ? err.message : err,
        );
        // One bad title must not stop the rest. The next tick retries.
      }
    }
    return enriched;
  }
}
