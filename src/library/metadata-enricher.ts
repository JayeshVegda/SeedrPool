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
import { ENRICH_MAX_ATTEMPTS } from './store.ts';

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
   * Whether lookups can happen at all, i.e. a TMDB key is configured.
   * The health report surfaces this: without a key, new titles never get
   * an IMDb id and stay invisible to Stremio, which looks like a bug in
   * the addon if nobody says why.
   */
  get enabled(): boolean {
    return this.#tmdb !== null && this.#tmdb.enabled;
  }

  /**
   * One enrichment pass. Public for tests and for the manual reindex button,
   * so a fresh title can be matched on demand.
   *
   * A title whose lookup ends with no match gets `recordEnrichFailure`. After
   * `ENRICH_MAX_ATTEMPTS` it stops appearing in `titlesNeedingLookup` and this
   * loop never touches it again — previously a title TMDB could never match
   * was re-queried every 30 minutes forever, which burned quota, filled the
   * log, and produced no result. The operator's recovery path is the admin's
   * "re-fetch" button, which resets the counter.
   */
  async tick(): Promise<number> {
    if (this.#tmdb === null) return 0;
    const pending = this.#store.titlesNeedingLookup().slice(0, LOOKUPS_PER_TICK);
    let enriched = 0;
    let gaveUp = 0;
    /** Titles that crossed ENRICH_MAX_ATTEMPTS this tick, for one log line. */
    const crossedLine: string[] = [];

    for (const title of pending) {
      try {
        const match = await this.#tmdb.findMatch({
          name: title.name,
          year: title.year,
          kind: title.kind,
        });

        if (match === null) {
          const attempts = this.#store.recordEnrichFailure(title.key);
          if (attempts >= ENRICH_MAX_ATTEMPTS) crossedLine.push(title.name);
          gaveUp += 1;
          continue;
        }

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
        // A transport or quota error says nothing about whether the title
        // can match, so it must not consume one of the attempts. A 429 from
        // TMDB during a burst would otherwise permanently give up on three
        // titles that were never actually looked at.
        console.warn(
          `enrich: ${title.name} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // One activity entry per title that crossed the line, not one per tick
    // forever after — the whole point of the cap is silence.
    for (const name of crossedLine) {
      this.#store.recordActivity(
        'warn',
        `Metadata lookup gave up: ${name}`,
        `${ENRICH_MAX_ATTEMPTS} attempts, no TMDB match. Use "re-fetch" on the library row to retry.`,
      );
    }
    if (gaveUp > 0) {
      console.warn(
        `enrich: ${gaveUp} title${gaveUp === 1 ? '' : 's'} unmatched this tick` +
          (crossedLine.length > 0 ? `, ${crossedLine.length} permanently` : ''),
      );
    }
    return enriched;
  }
}
