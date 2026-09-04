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
// Imported from its own module rather than re-exported through admin/app.ts:
// this module is the mutation layer and must not depend on the rendering
// layer, which would be a cycle now that the file/transfer handlers live here.
import { magnetDisplayName } from '../admin/magnet-name.ts';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function ok<T>(data: T): Response {
  return json({ ok: true, data });
}

/**
 * A failed action.
 *
 * The status code matters. These endpoints used to answer 200 with
 * `{ ok: false }`, which meant a caller had to parse the body to learn that
 * nothing happened — and any intermediary (a proxy error page, an auth
 * challenge, a truncated response) was indistinguishable from success. The
 * client now checks the status first, so failures must carry a real one:
 *
 *   400  the request was malformed or the input was rejected
 *   404  the named account, file, or transfer does not exist
 *   409  the pool cannot satisfy the request right now (no capacity)
 *   502  Seedr itself failed or refused
 */
function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, { status });
}

/** Seedr (or the network to it) failed. Distinct from a bad request. */
function upstream(message: string): Response {
  return bad(message, 502);
}

export interface MagnetIngestResult {
  /** Account the magnet was placed on. */
  accountId: string;
  /** Magnet display name (`dn=` from the magnet), when present. */
  displayName: string | null;
  /** Seedr's transfer id, useful for tracking. */
  transferId: string;
  /**
   * Free space on the receiving account after the placement, in bytes, or
   * null when Seedr would not tell us.
   *
   * This used to be `Number.MAX_SAFE_INTEGER` behind a comment calling it a
   * "best-effort placeholder" — a fabricated number sent to the client and
   * rendered as if it were measured. A value we do not have is null.
   */
  freeAfter: number | null;
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
  /**
   * In-flight torrents cancelled.
   *
   * Purge used to delete only folders and files. An actively downloading
   * torrent lives in Seedr's `torrents` list, not the folder tree, so it
   * survived the purge and re-materialized as a folder minutes later —
   * making the purge look like it silently failed.
   */
  transfersCancelled: number;
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
  /**
   * Dumps that were written but are missing a section. Distinct from
   * `errors`: the file exists and records why the section failed, but its
   * numbers are not the account's real state.
   */
  incomplete: number;
  incompleteMessages: string[];
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
      return upstream(`Pool refresh failed: ${err instanceof Error ? err.message : String(err)}`);
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

        // Real number or null. Asking Seedr costs one request and gives the
        // operator the one figure they actually want after an ingest; a
        // failure here must not fail the ingest that already succeeded.
        let freeAfter: number | null = null;
        try {
          const quota = await allocation.provider.getQuota();
          freeAfter = quota.free;
        } catch {
          freeAfter = null;
        }

