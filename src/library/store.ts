/**
 * SQLite-backed library index.
 *
 * Uses Node 24's built-in `node:sqlite`, so there is no native dependency to
 * compile. `better-sqlite3` was rejected because it has no prebuilt binary for
 * this Node ABI.
 *
 * Two tables and one derived view of the data:
 *   - `files` is one row per physical file on one account;
 *   - `titles` is one row per logical movie or series, which several files may
 *     point at (different accounts, different releases, different episodes).
 *
 * The index is a cache of Seedr's state, not the source of truth. It can be
 * deleted and rebuilt by rescanning, so migrations favour simplicity over
 * preserving data.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** One physical video file on one account. */
export interface LibraryFile {
  /** Provider-side file id. Unique per account, not globally. */
  fileId: string;
  accountId: string;
  folderId: string;
  /** Original filename, used for subtitle matching and display. */
  name: string;
  size: number;
  /** Seedr's SHA-1, when present. Identifies duplicates across accounts. */
  hash: string | null;
  /** Key of the logical title this file belongs to. */
  titleKey: string;
  season: number | null;
  episode: number | null;
  resolution: number | null;
  group: string | null;
  /**
   * The original magnet that produced this file, when known. Used by the
   * admin re-add flow to drop a file from one account and re-queue it on
   * another. NULL for files that arrived from a previous deploy or from
   * a magnet we did not capture at add time.
   */
  magnet: string | null;
  /** Unix seconds when this row was last confirmed present on Seedr. */
  seenAt: number;
}

/** One logical movie or series, independent of which account holds it. */
export interface LibraryTitle {
  /** Stable id derived from the normalized name and year. */
  key: string;
  name: string;
  year: number | null;
  kind: 'movie' | 'series';
  /** Unix seconds when a file for this title was first indexed. */
  addedAt: number;
  /**
   * IMDb id (`tt...`) when the metadata service has matched the title. When
   * set, Stremio hands the same id to Cinemeta, which fills in cast, director,
   * runtime, rating, and the rest of the rich fields.
   */
  imdbId: string | null;
  /**
   * TMDB id, kept alongside the IMDb id because TMDB's poster and background
   * URLs are CDN-stable and free to use; the IMDb id alone is not enough to
   * fetch artwork.
   */
  tmdbId: number | null;
}

/** A title with its aggregate file stats, for catalog rendering. */
export interface TitleSummary extends LibraryTitle {
  fileCount: number;
  totalSize: number;
  /** Best resolution among this title's files, when known. */
  bestResolution: number | null;
}

