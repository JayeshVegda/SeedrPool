/**
 * Centralized view-model layer for the admin UI.
 *
 * Every page reads from this object. The pool, the library, and the
 * transfer-watcher each have their own data, but pages should never have to
 * know that — they ask for "the overview data" or "this account's data" and
 * get back a plain shape they can render directly.
 *
 * This is the architectural answer to scaling to 50 accounts. The previous
 * admin code joined live API calls, derived data, and HTML rendering all
 * inline in each page, so any caching or batching had to be re-invented per
 * page. With the view-model in one place, the cache lives here, the batch
 * query lives here, and every page benefits when it is improved.
 */

import type { AccountPool, AccountStatus, PoolCapacity } from './account-pool.ts';
import type { LibraryStore, LibraryFile, TitleSummary, SubtitleFile } from '../library/store.ts';
import type { Transfer } from './types.ts';
import { formatBytes } from '../admin/html.ts';

export interface OverviewKpis {
  nodes: { total: number; healthy: number; cdnBroken: number; offline: number };
  storage: PoolCapacity & { used: number; free: number; max: number };
  library: { titles: number; files: number; subtitles: number; needsLookup: number; totalSize: number };
  transfers: { active: number; total: number };
  quality: { uhd: number; fhd: number; hd: number; sd: number };
  /** Same shape used to render the storage donut, server-side now. */
  storageBreakdown: Array<{ label: string; valueGib: number }>;
}

export interface AccountCard {
  accountId: string;
  label: string;
  email: string;
  status: AccountStatus;
  /** Direct from the library DB, no Seedr call. */
  library: { titles: number; files: number; bytes: number };
  /** Per-account transfer list, sourced from the cached fanout. */
  transfers: Array<Transfer & { accountId: string }>;
  /**
   * When non-null, the account holds content that SeedrPool did not put
   * there — its owner is using it directly. Informational, never a blocker.
   */
  externalContent: { firstSeenAt: number; example: string | null } | null;
}

export interface AccountDetail extends AccountCard {
  /** Per-title view of the account's library. */
  titles: TitleSummary[];
  /** Recent activity mentioning this account, newest first. */
  activity: Array<{ id: number; at: number; kind: 'info' | 'success' | 'warn' | 'bad'; message: string; detail: string | null }>;
  /** "X days since the file in the library was last indexed." */
  ageDays: number | null;
}

export interface LibraryCard {
  title: TitleSummary;
  files: LibraryFile[];
  accounts: string[];
  torn: 'all' | 'some' | 'none';
  isUhd: boolean;
  isFhd: boolean;
  resClass: 'res-4k' | 'res-1080p' | 'res-720p' | 'res-sd';
}

export class AdminViews {
  #getPool: () => AccountPool;
  #library: LibraryStore;
  #perAccount: Map<string, { titles: number; files: number; bytes: number }>;

  constructor(getPool: () => AccountPool, library: LibraryStore) {
    this.#getPool = getPool;
    this.#library = library;
    // Cheap query; rebuild each time the library changes is unnecessary
    // because the only writers are the indexer, and it goes through a
    // transaction. Refresh on demand.
    this.#perAccount = library.perAccountStats();
  }

  /**
   * Reload the per-account stats snapshot. Call after a scan completes.
   * The store's read is one query, so the cost is negligible.
   */
  refresh(): void {
    this.#perAccount = this.#library.perAccountStats();
  }

  /**
   * What the dashboard shows above the fold: the headline numbers, the
   * per-account storage donut data, the quality counts. One call, no fanout
   * to Seedr beyond the cached pool status.
   */
  async overview(): Promise<OverviewKpis> {
    const pool = this.#getPool();
    const statuses = pool.statuses();
    const capacity = pool.capacity();
    const stats = this.#library.stats();
    const titles = this.#library.listTitles();
    const transfers = await pool.listAllTransfers();
    const activeTransfers = transfers.filter(
      (t) => t.state !== 'finished' && t.state !== 'failed',
    );

    const uhd = titles.filter((t) => t.bestResolution && t.bestResolution >= 2160).length;
    const fhd = titles.filter(
      (t) => t.bestResolution && t.bestResolution >= 1080 && t.bestResolution < 2160,
    ).length;
    const hd = titles.filter(
      (t) => t.bestResolution && t.bestResolution >= 720 && t.bestResolution < 1080,
    ).length;
    const sd = titles.filter((t) => !t.bestResolution || t.bestResolution < 720).length;

    const storageBreakdown: Array<{ label: string; valueGib: number }> = statuses.map((s) => ({
      label: s.accountId,
      valueGib: s.quota ? Number((s.quota.used / 1024 ** 3).toFixed(2)) : 0,
    }));
    storageBreakdown.push({ label: 'Free', valueGib: Number((capacity.free / 1024 ** 3).toFixed(2)) });

    return {
      nodes: {
        total: statuses.length,
        healthy: statuses.filter((s) => s.healthy).length,
        cdnBroken: statuses.filter((s) => s.cdnHealthy === false).length,
        offline: statuses.filter((s) => !s.healthy).length,
      },
      storage: { ...capacity, used: capacity.used, free: capacity.free, max: capacity.max },
      library: { ...stats, totalSize: stats.totalSize },
      transfers: { active: activeTransfers.length, total: transfers.length },
      quality: { uhd, fhd, hd, sd },
      storageBreakdown,
    };
  }