        results.push({
          accountId: allocation.accountId,
          displayName,
          transferId: transfer.id,
          freeAfter,
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

    // A request where nothing at all landed is a failure, and must say so
    // with a status code rather than a 200 carrying `ok:false`.
    if (results.length === 0) {
      const first = failures[0]?.error ?? 'No magnet could be queued.';
      const noCapacity = failures.some((f) => f.error.startsWith('No healthy account has space'));
      return json(
        { ok: false, error: first, data: { results, failures, queuedAt: Date.now() } },
        { status: noCapacity ? 409 : 502 },
      );
    }

    // Partial success stays a 200: some magnets are queued and the client
    // must render both the successes and the per-line failures.
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
      return bad(`Account ${accountId} not found.`, 404);
    }
    // `writeCredentials` leaves a tombstone in this account's slot, so the
    // accounts below it keep their ids and their library rows.
    try {
      await writeCredentials(this.#credentialsPath, filtered);
    } catch (err) {
      return bad(`Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    this.#getLibrary().recordActivity('info', `Account removed: ${accountId}`);
    await this.#onAccountsChanged();
    const result: AccountDeleteResult = { accountId, remaining: filtered.length };
    return ok(result);
  }

  /**
   * Wipes an account: cancels its in-flight torrents, deletes its folders
   * and files, then drops its library rows.
   *
   * Order matters. Cancelling transfers first stops a torrent that is
   * mid-download from finishing and re-creating a folder after the folder
   * sweep has already run — which is why a purge used to appear to silently
   * fail and the files came back minutes later.
   */
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
        transfersCancelled: 0,
        libraryDeleted: removed,
        failed: 0,
      };
      return ok(result);
    }
    let deleted = 0;
    let cancelled = 0;
    let failed = 0;

    // 1. Cancel in-flight torrents. A failure to list them is not fatal —
    //    the folder sweep below is still worth attempting — but it is
    //    counted so the operator sees the purge was not clean.
    try {
      for (const transfer of await provider.listTransfers()) {
        try { await provider.deleteTransfer(transfer.id); cancelled += 1; } catch { failed += 1; }
      }
    } catch {
      failed += 1;
    }

    // 2. Sweep folders and files.
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
      return upstream(`Could not list folders on ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const removed = this.#getLibrary().deleteAccountFiles(accountId);
    // The pool's cached quota and transfer list both describe a state that
    // no longer exists.
    pool.invalidateTransfers();
    this.#getLibrary().recordActivity(
      failed > 0 ? 'warn' : 'success',
      `Purged ${accountId}: ${deleted} Seedr item${deleted === 1 ? '' : 's'}, ` +
        `${cancelled} transfer${cancelled === 1 ? '' : 's'}, ` +
        `${removed} library row${removed === 1 ? '' : 's'}`,
      failed > 0 ? `${failed} Seedr items failed` : 'ok',
    );
    const result: AccountPurgeResult = {
      accountId,
      seedrDeleted: deleted,
      transfersCancelled: cancelled,
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
      return bad(`Account ${email} already in the pool.`, 409);
    }
    const probe = new SeedrV1Provider({ id: '__probe__', email, password });
    try {
      const health = await probe.healthCheck();
      if (!health.healthy) {
        return bad(`Seedr rejected these credentials: ${health.reason ?? 'unknown reason'}`);
      }
    } catch (err) {
      return upstream(`Seedr login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The next free slot, not `accounts.length + 1`. With a tombstone in the
    // file those differ, and reusing a retired slot would hand the new
    // account the deleted one's library rows.
    const newAccount: AccountCredential = {
      id: `acc${credentials.highestSlot + 1}`,
      email,
      password,
    };
    const updated = [...credentials.accounts, newAccount];
    try {
      await writeCredentials(this.#credentialsPath, updated);
    } catch (err) {
      return bad(`Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    this.#getLibrary().recordActivity('info', `Account added: ${newAccount.id}`, email);
    await this.#onAccountsChanged();
    const result: AccountAddResult = { accountId: newAccount.id, email };
    return ok(result);
  }

  /**
   * Replaces the password for an existing account.
   *
   * This is the recovery path for an account whose credentials went bad —
   * previously the only fix was hand-editing the credentials file on the
   * host, even though the admin already surfaced `needsReauth`.
   *
   * The replacement is **in place**. Account ids are positional (line 1 is
   * `acc1`) and the library index stores those ids, so a delete-then-append
   * would renumber every account after this one and silently orphan their
   * library rows. `writeCredentials` is given the same array with one
   * element's password swapped.
   *
   * The new password is verified against Seedr before anything is written,
   * so a typo cannot lock the account out worse than it already is.
   */
  async reauthAccount(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '').trim();
    const password = String(form.get('password') ?? '').trim();
    if (!accountId) return bad('Missing accountId.');
    if (!password) return bad('Password required.');

    const credentials = this.#getCredentials();
    const index = credentials.accounts.findIndex((a) => a.id === accountId);
    if (index === -1) return bad(`Account ${accountId} not found.`, 404);
    const existing = credentials.accounts[index];
    if (existing === undefined) return bad(`Account ${accountId} not found.`, 404);

    // Verify before persisting. A fresh provider instance is used so the
    // pool's cached (rejected) credentials do not short-circuit the probe:
    // SeedrV1Provider latches `#credentialsRejected` after a bad password
    // and refuses to retry, which is correct for the pool and wrong here.
    const probe = new SeedrV1Provider({ id: '__reauth__', email: existing.email, password });
    try {
      const health = await probe.healthCheck();
      if (!health.healthy) {
        return bad(`Seedr rejected this password: ${health.reason ?? 'unknown reason'}`);
      }
    } catch (err) {
      return upstream(`Seedr login failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const updated = credentials.accounts.map((a, i) =>
      i === index ? { ...a, password } : a,
    );
    try {
      await writeCredentials(this.#credentialsPath, updated);
    } catch (err) {
      return bad(`Failed to write credentials: ${err instanceof Error ? err.message : String(err)}`, 500);
    }

    // Never log the password, only that it changed.
    this.#getLibrary().recordActivity('success', `Password updated for ${accountId}`, existing.email);
    await this.#onAccountsChanged();
    const result: AccountReauthResult = { accountId, reauthed: true, reason: null };
    return ok(result);
  }

  async runDump(): Promise<Response> {
    const r = await this.#runDump();
    // A dump where every file failed is not a success.
    if (r.written === 0 && r.errors > 0) {
      return json({ ok: false, error: r.errorMessages[0] ?? 'Dump failed.', data: r }, { status: 502 });
    }
    return ok(r);
  }

  async reload(): Promise<Response> {
    try {
      await this.#onAccountsChanged();
    } catch (err) {
      return upstream(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return ok({ reloaded: true, accounts: this.#getCredentials().accounts.length });
  }

  async reindex(): Promise<Response> {
    void this.#indexer.scanAll().then(() => this.#enricher.tick());
    this.#getLibrary().recordActivity('info', 'Reindex started');
    return ok({ started: true, scope: 'all' });
  }

  /**
   * Reindexes a single account.
   *
   * The account detail page's "Reindex this account" button used to post to
   * the pool-wide endpoint, so it rescanned all eight accounts and the label
   * was a lie. Scoping it matters more as the pool grows: at 50 accounts a
   * full scan is 50 folder walks to refresh one.
   */
  async reindexAccount(ctx: RouteContext): Promise<Response> {
    const accountId = ctx.params['accountId'] ?? '';
    if (!accountId) return bad('Missing accountId.');
    const provider = this.#getPool().provider(accountId);
    if (!provider) return bad(`Unknown account ${accountId}.`, 404);
    // Awaited rather than fire-and-forget: the caller asked about one
    // account, so the counts are worth reporting back in the toast.
    try {
      const result = await this.#indexer.scanAccount(provider);
      void this.#enricher.tick();
      if (result.error !== undefined) {
        return upstream(`Scan failed on ${accountId}: ${result.error}`);
      }
      this.#getLibrary().recordActivity(
        'info',
        `Reindexed ${accountId}`,
        `${result.videos} videos, ${result.subtitles} subtitles, ${result.pruned} pruned`,
      );
      return ok({
        accountId,
        scope: 'account',
        videos: result.videos,
        subtitles: result.subtitles,
        pruned: result.pruned,
      });
    } catch (err) {
      return upstream(err instanceof Error ? err.message : String(err));
    }
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

  // ------------------------------------------------------------------
  // File, transfer, and magnet mutations.
  //
  // These lived on `AdminApp` alongside the HTML rendering, which meant
  // provider access was split across two modules and the two halves drifted:
  // the copies in the admin answered 200 with `{ok:false}` on failure while
  // the ones here used status codes. They are here now, so `admin/app.ts`
  // renders and this module mutates.
  // ------------------------------------------------------------------

  /** Cancels a torrent that is still downloading. */
  async deleteTransfer(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    const transferId = String(form.get('transferId') ?? '');
    if (!accountId || !transferId) return bad('Missing accountId or transferId.');
    const provider = this.#getPool().provider(accountId);
    if (!provider) return bad(`Unknown account ${accountId}.`, 404);
    try {
      await provider.deleteTransfer(transferId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#getLibrary().recordActivity('bad', `Cancel failed on ${accountId}`, message);
      return upstream(`Seedr refused to cancel the transfer: ${message}`);
    }
    this.#getPool().invalidateTransfers();
    this.#getLibrary().recordActivity('info', `Transfer removed from ${accountId}`, transferId);
    return ok({ accountId, transferId });
  }

  /**
   * Deletes one file from Seedr and from the library.
   *
   * The library row is only dropped once Seedr has confirmed the delete. The
   * other order would leave a file playing in Stremio that the admin claims
   * does not exist.
   */
  async deleteFile(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const accountId = String(form.get('accountId') ?? '');
    const fileId = String(form.get('fileId') ?? '');
    if (!accountId || !fileId) return bad('Missing accountId or fileId.');
    const provider = this.#getPool().provider(accountId);
    if (!provider) return bad(`Unknown account ${accountId}.`, 404);
    try {
      await provider.deleteFile(fileId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#getLibrary().recordActivity('bad', `Delete failed on ${accountId}/${fileId}`, message);
      return upstream(`Seedr delete failed: ${message}`);
    }
    this.#getLibrary().deleteFileRow(accountId, fileId);
    this.#getLibrary().recordActivity('info', `File deleted from ${accountId}`, fileId);
    return ok({ accountId, fileId });
  }

  /** Re-queues a magnet the library already knows about. */
  async reAddMagnet(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const displayName = String(form.get('displayName') ?? '').trim();
    if (displayName === '') return bad('Missing display name.');
    const record = this.#getLibrary().magnetForFolder(displayName);
    if (record === null) return bad(`No stored magnet for "${displayName}".`, 404);
    const pool = this.#getPool();
    try {
      await pool.refresh();
    } catch (err) {
      return upstream(`Pool refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const allocation = pool.allocate(0);
      const transfer = await allocation.provider.addMagnet(record.magnet);
      this.#getLibrary().recordMagnet(displayName, record.magnet, allocation.accountId);
      this.#getLibrary().recordActivity('info', `Re-added to ${allocation.accountId}`, displayName);
      pool.invalidateTransfers();
      void this.#indexer.scanAccount(allocation.provider).then(() => this.#enricher.tick());
      return ok({ accountId: allocation.accountId, transferId: transfer.id, displayName });
    } catch (err) {
      if (err instanceof NoCapacityError) {
        return bad('No healthy account has space. Free some storage first.', 409);
      }
      return upstream(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Moves a file to another account by re-adding its magnet there and
   * deleting the source copy.
   *
   * The copy is created before the source is deleted, so a failure leaves
   * two copies rather than none. When the source delete fails the response
   * is still a success — the move did happen — but `sourceDeleted` is false
   * and the client says so, because silently leaving a duplicate behind is
   * how an account fills up with no explanation.
   */
  async moveFile(ctx: RouteContext): Promise<Response> {
    const form = await ctx.request.formData();
    const sourceAccount = String(form.get('accountId') ?? '');
    const fileId = String(form.get('fileId') ?? '');
    if (sourceAccount === '' || fileId === '') return bad('Missing accountId or fileId.');
    const library = this.#getLibrary();
    const file = library.findFile(sourceAccount, fileId);
    if (file === null) return bad(`File ${sourceAccount}/${fileId} not found.`, 404);
    if (file.magnet === null) {
      return bad('No stored magnet for this file, so it cannot be re-queued elsewhere.');
    }
    const pool = this.#getPool();
    try {
      await pool.refresh();
    } catch (err) {
      return upstream(`Pool refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let allocation;
    try {
      allocation = pool.allocate(0);
    } catch (err) {
      if (err instanceof NoCapacityError) return bad('No healthy account has space.', 409);
      return upstream(err instanceof Error ? err.message : String(err));
    }
    if (allocation.accountId === sourceAccount) {
      return bad('Pool picked the same account. Every other account is full or unhealthy.', 409);
    }

    let transferId: string;
    try {
      const transfer = await allocation.provider.addMagnet(file.magnet);
      transferId = transfer.id;
    } catch (err) {
      return upstream(err instanceof Error ? err.message : String(err));
    }

    const sourceProvider = pool.provider(sourceAccount);
    let deleted = false;
    let deleteError: string | null = null;
    if (sourceProvider !== undefined) {
      try {
        await sourceProvider.deleteFile(fileId);
        library.deleteFileRow(sourceAccount, fileId);
        deleted = true;
      } catch (err) {
        deleteError = err instanceof Error ? err.message : String(err);
      }
    } else {
      deleteError = `source account ${sourceAccount} is no longer in the pool`;
    }

    const displayName = magnetDisplayName(file.magnet);
    if (displayName !== null) library.recordMagnet(displayName, file.magnet, allocation.accountId);
    library.recordActivity(
      deleted ? 'success' : 'warn',
      `Moved ${displayName ?? file.name} → ${allocation.accountId}`,
      deleted ? 'Source deleted.' : `Source not deleted: ${deleteError ?? 'unknown'}`,
    );
    pool.invalidateTransfers();
    void this.#indexer.scanAccount(allocation.provider).then(() => this.#enricher.tick());
    return ok({
      accountId: allocation.accountId,
      transferId,
      sourceDeleted: deleted,
      sourceError: deleteError,
    });
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
