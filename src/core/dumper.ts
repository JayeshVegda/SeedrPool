/**
 * Per-account JSON dumper.
 *
 * On a schedule, the operator calls `dumpAccountsToDisk()` which:
 *   1. Asks the pool for a snapshot of every account
 *   2. Writes one file per account to `data/dumps/<accountId>.<unixMs>.json`
 *   3. Prunes the directory to keep the last N files per account
 *
 * The access token is masked by the provider before this module sees it,
 * so the files on disk are safe to inspect without leaking credentials.
 */
import { mkdir, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';

import type { AccountPool } from './account-pool.ts';

const DEFAULT_KEEP = 5;

interface DumperOptions {
  /** Directory the JSON files are written into. */
  directory: string;
  /** How many files to keep per account. Oldest are deleted first. */
  keepPerAccount?: number;
}

export interface DumpSummary {
  written: string[];
  errors: string[];
  /**
   * Accounts whose snapshot was written but is missing at least one
   * section. The file is still useful (it records *why* each section
   * failed), but the numbers in it are not the account's real state.
   *
   * Kept separate from `errors`: an incomplete dump is not a failed dump.
   * The distinction matters because the previous version reported eight
   * clean writes while silently persisting zeros for every account.
   */
  incomplete: string[];
  /** The number of bytes freed by pruning older dumps this run. */
  prunedBytes: number;
}

/** The shape the dumper needs from a snapshot. Structural, so tests can fake it. */
interface DumpLike {
  complete?: boolean;
  quota?: { error?: string };
  root?: { error?: string };
  transfersError?: string;
}

export class Dumper {
  readonly #directory: string;
  readonly #keep: number;

  constructor(options: DumperOptions) {
    this.#directory = options.directory;
    this.#keep = options.keepPerAccount ?? DEFAULT_KEEP;
  }

  /**
   * Snapshots the pool and writes one file per account. Each file is
   * a `AccountDump` JSON, named `<accountId>.<unixMs>.json` so the
   * timestamp is part of the file name and older dumps sort naturally.
   */
  async dump(pool: AccountPool): Promise<DumpSummary> {
    await mkdir(this.#directory, { recursive: true });
    const ts = Date.now();
    const results = await pool.dumpAll();
    const written: string[] = [];
    const errors: string[] = [];
    const incomplete: string[] = [];

    for (const r of results) {
      if (!r.ok) {
        errors.push(`${r.accountId}: ${r.error}`);
        continue;
      }
      const path = join(this.#directory, `${r.accountId}.${ts}.json`);
      // Indent by 2 for human readability. The token field stays masked
      // because the provider stripped it before this module sees it.
      await writeFile(path, JSON.stringify(r.dump, null, 2) + '\n');
      written.push(path);

      const dump = r.dump as DumpLike;
      if (dump.complete === false) {
        const why = dump.quota?.error ?? dump.root?.error ?? dump.transfersError ?? 'unknown';
        incomplete.push(`${r.accountId}: ${why}`);
      }
    }

    const prunedBytes = await this.#prune();
    return { written, errors, incomplete, prunedBytes };
  }

  /**
   * Removes the oldest dumps for each account, keeping the most
   * recent `keepPerAccount` files. Files are matched by `<accountId>.*`.
   */
  async #prune(): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch {
      return 0; // directory doesn't exist yet
    }
    const byAccount = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = /^([^.]+)\.(\d+)\.json$/.exec(e.name);
      if (!m || !m[1] || !m[2]) continue;
      const list = byAccount.get(m[1]) ?? [];
      list.push(e.name);
      byAccount.set(m[1], list);
    }
    let freed = 0;
    for (const list of byAccount.values()) {
      list.sort(); // timestamps are zero-padded 13-digit unix ms, lexical = numeric
      const staleCount = Math.max(0, list.length - this.#keep);
      for (const stale of list.slice(0, staleCount)) {
        const path = join(this.#directory, stale);
        try {
          const s = await stat(path);
          await unlink(path);
          freed += s.size;
        } catch {
          // best-effort; another prune may catch it
        }
      }
    }
    return freed;
  }

  /** Lists the most recent dump per account, for the admin UI. */
  async latest(): Promise<Array<{ accountId: string; path: string; size: number; mtime: number }>> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const latestByAccount = new Map<string, { path: string; size: number; mtime: number }>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = /^([^.]+)\.(\d+)\.json$/.exec(e.name);
      if (!m || !m[1] || !m[2]) continue;
      const path = join(this.#directory, e.name);
      const s = await stat(path).catch(() => null);
      if (!s) continue;
      const existing = latestByAccount.get(m[1]);
      if (!existing || s.mtime.getTime() > existing.mtime) {
        latestByAccount.set(m[1], { path, size: s.size, mtime: s.mtime.getTime() });
      }
    }
    return [...latestByAccount.entries()].map(([accountId, info]) => ({ accountId, ...info }));
  }
}
