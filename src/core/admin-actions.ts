/**
 * JSON action endpoints.
 *
 * The previous admin posted forms and treated every response as a full HTML
 * page, so a successful ingest replaced the entire dashboard with a stub
 * `Done` page showing the transfer id. The user could not see what they
 * actually did.
 *
 * This module returns JSON for the action endpoints. Clients render a toast
 * with the real outcome — account, torrent name, free space after, link
 * to the file — and stay on the same page. Server-rendered HTML is still
 * the page shape; the actions are the only JSON.
 *
 * The convention: an action endpoint lives at `POST /admin/api/<verb>` and
 * always returns `{ ok: true, ... }` or `{ ok: false, error: "..." }`. The
 * HTML it would have rendered is the "fallback" path for clients that
 * cannot run JS.
 */

import type { AccountPool } from './account-pool.ts';
import type { LibraryStore } from '../library/store.ts';
import type { Indexer } from '../library/indexer.ts';
import type { MetadataEnricher } from '../library/metadata-enricher.ts';
import { json, type RouteContext } from './router.ts';
import { NoCapacityError } from './account-pool.ts';
import { SeedrV1Provider } from '../providers/seedr-v1.ts';
import { writeCredentials, type AccountCredential, type CredentialFile } from './credentials.ts';
import { magnetDisplayName } from '../admin/app.ts';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function ok<T>(data: T): Response {
  return json({ ok: true, data });
}
function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, { status });
}

export interface MagnetIngestResult {
  /** Account the magnet was placed on. */
  accountId: string;
  /** Magnet display name (`dn=` from the magnet), when present. */
  displayName: string | null;
  /** Seedr's transfer id, useful for tracking. */
  transferId: string;
  /** Free space on the receiving account after the placement. */
  freeAfter: number;
  /** Magnet URI for copy-to-clipboard. */
  magnet: string;
  /** When the transfer was queued, unix ms. */
  queuedAt: number;
}

export interface AccountDeleteResult {
  accountId: string;
  remaining: number;
}

export interface AccountPurgeResult {
  accountId: string;
  /** Items removed from Seedr (folders + files). */
  seedrDeleted: number;
  /** Library rows dropped because the account was wiped. */
  libraryDeleted: number;
  /** Items Seedr refused to delete, usually because of an upstream error. */
  failed: number;
}

export interface AccountAddResult {
  accountId: string;
  email: string;
}

export interface DumpResult {
  written: number;
  errors: number;
  errorMessages: string[];
}

export interface AccountReauthResult {
  accountId: string;
  reauthed: boolean;
  reason: string | null;
}

export class AdminActions {
  #getPool: () => AccountPool;
  #getLibrary: () => LibraryStore;
  #indexer: Indexer;
  #enricher: MetadataEnricher;
  #getCredentials: () => CredentialFile;
  #credentialsPath: string;
  #onAccountsChanged: () => Promise<void>;
  #runDump: () => Promise<DumpResult>;

  constructor(deps: {
    getPool: () => AccountPool;
    getLibrary: () => LibraryStore;
    indexer: Indexer;
    enricher: MetadataEnricher;
    getCredentials: () => CredentialFile;
    credentialsPath: string;
    onAccountsChanged: () => Promise<void>;
    runDump: () => Promise<DumpResult>;
  }) {
    this.#getPool = deps.getPool;
    this.#getLibrary = deps.getLibrary;
    this.#indexer = deps.indexer;
    this.#enricher = deps.enricher;
    this.#getCredentials = deps.getCredentials;
    this.#credentialsPath = deps.credentialsPath;
    this.#onAccountsChanged = deps.onAccountsChanged;
    this.#runDump = deps.runDump;
  }

