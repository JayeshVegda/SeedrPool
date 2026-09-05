/**
 * Scans every account and writes what it finds into the library index.
 *
 * Seedr's folder structure mirrors the torrent, so the scan walks the root then
 * one level into each folder. Deeper nesting is rare in release torrents and each
 * extra level costs one API request per folder against a rate-limited API, so the
 * walk is depth-limited rather than unbounded.
 *
 * A scan is idempotent: rows are upserted by (account, file id) and anything not
 * seen in the current pass is pruned, so files deleted on Seedr disappear from the
 * index.
 */

import type { AccountPool } from '../core/account-pool.ts';
import type { RemoteFile, StorageProvider } from '../core/types.ts';
import { LibraryStore } from './store.ts';
import { mediaKey, parseMediaName } from './parse.ts';

/** How deep to walk below an account's root. */
const MAX_DEPTH = 3;

const SUBTITLE_EXTENSIONS = /\.(srt|vtt|ass|ssa|sub)$/i;

/** Outcome of one scan, for logging and the admin page. */
export interface ScanResult {
  accountId: string;
  videos: number;
  subtitles: number;
  /** Rows removed because the files no longer exist on Seedr. */
  pruned: number;
  /** Set when the account could not be scanned; other accounts still proceed. */
  error?: string;
}

export class Indexer {
  #store: LibraryStore;
  #pool: () => AccountPool;
  /** Prevents two scans racing, which would prune each other's rows. */
  #scanInFlight: Promise<ScanResult[]> | null = null;
  #lastScanAt = 0;
  /**
   * Strictly monotonic stamp used as the `seenAt` watermark per scan. Using
   * `Date.now()` alone is insufficient: two scans in the same millisecond
   * would share a watermark, and the second's prune would then leave the
   * first's rows behind. We keep the time base so production behaviour
   * matches wall-clock seconds, and just guarantee it never repeats.
   */
  #scanSeq = 0;
  /**
   * Per-account scan chains so two concurrent scanAccount() calls on the
   * same account can't interleave. Different accounts run in parallel.
   */
  #scanLocks = new Map<string, Promise<unknown>>();
  /**
   * Optional enricher tick fired at the end of a scan if any new title was
   * inserted without an IMDb id. Wired in `index.ts`. Cached as a method
   * so the indexer can stay independent of the MetadataEnricher class
   * (which avoids a circular import in tests).
   */
  #onScanComplete: (() => Promise<void>) | null = null;

  constructor(store: LibraryStore, pool: () => AccountPool) {
    this.#store = store;
    this.#pool = pool;
  }

  /**
   * Register a callback to fire after a scan that inserted at least one new
   * title without an IMDb id. The callback is expected to run the metadata
   * enricher; we only call it when there's actual work to do.
   */
  setOnScanComplete(hook: (() => Promise<void>) | null): void {
    this.#onScanComplete = hook;
  }

  get lastScanAt(): number {
    return this.#lastScanAt;
  }

  get scanning(): boolean {
    return this.#scanInFlight !== null;
  }