/** Sidecar subtitle file living alongside a video. */
export interface SubtitleFile {
  fileId: string;
  accountId: string;
  name: string;
  /** OpenSubtitles-style 3-letter code, when the filename carried a language tag. */
  language: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS titles (
  key      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  year     INTEGER,
  kind     TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  imdb_id  TEXT,
  tmdb_id  INTEGER
);

CREATE TABLE IF NOT EXISTS files (
  file_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  hash       TEXT,
  title_key  TEXT NOT NULL,
  season     INTEGER,
  episode    INTEGER,
  resolution INTEGER,
  release_group TEXT,
  seen_at    INTEGER NOT NULL,
  -- The original magnet that produced this file, when known. Used by the
  -- admin re-add flow to drop a file from one account and re-queue it on
  -- another. NULL for files that arrived from a previous deploy or from
  -- a magnet we did not capture at add time.
  magnet     TEXT,
  -- A file id is only unique within its account.
  PRIMARY KEY (account_id, file_id),
  FOREIGN KEY (title_key) REFERENCES titles(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS files_title ON files(title_key);
CREATE INDEX IF NOT EXISTS files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS files_account ON files(account_id);
CREATE INDEX IF NOT EXISTS titles_imdb ON titles(imdb_id) WHERE imdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS titles_tmdb ON titles(tmdb_id) WHERE tmdb_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subtitles (
  file_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  language   TEXT,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, file_id)
);

CREATE INDEX IF NOT EXISTS subtitles_folder ON subtitles(account_id, folder_id);

-- Activity log: the operator's booth timeline. Each row is one event
-- the operator would want to see: a transfer finishing, a magnet
-- landing, a CDN breaking, etc. The admin overview renders the most
-- recent N as a vertical timeline. Capped at 200 rows so the table
-- never grows unbounded.
CREATE TABLE IF NOT EXISTS activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,   -- 'info' | 'success' | 'warn' | 'bad'
  message   TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);

-- Source-of-truth table for the original magnet a title came from. The
-- indexer matches folders to rows here by name and writes the magnet URL
-- onto each files.magnet column. The admin re-add button reads from this
-- table to know what to re-queue on a different account.
--
-- display_name is the part of the folder Seedr creates for a torrent and
-- usually equals the magnet's dn= parameter. We index on it because the
-- match is by prefix during the walk.
CREATE TABLE IF NOT EXISTS magnets (
  display_name TEXT PRIMARY KEY,
  magnet       TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  added_at     INTEGER NOT NULL
);
`;

export class LibraryStore {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    // WAL keeps reads (addon requests) from blocking the indexer's writes.
    if (path !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL');
    }
    this.#db.exec('PRAGMA foreign_keys = ON');
    // Run the migration before the schema. SCHEMA references the
    // `imdb_id`/`tmdb_id` columns (in indexes and CREATE TABLE), so the
    // pre-existing table must be widened first or the index creation
    // blows up.
    this.#addColumnIfMissing('titles', 'imdb_id', 'TEXT');
    this.#addColumnIfMissing('titles', 'tmdb_id', 'INTEGER');
    this.#addColumnIfMissing('files', 'magnet', 'TEXT');
    this.#db.exec(SCHEMA);
  }

  /**
   * Adds a column when an existing database predates the current schema.
   *
   * SQLite has no `IF NOT EXISTS` for columns, so we look up the column list
   * first. The check is cheap (a few rows) and only runs at startup.
   */
  #addColumnIfMissing(table: string, column: string, type: string): void {
    const rows = this.#db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    // No rows means the table does not exist yet; the SCHEMA below will
    // create it with the column already declared, so the ALTER is
    // unnecessary and would error.
    if (rows.length === 0) return;
    if (rows.some((row) => row.name === column)) return;
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }


  close(): void {
    this.#db.close();
  }

  /**
   * Inserts or updates a title. Existing `added_at` and existing imdb/tmdb
   * ids are preserved — they are stable results of one-time lookups, not
   * something to overwrite on every file arrival.
   *
   * `imdbId` and `tmdbId` are optional in the parameter, since most titles
   * arrive without one and the metadata service fills it in later. The store
   * normalises `undefined` to SQL NULL, since node:sqlite rejects `undefined`
   * as a parameter value.
   */
  /**
   * Inserts a title or updates the existing one. Returns true if the row was
   * newly inserted, false if the existing row was updated. Callers use this
   * to fire one-shot events (e.g. "a new title needs metadata enrichment")
   * without needing a separate SELECT.
   */
  upsertTitle(title: Omit<LibraryTitle, 'imdbId' | 'tmdbId'> & { imdbId?: string | null; tmdbId?: number | null }): boolean {
    // Use a row-existence check to detect insert vs update. The indexer wraps
    // many upserts in one transaction; we can't use the connection-level
    // changes() because that aggregates across statements in the same tx.
    const existed = this.#db
      .prepare('SELECT 1 AS n FROM titles WHERE key = ?')
      .get(title.key) as { n: number } | undefined;
    this.#db
      .prepare(
        `INSERT INTO titles (key, name, year, kind, added_at, imdb_id, tmdb_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           -- Prefer the longer name: later files often carry a fuller title.
           name = CASE WHEN length(excluded.name) > length(titles.name)
                       THEN excluded.name ELSE titles.name END,
           year = COALESCE(titles.year, excluded.year),
           -- A single episode file proves the title is a series.
           kind = CASE WHEN excluded.kind = 'series' THEN 'series' ELSE titles.kind END,
           imdb_id = COALESCE(titles.imdb_id, excluded.imdb_id),
           tmdb_id = COALESCE(titles.tmdb_id, excluded.tmdb_id)`,
      )
      .run(
        title.key,
        title.name,
        title.year,
        title.kind,
        title.addedAt,
        title.imdbId ?? null,
        title.tmdbId ?? null,
      );
    return existed === undefined;
  }

  /** Inserts or updates one physical file. */
  upsertFile(file: Omit<LibraryFile, 'magnet'> & { magnet?: string | null }): void {
    this.#db
      .prepare(
        `INSERT INTO files
           (file_id, account_id, folder_id, name, size, hash, title_key,
            season, episode, resolution, release_group, seen_at, magnet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, file_id) DO UPDATE SET
           folder_id = excluded.folder_id,
           name = excluded.name,
           size = excluded.size,
           hash = excluded.hash,
           title_key = excluded.title_key,
           season = excluded.season,
           episode = excluded.episode,
           resolution = excluded.resolution,
           release_group = excluded.release_group,
           seen_at = excluded.seen_at,
           -- Preserve the original magnet: a re-add that lands a different
           -- file under the same provider file id (rare, but happens when
           -- Seedr's hash colides) should not erase our record of where
           -- this entry came from.
           magnet = COALESCE(files.magnet, excluded.magnet)`,
      )
      .run(
        file.fileId,
        file.accountId,
        file.folderId,
        file.name,
        file.size,
        file.hash,
        file.titleKey,
        file.season,
        file.episode,
        file.resolution,
        file.group,
        file.seenAt,
        file.magnet ?? null,
      );
  }

  upsertSubtitle(sub: SubtitleFile & { folderId: string; seenAt: number }): void {
    this.#db
      .prepare(
        `INSERT INTO subtitles (file_id, account_id, folder_id, name, language, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, file_id) DO UPDATE SET
           folder_id = excluded.folder_id,
           name = excluded.name,
           language = excluded.language,
           seen_at = excluded.seen_at`,
      )
      .run(sub.fileId, sub.accountId, sub.folderId, sub.name, sub.language, sub.seenAt);
  }

  /** Records an IMDb/TMDB match on an existing title. */
  setTitleIds(key: string, ids: { imdbId?: string | null; tmdbId?: number | null }): void {
    if (ids.imdbId !== undefined) {
      this.#db.prepare('UPDATE titles SET imdb_id = ? WHERE key = ?').run(ids.imdbId, key);
    }
    if (ids.tmdbId !== undefined) {
      this.#db.prepare('UPDATE titles SET tmdb_id = ? WHERE key = ?').run(ids.tmdbId, key);
    }
  }

  /**
   * Records the magnet that produced a folder, so the admin re-add button
   * has something to re-queue later. `displayName` is the folder name
   * Seedr creates for the torrent (typically the magnet's `dn=` parameter,
   * URL-decoded).
   */
  recordMagnet(displayName: string, magnet: string, accountId: string): void {
    this.#db
      .prepare(
        `INSERT INTO magnets (display_name, magnet, account_id, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(display_name) DO UPDATE SET
           magnet = excluded.magnet,
           account_id = excluded.account_id,
           added_at = excluded.added_at`,
      )
      .run(displayName, magnet, accountId, Date.now());
  }

  /**
   * Looks up a magnet by the folder name it produced. Returns null when no
   * record exists — for example, a folder that pre-dates the magnets
   * table, or a folder that came from a magnet the user added through
   * Seedr's own web UI rather than the SeedrPool admin.
   */
  magnetForFolder(displayName: string): { magnet: string; accountId: string } | null {
    const row = this.#db
      .prepare('SELECT magnet, account_id FROM magnets WHERE display_name = ?')
      .get(displayName) as { magnet: string; account_id: string } | undefined;
    if (!row) return null;
    return { magnet: String(row.magnet), accountId: String(row.account_id) };
  }

  /** Lists every stored magnet, newest first. Used by the admin re-add UI. */
  listMagnets(): Array<{ displayName: string; magnet: string; accountId: string; addedAt: number }> {
    const rows = this.#db
      .prepare(
        'SELECT display_name, magnet, account_id, added_at FROM magnets ORDER BY added_at DESC',
      )
      .all() as Array<{ display_name: string; magnet: string; account_id: string; added_at: number }>;
    return rows.map((r) => ({
      displayName: String(r.display_name),
      magnet: String(r.magnet),
      accountId: String(r.account_id),
      addedAt: Number(r.added_at),
    }));
  }

  /**
   * Lists every file that has a stored magnet, joined with its title name
   * for display. Used by the admin "Move" UI to show one row per file.
   */
  listFilesWithMagnet(): Array<{
    fileId: string;
    accountId: string;
    name: string;
    size: number;
    magnet: string;
    titleName: string;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT f.file_id, f.account_id, f.name, f.size, f.magnet, t.name AS title_name
         FROM files f
         JOIN titles t ON t.key = f.title_key
         WHERE f.magnet IS NOT NULL
         ORDER BY t.name, f.account_id`,
      )
      .all() as Array<{
        file_id: string;
        account_id: string;
        name: string;
        size: number;
        magnet: string;
        title_name: string;
      }>;
    return rows.map((r) => ({
      fileId: String(r.file_id),
      accountId: String(r.account_id),
      name: String(r.name),
      size: Number(r.size),
      magnet: String(r.magnet),
      titleName: String(r.title_name),
    }));
  }

  /** Deletes the stored magnet for a folder name. Idempotent. */
  forgetMagnet(displayName: string): void {
    this.#db.prepare('DELETE FROM magnets WHERE display_name = ?').run(displayName);
  }

  /**
   * Records one event in the operator timeline.
   *
   * `kind` is the visual style: `info` (amber), `success` (sage), `warn`
   * (hot amber), `bad` (dusty red). The activity table is capped at
   * 200 rows; older rows are pruned on each insert.
   */
  recordActivity(
    kind: 'info' | 'success' | 'warn' | 'bad',
    message: string,
    detail?: string,
  ): void {
    this.#db
      .prepare('INSERT INTO activity (at, kind, message, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), kind, message, detail ?? null);
    // Cap the log at 200 rows.
    this.#db.exec(`
      DELETE FROM activity WHERE id IN (
        SELECT id FROM activity ORDER BY at DESC LIMIT -1 OFFSET 200
      )
    `);
  }

  /**
   * The most recent N activity rows, newest first.
   *
   * The cap matters: the operator's eye should see "what just happened",
   * not the full history. Default 20 is enough to scan in one glance.
   *
   * Ties on `at` are broken by `id` descending. Without that, two events
   * recorded in the same millisecond — which happens routinely, e.g. a
   * purge that logs a warning and a success together — come back in
   * arbitrary order and the timeline reads backwards.
   */
  recentActivity(limit: number = 20): Array<{
    id: number;
    at: number;
    kind: 'info' | 'success' | 'warn' | 'bad';
    message: string;
    detail: string | null;
  }> {
    const rows = this.#db
      .prepare('SELECT id, at, kind, message, detail FROM activity ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; at: number; kind: string; message: string; detail: string | null }>;
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      kind: r.kind as 'info' | 'success' | 'warn' | 'bad',
      message: String(r.message),
      detail: r.detail === null ? null : String(r.detail),
    }));
  }

  /** All titles without an IMDb match yet, in the order they were added. */
  titlesNeedingLookup(): Array<Pick<TitleSummary, 'key' | 'name' | 'year' | 'kind' | 'imdbId' | 'tmdbId'>> {
    const rows = this.#db
      .prepare(
        `SELECT key, name, year, kind, imdb_id, tmdb_id
         FROM titles
         WHERE imdb_id IS NULL
         ORDER BY added_at ASC`,
      )
      .all();
    return rows.map((row) => ({
      key: String(row['key']),
      name: String(row['name']),
      year: row['year'] === null ? null : Number(row['year']),
      kind: row['kind'] === 'series' ? 'series' : 'movie',
      imdbId: row['imdb_id'] === null ? null : String(row['imdb_id']),
      tmdbId: row['tmdb_id'] === null ? null : Number(row['tmdb_id']),
    }));
  }

  /**
   * Removes rows not seen in the latest scan of an account.
   *
   * Deleting on Seedr's side is the only way files disappear, and the index must
   * follow or the addon will offer streams that 404.
   */
  /**
   * Removes a single file row. Used by the admin "move" flow to drop a
   * broken-CDN source immediately rather than waiting for the next scan.
   * Returns true when a row was removed.
   */
  deleteFileRow(accountId: string, fileId: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM files WHERE account_id = ? AND file_id = ?')
      .run(accountId, fileId);
    // Drop the title too if this was the last file holding it.
    this.#db.exec('DELETE FROM titles WHERE key NOT IN (SELECT title_key FROM files)');
    return result.changes > 0;
  }

  /**
   * Removes every file (and subtitle) for an account, then drops any
   * titles that now have no files. Used by the "purge" action to clean
   * up the library when an account is wiped on Seedr's side.
   */
  deleteAccountFiles(accountId: string): number {
    const files = this.#db
      .prepare('DELETE FROM files WHERE account_id = ?')
      .run(accountId);
    this.#db
      .prepare('DELETE FROM subtitles WHERE account_id = ?')
      .run(accountId);
    this.#db.exec('DELETE FROM titles WHERE key NOT IN (SELECT title_key FROM files)');
    return Number(files.changes);
  }

  pruneAccount(accountId: string, seenAt: number): number {
    const files = this.#db
      .prepare('DELETE FROM files WHERE account_id = ? AND seen_at < ?')
      .run(accountId, seenAt);
    this.#db
      .prepare('DELETE FROM subtitles WHERE account_id = ? AND seen_at < ?')
      .run(accountId, seenAt);
    // A title with no remaining files is not browsable, so drop it.
    this.#db.exec('DELETE FROM titles WHERE key NOT IN (SELECT title_key FROM files)');
    return Number(files.changes);
  }

  /** All titles with aggregate stats, newest first. */
  listTitles(options: { kind?: 'movie' | 'series'; search?: string; limit?: number } = {}): TitleSummary[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.kind) {
      conditions.push('t.kind = ?');
      params.push(options.kind);
    }
    if (options.search) {
      // Substring match is enough at this library size; FTS would be premature.
      conditions.push('lower(t.name) LIKE ?');
      params.push(`%${options.search.toLowerCase()}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 500;

    const rows = this.#db
      .prepare(
        `SELECT t.key, t.name, t.year, t.kind, t.added_at,
                t.imdb_id, t.tmdb_id,
                COUNT(f.file_id) AS file_count,
                COALESCE(SUM(f.size), 0) AS total_size,
                MAX(f.resolution) AS best_resolution
         FROM titles t
         JOIN files f ON f.title_key = t.key
         ${where}
         GROUP BY t.key
         ORDER BY t.added_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);

    return rows.map(toTitleSummary);
  }

  getTitle(key: string): TitleSummary | null {
    // LEFT JOIN so a title still resolves during the brief window between
    // upsert and the first file arriving. `COALESCE` gives sensible zeros
    // for titles with no files.
    const row = this.#db
      .prepare(
        `SELECT t.key, t.name, t.year, t.kind, t.added_at,
                t.imdb_id, t.tmdb_id,
                COUNT(f.file_id) AS file_count,
                COALESCE(SUM(f.size), 0) AS total_size,
                MAX(f.resolution) AS best_resolution
         FROM titles t
         LEFT JOIN files f ON f.title_key = t.key
         WHERE t.key = ?
         GROUP BY t.key`,
      )
      .get(key);

    return row ? toTitleSummary(row) : null;
  }

  /** Looks up a title by its IMDb id, used when Stremio hands us a Cinemeta id. */
  getTitleByImdbId(imdbId: string): TitleSummary | null {
    const row = this.#db
      .prepare(
        `SELECT t.key, t.name, t.year, t.kind, t.added_at,
                t.imdb_id, t.tmdb_id,
                COUNT(f.file_id) AS file_count,
                COALESCE(SUM(f.size), 0) AS total_size,
                MAX(f.resolution) AS best_resolution
         FROM titles t
         LEFT JOIN files f ON f.title_key = t.key
         WHERE t.imdb_id = ?
         GROUP BY t.key`,
      )
      .get(imdbId);
    return row ? toTitleSummary(row) : null;
  }

  /**
   * Files for a title, best first.
   *
   * Ordering is by resolution then size, so the addon's first stream is the best
   * copy without the caller needing to sort.
   */
  filesForTitle(titleKey: string): LibraryFile[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM files WHERE title_key = ?
         ORDER BY COALESCE(resolution, 0) DESC, size DESC`,
      )
      .all(titleKey);
    return rows.map(toLibraryFile);
  }

  /** Files for one episode of a series. */
  filesForEpisode(titleKey: string, season: number, episode: number): LibraryFile[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM files
         WHERE title_key = ? AND season = ? AND episode = ?
         ORDER BY COALESCE(resolution, 0) DESC, size DESC`,
      )
      .all(titleKey, season, episode);
    return rows.map(toLibraryFile);
  }

  /** Distinct season/episode pairs for a series, in order. */
  episodesForTitle(titleKey: string): Array<{ season: number; episode: number | null }> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT season, episode FROM files
         WHERE title_key = ? AND season IS NOT NULL
         ORDER BY season, episode`,
      )
      .all(titleKey);

    return rows.map((r) => ({
      season: Number(r['season']),
      episode: r['episode'] === null ? null : Number(r['episode']),
    }));
  }

  findFile(accountId: string, fileId: string): LibraryFile | null {
    const row = this.#db
      .prepare('SELECT * FROM files WHERE account_id = ? AND file_id = ?')
      .get(accountId, fileId);
    return row ? toLibraryFile(row) : null;
  }

  /** Subtitles sitting in the same folder as a video. */
  subtitlesForFolder(accountId: string, folderId: string): SubtitleFile[] {
    const rows = this.#db
      .prepare(
        'SELECT file_id, account_id, name, language FROM subtitles WHERE account_id = ? AND folder_id = ?',
      )
      .all(accountId, folderId);

    return rows.map((r) => ({
      fileId: String(r['file_id']),
      accountId: String(r['account_id']),
      name: String(r['name']),
      language: r['language'] === null ? null : String(r['language']),
    }));
  }

  /**
   * Groups of files sharing a hash across different accounts.
   *
   * These are byte-identical copies, so all but one are reclaimable space.
   */
  duplicateGroups(): Array<{ hash: string; files: LibraryFile[] }> {
    const hashes = this.#db
      .prepare(
        `SELECT hash FROM files
         WHERE hash IS NOT NULL
         GROUP BY hash HAVING COUNT(*) > 1`,
      )
      .all();

    return hashes.map((row) => {
      const hash = String(row['hash']);
      const files = this.#db
        .prepare('SELECT * FROM files WHERE hash = ? ORDER BY account_id')
        .all(hash)
        .map(toLibraryFile);
      return { hash, files };
    });
  }

  stats(): {
    titles: number;
    files: number;
    totalSize: number;
    subtitles: number;
    /** Titles that still have no IMDb id — drives the admin progress bar. */
    needsLookup: number;
  } {
    const row = this.#db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM titles) AS titles,
                (SELECT COUNT(*) FROM files) AS files,
                (SELECT COALESCE(SUM(size), 0) FROM files) AS total_size,
                (SELECT COUNT(*) FROM subtitles) AS subtitles,
                (SELECT COUNT(*) FROM titles WHERE imdb_id IS NULL) AS needs_lookup`,
      )
      .get();

    return {
      titles: Number(row?.['titles'] ?? 0),
      files: Number(row?.['files'] ?? 0),
      totalSize: Number(row?.['total_size'] ?? 0),
      subtitles: Number(row?.['subtitles'] ?? 0),
      needsLookup: Number(row?.['needs_lookup'] ?? 0),
    };
  }

  /**
   * Files for many titles in one query, grouped by title key.
   *
   * The admin library page needs every title's files to compute per-title
   * account lists and torn-reel state. Calling `filesForTitle` in a loop cost
   * one query per title per render pass, three passes deep — 3N queries for N
   * titles. This is one query total.
   */
  filesForTitles(titleKeys: string[]): Map<string, LibraryFile[]> {
    const out = new Map<string, LibraryFile[]>();
    if (titleKeys.length === 0) return out;
    // Chunked so a very large library cannot exceed SQLite's variable limit
    // (999 by default).
    const CHUNK = 500;
    for (let i = 0; i < titleKeys.length; i += CHUNK) {
      const chunk = titleKeys.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.#db
        .prepare(
          `SELECT * FROM files WHERE title_key IN (${placeholders})
           ORDER BY COALESCE(resolution, 0) DESC, size DESC`,
        )
        .all(...chunk);
      for (const row of rows) {
        const file = toLibraryFile(row);
        const list = out.get(file.titleKey);
        if (list) list.push(file);
        else out.set(file.titleKey, [file]);
      }
    }
    // Titles with no files still get an entry, so callers can skip a null check.
    for (const key of titleKeys) if (!out.has(key)) out.set(key, []);
    return out;
  }

  /**
   * Per-account library totals in one query. Powers the account cards and the
   * per-account detail page without a fanout to Seedr.
   */
  perAccountStats(): Map<string, { titles: number; files: number; bytes: number }> {
    const rows = this.#db
      .prepare(
        `SELECT account_id,
                COUNT(DISTINCT title_key) AS titles,
                COUNT(*)                  AS files,
                COALESCE(SUM(size), 0)    AS bytes
         FROM files
         GROUP BY account_id`,
      )
      .all() as Array<{ account_id: string; titles: number; files: number; bytes: number }>;
    return new Map(
      rows.map((r) => [
        String(r.account_id),
        { titles: Number(r.titles), files: Number(r.files), bytes: Number(r.bytes) },
      ]),
    );
  }

  /** Titles holding at least one file on the given account, newest first. */
  titlesForAccount(accountId: string): TitleSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT t.key, t.name, t.year, t.kind, t.added_at,
                t.imdb_id, t.tmdb_id,
                COUNT(f.file_id) AS file_count,
                COALESCE(SUM(f.size), 0) AS total_size,
                MAX(f.resolution) AS best_resolution
         FROM titles t
         JOIN files f ON f.title_key = t.key
         WHERE f.account_id = ?
         GROUP BY t.key
         ORDER BY t.added_at DESC`,
      )
      .all(accountId);
    return rows.map(toTitleSummary);
  }