  /**
   * One card per account, ready to render. The cards are intentionally
   * clickable: each becomes a link to /admin/accounts/:id which renders the
   * detail view from `accountDetail()` below.
   */
  async accountCards(): Promise<AccountCard[]> {
    const pool = this.#getPool();
    const statuses = pool.statuses();
    const transfers = await pool.listAllTransfers();
    const external = this.#library.externalContent();
    const transfersByAccount = new Map<string, Array<Transfer & { accountId: string }>>();
    for (const t of transfers) {
      const list = transfersByAccount.get(t.accountId);
      if (list) list.push(t);
      else transfersByAccount.set(t.accountId, [t]);
    }
    return statuses.map((s) => {
      const stats = this.#perAccount.get(s.accountId) ?? { titles: 0, files: 0, bytes: 0 };
      return {
        accountId: s.accountId,
        label: s.label,
        email: s.label,
        status: s,
        library: stats,
        transfers: transfersByAccount.get(s.accountId) ?? [],
        externalContent: external.get(s.accountId) ?? null,
      };
    });
  }

  /**
   * The account detail page in a single object. This is the only place the
   * detail page assembles its data, so adding a new section (e.g. settings,
   * magnetics list) is one place to touch.
   */
  async accountDetail(accountId: string): Promise<AccountDetail | null> {
    const pool = this.#getPool();
    const card = (await this.accountCards()).find((c) => c.accountId === accountId);
    if (card === undefined) return null;
    const titles = this.#library.titlesForAccount(accountId);
    const files = this.#library.filesForAccount(accountId);
    const activity = this.#library.activityForAccount(accountId);
    const lastSeenAt = files.length > 0 ? Math.max(...files.map((f) => f.seenAt)) : null;
    return {
      ...card,
      titles,
      activity,
      ageDays:
        lastSeenAt === null
          ? null
          : Math.max(0, Math.floor((Date.now() - lastSeenAt) / 86_400_000)),
    };
  }

  /**
   * The library page, batch-loaded. One query for all titles, one query for
   * all files (down from 3N queries previously), all derived state computed
   * once.
   */
  libraryView(): { cards: LibraryCard[]; kpis: { movies: number; series: number; uhd: number; fhd: number; torn: number; total: number } } {
    const pool = this.#getPool();
    const cdnBroken = new Set(
      pool.statuses().filter((s) => s.cdnHealthy === false).map((s) => s.accountId),
    );
    const titles = this.#library.listTitles();
    const byTitle = this.#library.filesForTitles(titles.map((t) => t.key));
    const cards: LibraryCard[] = titles.map((t) => {
      const files = byTitle.get(t.key) ?? [];
      const accounts = [...new Set(files.map((f) => f.accountId))];
      const isUhd = t.bestResolution !== null && t.bestResolution >= 2160;
      const isFhd = t.bestResolution !== null && t.bestResolution >= 1080 && t.bestResolution < 2160;
      const isHd = t.bestResolution !== null && t.bestResolution >= 720 && t.bestResolution < 1080;
      const resClass: LibraryCard['resClass'] = isUhd
        ? 'res-4k'
        : isFhd
          ? 'res-1080p'
          : isHd
            ? 'res-720p'
            : 'res-sd';
      const allTorn = accounts.length > 0 && accounts.every((a) => cdnBroken.has(a));
      const someTorn = accounts.some((a) => cdnBroken.has(a));
      return {
        title: t,
        files,
        accounts,
        torn: allTorn ? 'all' : someTorn ? 'some' : 'none',
        isUhd,
        isFhd,
        resClass,
      };
    });
    return {
      cards,
      kpis: {
        movies: cards.filter((c) => c.title.kind === 'movie').length,
        series: cards.filter((c) => c.title.kind === 'series').length,
        uhd: cards.filter((c) => c.isUhd).length,
        fhd: cards.filter((c) => c.isFhd).length,
        torn: cards.filter((c) => c.torn !== 'none').length,
        total: cards.length,
      },
    };
  }

  /**
   * The fleet page: per-account health, used bar, stream count, and the
   * per-account library rows. Distinct from `accountCards()` in that it
   * serves a table, not a card grid, and includes credential emails.
   */
  async fleetRows(): Promise<{
    rows: Array<{
      accountId: string;
      email: string;
      status: AccountStatus;
      library: { titles: number; files: number; bytes: number };
    }>;
  }> {
    const pool = this.#getPool();
    const cards = await this.accountCards();
    return { rows: cards.map((c) => ({ accountId: c.accountId, email: c.email, status: c.status, library: c.library })) };
  }
}

/** Re-exported so the public surface stays small. */
export type { SubtitleFile };
export { formatBytes };