  /**
   * One or more magnet URIs in a single request. Returns one row per magnet,
   * so a paste of five lines yields five toasts. Errors on individual lines
   * do not abort the rest.
   */
  async addMagnet(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const raw = String(form.get('magnet') ?? '').trim();
    if (raw === '') return bad('No magnet lines found.');
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    if (lines.some((l) => !l.startsWith('magnet:'))) {
      const badLine = lines.find((l) => !l.startsWith('magnet:'));
      return bad(`Not a magnet link: "${(badLine ?? '').slice(0, 60)}…"`);
    }

    const pool = this.#getPool();
    const library = this.#getLibrary();
    try {
      await pool.refresh();
    } catch (err) {
      return bad(`Pool refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const results: MagnetIngestResult[] = [];
    const failures: Array<{ magnet: string; error: string }> = [];

    for (const magnet of lines) {
      try {
        const allocation = pool.allocate(0);
        const transfer = await allocation.provider.addMagnet(magnet);
        const displayName = magnetDisplayName(magnet);
        if (displayName !== null) library.recordMagnet(displayName, magnet, allocation.accountId);
        library.recordActivity(
          'info',
          `Magnet added to ${allocation.accountId}`,
          displayName ?? transfer.id,
        );
        void this.#indexer.scanAccount(allocation.provider).then(() => this.#enricher.tick());
        results.push({
          accountId: allocation.accountId,
          displayName,
          transferId: transfer.id,
          freeAfter: allocation.provider
            ? Math.max(0, Number.MAX_SAFE_INTEGER) // best-effort placeholder
            : 0,
          magnet,
          queuedAt: Date.now(),
        });
        // Refresh quota so the next call sees up-to-date free space.
        pool.invalidateTransfers();
      } catch (err) {
        if (err instanceof NoCapacityError) {
          failures.push({ magnet, error: `No healthy account has space (${results.length} of ${lines.length} added).` });
          break;
        }
        failures.push({ magnet, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return json({
      ok: failures.length === 0,
      data: { results, failures, queuedAt: Date.now() },
    });
  }

  async deleteAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    if (!accountId) return bad('Missing accountId.');
    const filtered = this.#getCredentials().accounts.filter((a) => a.id !== accountId);
    if (filtered.length === this.#getCredentials().accounts.length) {
      return bad(`Account ${accountId} not found.`);
    }
    try {
      await writeCredentials(this.#credentialsPath, filtered);
    } catch (err) {
      return bad(`Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#getLibrary().recordActivity('info', `Account removed: ${accountId}`);
    await this.#onAccountsChanged();
    const result: AccountDeleteResult = { accountId, remaining: filtered.length };
    return ok(result);
  }

  async purgeAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    if (!accountId) return bad('Missing accountId.');
    const pool = this.#getPool();
    const provider = pool.provider(accountId);
    if (!provider) {
      // Already removed: clean the library.
      const removed = this.#getLibrary().deleteAccountFiles(accountId);
      this.#getLibrary().recordActivity(
        'warn',
        `Purged ${accountId} from library (not in pool)`,
        `${removed} files`,
      );
      const result: AccountPurgeResult = {
        accountId,
        seedrDeleted: 0,
        libraryDeleted: removed,
        failed: 0,
      };
      return ok(result);
    }
    let deleted = 0;
    let failed = 0;
    try {
      const root = await provider.listFolder(null);
      for (const f of root.folders) {
        try { await provider.deleteFolder(f.id); deleted += 1; } catch { failed += 1; }
      }
      for (const f of root.files) {
        try { await provider.deleteFile(f.id); deleted += 1; } catch { failed += 1; }
      }
    } catch (err) {
      this.#getLibrary().recordActivity(
        'bad',
        `Purge ${accountId} failed`,
        err instanceof Error ? err.message : String(err),
      );
      return bad(`Could not list folders on ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const removed = this.#getLibrary().deleteAccountFiles(accountId);
    this.#getLibrary().recordActivity(
      failed > 0 ? 'warn' : 'success',
      `Purged ${accountId}: ${deleted} Seedr item${deleted === 1 ? '' : 's'}, ${removed} library row${removed === 1 ? '' : 's'}`,
      failed > 0 ? `${failed} Seedr items failed` : 'ok',
    );
    const result: AccountPurgeResult = {
      accountId,
      seedrDeleted: deleted,
      libraryDeleted: removed,
      failed,
    };
    return ok(result);
  }

  async addAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '').trim();
    if (!email || !password) return bad('Email and password required.');
    const credentials = this.#getCredentials();
    if (credentials.accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      return bad(`Account ${email} already in the pool.`);
    }
    const probe = new SeedrV1Provider({ id: '__probe__', email, password });
    try {
      const ok = await probe.healthCheck();
      if (!ok.healthy) {
        return bad(`Seedr rejected these credentials: ${ok.reason ?? 'unknown reason'}`);
      }
    } catch (err) {
      return bad(`Seedr login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const newAccount: AccountCredential = {
      id: `acc${credentials.accounts.length + 1}`,
      email,
      password,
    };
    const updated = [...credentials.accounts, newAccount];
    try {
      await writeCredentials(this.#credentialsPath, updated);
    } catch (err) {
      return bad(`Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#getLibrary().recordActivity('info', `Account added: ${newAccount.id}`, email);
    await this.#onAccountsChanged();
    const result: AccountAddResult = { accountId: newAccount.id, email };
    return ok(result);
  }

  async runDump(): Promise<Response> {
    const r = await this.#runDump();
    return ok(r);
  }

  async reload(): Promise<Response> {
    await this.#onAccountsChanged();
    return ok({ reloaded: true });
  }

  async reindex(): Promise<Response> {
    void this.#indexer.scanAll().then(() => this.#enricher.tick());
    this.#getLibrary().recordActivity('info', 'Reindex started');
    return ok({ started: true });
  }

  async enrichAll(): Promise<Response> {
    const titles = this.#getLibrary().titlesNeedingLookup();
    void this.#enricher.tick();
    return ok({ queued: titles.length });
  }

  async clearMetadataAll(): Promise<Response> {
    const n = this.#getLibrary().clearAllTitleIds();
    void this.#enricher.tick();
    this.#getLibrary().recordActivity('info', 'Metadata reset for re-fetch', `${n} titles`);
    return ok({ cleared: n });
  }

  async clearMetadataOne(ctx: RouteContext): Promise<Response> {
    const titleKey = ctx.params['titleKey'] ?? '';
    if (!titleKey) return bad('Missing title key.');
    this.#getLibrary().clearTitleIds(titleKey);
    void this.#enricher.tick();
    return ok({ titleKey });
  }

  /**
   * Convenience: a uniform wrapper so route handlers stay one line.
   * `ctx` is the standard route context.
   */
  static wrap<T>(fn: (ctx: RouteContext) => Promise<T>): (ctx: RouteContext) => Promise<Response> {
    return async (ctx) => {
      try {
        return ok(await fn(ctx));
      } catch (err) {
        return bad(err instanceof Error ? err.message : String(err));
      }
    };
  }
}

export type { Result };