  /** Files held on one account, largest first. */
  filesForAccount(accountId: string): Array<LibraryFile & { titleName: string }> {
    const rows = this.#db
      .prepare(
        `SELECT f.*, t.name AS title_name
         FROM files f
         JOIN titles t ON t.key = f.title_key
         WHERE f.account_id = ?
         ORDER BY f.size DESC`,
      )
      .all(accountId) as Row[];
    return rows.map((r) => ({ ...toLibraryFile(r), titleName: String(r['title_name']) }));
  }

  /**
   * Activity rows mentioning an account, newest first.
   *
   * Filtering in SQL rather than in the page: the activity table is capped at
   * 200 rows but the per-account page should not have to read all of them to
   * show a handful. Ties on `at` break by `id` for the same reason as
   * `recentActivity`.
   */
  activityForAccount(accountId: string, limit = 40): Array<{
    id: number;
    at: number;
    kind: 'info' | 'success' | 'warn' | 'bad';
    message: string;
    detail: string | null;
  }> {
    const needle = `%${accountId}%`;
    const rows = this.#db
      .prepare(
        `SELECT id, at, kind, message, detail FROM activity
         WHERE message LIKE ? OR detail LIKE ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(needle, needle, limit) as Array<{
        id: number; at: number; kind: string; message: string; detail: string | null;
      }>;
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      kind: r.kind as 'info' | 'success' | 'warn' | 'bad',
      message: String(r.message),
      detail: r.detail === null ? null : String(r.detail),
    }));
  }

  /** Clears the IMDb/TMDB ids for a title so the enricher looks it up again. */
  clearTitleIds(key: string): void {
    this.#db.prepare('UPDATE titles SET imdb_id = NULL, tmdb_id = NULL WHERE key = ?').run(key);
  }

  /** Clears every title's metadata ids. Used by "re-fetch all metadata". */
  clearAllTitleIds(): number {
    const r = this.#db.prepare('UPDATE titles SET imdb_id = NULL, tmdb_id = NULL').run();
    return Number(r.changes);
  }

  /** Runs `fn` in a transaction, so a failed scan leaves no partial state. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
}

type Row = Record<string, unknown>;

function toLibraryFile(row: Row): LibraryFile {
  return {
    fileId: String(row['file_id']),
    accountId: String(row['account_id']),
    folderId: String(row['folder_id']),
    name: String(row['name']),
    size: Number(row['size']),
    hash: row['hash'] === null ? null : String(row['hash']),
    titleKey: String(row['title_key']),
    season: row['season'] === null ? null : Number(row['season']),
    episode: row['episode'] === null ? null : Number(row['episode']),
    resolution: row['resolution'] === null ? null : Number(row['resolution']),
    group: row['release_group'] === null ? null : String(row['release_group']),
    magnet:
      row['magnet'] === null || row['magnet'] === undefined
        ? null
        : String(row['magnet']),
    seenAt: Number(row['seen_at']),
  };
}

function toTitleSummary(row: Row): TitleSummary {
  return {
    key: String(row['key']),
    name: String(row['name']),
    year: row['year'] === null ? null : Number(row['year']),
    kind: row['kind'] === 'series' ? 'series' : 'movie',
    addedAt: Number(row['added_at']),
    fileCount: Number(row['file_count']),
    totalSize: Number(row['total_size']),
    bestResolution: row['best_resolution'] === null ? null : Number(row['best_resolution']),
    imdbId: row['imdb_id'] === null || row['imdb_id'] === undefined ? null : String(row['imdb_id']),
    tmdbId: row['tmdb_id'] === null || row['tmdb_id'] === undefined ? null : Number(row['tmdb_id']),
  };
}