  /** Scans every healthy account. Concurrent callers share one scan. */
  scanAll(): Promise<ScanResult[]> {
    this.#scanInFlight ??= this.#doScanAll().finally(() => {
      this.#scanInFlight = null;
      this.#lastScanAt = Date.now();
    });
    return this.#scanInFlight;
  }

  async #doScanAll(): Promise<ScanResult[]> {
    const pool = this.#pool();
    await pool.refresh();

    const results: ScanResult[] = [];
    // Sequential on purpose: parallel scans of eight accounts would burst the
    // shared rate limiter and gain nothing, since the limiter serializes anyway.
    for (const provider of pool.healthyProviders()) {
      results.push(await this.scanAccount(provider));
    }
    return results;
  }

  /** Scans one account and prunes rows it no longer holds. */
  async scanAccount(provider: StorageProvider): Promise<ScanResult> {
    const accountId = provider.accountId;

    // Per-account scan lock. Without this, two concurrent scanAccount() calls
    // on the same account can interleave: the second's prune with its higher
    // seenAt-watermark deletes the first's freshly-written rows. The lock
    // chains calls so only one runs at a time per account; different accounts
    // run in parallel.
    const prev = this.#scanLocks.get(accountId);
    const myTurn = prev ? prev.then(() => this.#scanOne(provider)) : this.#scanOne(provider);
    this.#scanLocks.set(accountId, myTurn.catch(() => {}));
    return myTurn;
  }

  async #scanOne(provider: StorageProvider): Promise<ScanResult> {
    const accountId = provider.accountId;
    // The seenAt-watermark stays in microsecond units (Date.now() * 1_000 +
    // scanSeq) because the prune comparison is `seen_at < seenAt` and we need
    // it strictly greater than any prior scan. But `addedAt` (the user-visible
    // "when did this title first appear") must be real milliseconds so that
    // `Date.now() - addedAt` in the admin and addon yields a sensible number.
    this.#scanSeq += 1;
    const seenAt = Date.now() * 1_000 + this.#scanSeq;
    const addedAt = Date.now();

    const videos: Array<{ file: RemoteFile; folderId: string; magnet: string | null }> = [];
    const subtitles: Array<{ file: RemoteFile; folderId: string; magnet: string | null }> = [];

    try {
      await this.#walk(provider, null, 0, videos, subtitles);
    } catch (err) {
      return {
        accountId,
        videos: 0,
        subtitles: 0,
        pruned: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // One transaction per account: a failure mid-write leaves the previous
    // index intact rather than a half-updated one. We track whether any
    // title was newly inserted (vs. updated) so we can fire the metadata
    // enricher once per scan — the operator's catalog and Stremio both
    // need the IMDb id within seconds, not on the next 30-min poll.
    let newTitles = 0;
    const external: string[] = [];
    const pruned = this.#store.transaction(() => {
      for (const entry of videos) {
        const { file, folderId, magnet } = entry;
        const parsed = parseMediaName(file.name);
        const key = mediaKey(parsed);

        // A file whose name yields no title would produce an unusable catalog
        // entry, so it is skipped rather than indexed under an empty key.
        if (key === '') continue;

        // Content we did not put there: a NEW file (no row yet) whose folder
        // has no magnet on record. Everything SeedrPool queues goes through
        // recordMagnet, so a magnetless arrival means the account's owner
        // used it directly — a shared account in active use outside us.
        // Legacy files that pre-date the magnets table are already indexed,
        // so the `existing === null` guard keeps them quiet.
        if (magnet === null && this.#store.findFile(accountId, file.id) === null) {
          external.push(file.name);
        }

        const inserted = this.#store.upsertTitle({
          key,
          name: parsed.title,
          year: parsed.year,
          kind: parsed.kind,
          addedAt, // real ms; the user-visible "added N ago" is computed off this
          imdbId: null,
          tmdbId: null,
        });
        if (inserted) newTitles += 1;

        this.#store.upsertFile({
          fileId: file.id,
          accountId,
          folderId,
          name: file.name,
          size: file.size,
          hash: file.hash,
          titleKey: key,
          season: parsed.season,
          episode: parsed.episode,
          resolution: parsed.resolution,
          group: parsed.group,
          magnet: entry.magnet,
          seenAt,
        });
      }

      for (const { file, folderId } of subtitles) {
        this.#store.upsertSubtitle({
          fileId: file.id,
          accountId,
          folderId,
          name: file.name,
          language: guessLanguage(file.name),
          seenAt,
        });
      }

      return this.#store.pruneAccount(accountId, seenAt);
    });

    // Outside-content flag: one row per account, first sighting wins. The
    // activity entry fires only on the first-ever sighting so a shared
    // account in steady use logs once, not on every scan.
    for (const name of external) {
      if (this.#store.flagExternalContent(accountId, name)) {
        this.#store.recordActivity(
          'warn',
          `Outside content on ${accountId}`,
          `"${name.slice(0, 60)}" appeared without a SeedrPool magnet — the account's owner is using it directly`,
        );
        break;
      }
    }

    if (newTitles > 0 && this.#onScanComplete !== null) {
      // Fire-and-forget: the next poll cycle is the safety net, so a slow
      // TMDB response can't block the next scan.
      void this.#onScanComplete();
    }

    return { accountId, videos: videos.length, subtitles: subtitles.length, pruned };
  }

  /**
   * Recursively collects videos and subtitles, depth-limited. When descending
   * into a folder, also looks up the magnet that produced it and stamps every
   * file inside that folder with the magnet URL — that is what powers the
   * admin re-add button and the per-file "original magnet" column.
   */
  async #walk(
    provider: StorageProvider,
    folderId: string | null,
    depth: number,
    videos: Array<{ file: RemoteFile; folderId: string; magnet: string | null }>,
    subtitles: Array<{ file: RemoteFile; folderId: string; magnet: string | null }>,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;

    const contents = await provider.listFolder(folderId);
    const currentId = folderId ?? '0';

    for (const file of contents.files) {
      // Trust the provider's own classification over extension matching, per
      // agents.md rule 11.
      if (file.isVideo) {
        videos.push({ file, folderId: currentId, magnet: null });
      } else if (SUBTITLE_EXTENSIONS.test(file.name)) {
        subtitles.push({ file, folderId: currentId, magnet: null });
      }
    }

    for (const folder of contents.folders) {
      // Match a folder back to the magnet the user added. The folder's
      // `name` is the URL-decoded `dn=` from the original magnet. `path`
      // is the full sub-path and is more specific; we try both.
      const magnet =
        this.#store.magnetForFolder(folder.name ?? folder.path)?.magnet ??
        this.#store.magnetForFolder(folder.path)?.magnet ??
        null;
      await this.#walkWithMagnet(
        provider,
        folder.id,
        depth + 1,
        magnet,
        videos,
        subtitles,
      );
    }
  }

  async #walkWithMagnet(
    provider: StorageProvider,
    folderId: string,
    depth: number,
    magnet: string | null,
    videos: Array<{ file: RemoteFile; folderId: string; magnet: string | null }>,
    subtitles: Array<{ file: RemoteFile; folderId: string; magnet: string | null }>,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const contents = await provider.listFolder(folderId);
    for (const file of contents.files) {
      if (file.isVideo) {
        videos.push({ file, folderId, magnet });
      } else if (SUBTITLE_EXTENSIONS.test(file.name)) {
        subtitles.push({ file, folderId, magnet });
      }
    }
    for (const folder of contents.folders) {
      await this.#walkWithMagnet(provider, folder.id, depth + 1, magnet, videos, subtitles);
    }
  }
}

/**
 * Guesses a subtitle language from its filename.
 *
 * Sidecar files conventionally embed the language before the extension, as in
 * `Sintel.en.srt` or `Movie.english.srt`. Returns null rather than guessing when
 * no marker is present, so the addon can label it "unknown" honestly.
 */
export function guessLanguage(name: string): string | null {
  const withoutExtension = name.replace(SUBTITLE_EXTENSIONS, '');

  // Two- or three-letter code in the final dotted segment.
  const code = /\.([a-z]{2,3})$/i.exec(withoutExtension);
  if (code?.[1]) return code[1].toLowerCase();

  for (const [word, iso] of Object.entries(LANGUAGE_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(withoutExtension)) return iso;
  }

  return null;
}

/** Full language names that appear in sidecar filenames. */
const LANGUAGE_WORDS: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  polish: 'pl',
  russian: 'ru',
  hindi: 'hi',
  tamil: 'ta',
  telugu: 'te',
  arabic: 'ar',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
};
