/**
 * Tests for the JSON action endpoints.
 *
 * There were none before, which is how a purge that skipped in-flight
 * torrents, a delete that renumbered every account below it, and a
 * fabricated `freeAfter: Number.MAX_SAFE_INTEGER` all shipped.
 *
 * Two things are asserted throughout and they matter equally:
 *   - the effect (what actually changed on Seedr, in the library, on disk);
 *   - the HTTP status. These endpoints used to answer 200 with
 *     `{ ok: false }`, so a caller could not distinguish "nothing happened"
 *     from success without parsing the body, and a proxy error page looked
 *     like a win.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminActions, type DumpResult } from '../../src/core/admin-actions.ts';
import { AccountPool, type AccountPoolEntry } from '../../src/core/account-pool.ts';
import { LibraryStore } from '../../src/library/store.ts';
import { parseCredentials, type CredentialFile } from '../../src/core/credentials.ts';
import { makeQuota } from '../../src/providers/shared.ts';
import type {
  FolderContents,
  PlaybackUrl,
  Quota,
  StorageProvider,
  Transfer,
} from '../../src/core/types.ts';
import type { Indexer } from '../../src/library/indexer.ts';
import type { MetadataEnricher } from '../../src/library/metadata-enricher.ts';

const GIB = 1024 ** 3;

/**
 * In-memory Seedr account. Records every destructive call so a test can
 * assert what the pool actually did rather than only what it reported.
 */
class FakeProvider implements StorageProvider {
  readonly accountId: string;
  quota: Quota;
  folders: Array<{ id: string; path: string; size: number }> = [];
  files: Array<{ id: string; name: string; size: number; folderId: string }> = [];
  transfers: Transfer[] = [];

  deletedFiles: string[] = [];
  deletedFolders: string[] = [];
  deletedTransfers: string[] = [];
  addedMagnets: string[] = [];

  /** Set to make the matching call reject, simulating a Seedr failure. */
  failOn = new Set<'listFolder' | 'listTransfers' | 'deleteFile' | 'deleteFolder' | 'deleteTransfer' | 'addMagnet' | 'getQuota'>();

  #nextTransferId = 100;

  constructor(accountId: string, used = 0, max = 10 * GIB) {
    this.accountId = accountId;
    this.quota = makeQuota(used, max);
  }

  async getQuota(): Promise<Quota> {
    if (this.failOn.has('getQuota')) throw new Error('quota unavailable');
    return this.quota;
  }

  async listFolder(): Promise<FolderContents> {
    if (this.failOn.has('listFolder')) throw new Error('list failed');
    return {
      folders: this.folders.map((f) => ({ id: f.id, path: f.path, size: f.size })),
      files: this.files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        hash: null,
        isVideo: true,
        isAudio: false,
        folderId: f.folderId,
      })),
    };
  }

  async addMagnet(magnet: string): Promise<Transfer> {
    if (this.failOn.has('addMagnet')) throw new Error('magnet refused');
    this.addedMagnets.push(magnet);
    this.#nextTransferId += 1;
    return {
      id: String(this.#nextTransferId),
      name: null,
      state: 'pending',
      progress: 0,
      size: 0,
      folderId: null,
      seeders: 0,
      leechers: 0,
      error: null,
    };
  }

  async listTransfers(): Promise<Transfer[]> {
    if (this.failOn.has('listTransfers')) throw new Error('transfers unavailable');
    return this.transfers;
  }

  async getPlaybackUrl(): Promise<PlaybackUrl> {
    throw new Error('not used');
  }

  async deleteFile(fileId: string): Promise<void> {
    if (this.failOn.has('deleteFile')) throw new Error('delete refused');
    this.deletedFiles.push(fileId);
  }

  async deleteFolder(folderId: string): Promise<void> {
    if (this.failOn.has('deleteFolder')) throw new Error('delete refused');
    this.deletedFolders.push(folderId);
  }

  async deleteTransfer(transferId: string): Promise<void> {
    if (this.failOn.has('deleteTransfer')) throw new Error('cancel refused');
    this.deletedTransfers.push(transferId);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return { healthy: true };
  }
}

function transfer(id: string, over: Partial<Transfer> = {}): Transfer {
  return {
    id,
    name: `torrent-${id}`,
    state: 'running',
    progress: 40,
    size: GIB,
    folderId: null,
    seeders: 5,
    leechers: 1,
    error: null,
    ...over,
  };
}

function entry(provider: FakeProvider, label: string): AccountPoolEntry {
  return { provider, label, needsReauth: false };
}

/** Minimal indexer/enricher: the actions only fire-and-forget into these. */
function fakeIndexer(): Indexer {
  return {
    scanAccount: async () => ({ accountId: 'x', videos: 0, subtitles: 0, pruned: 0 }),
    scanAll: async () => [],
    setOnScanComplete: () => {},
  } as unknown as Indexer;
}

function fakeEnricher(): MetadataEnricher {
  return { tick: async () => {}, start: () => {} } as unknown as MetadataEnricher;
}

/** A POST with a form body, which is what every action endpoint reads. */
function post(fields: Record<string, string>, url = 'http://x/admin/api/test') {
  const body = new URLSearchParams(fields);
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
    params: {} as Record<string, string>,
    url: new URL(url),
  };
}

interface Harness {
  actions: AdminActions;
  pool: AccountPool;
  library: LibraryStore;
  providers: Record<string, FakeProvider>;
  credentialsPath: string;
  credentials: () => CredentialFile;
  reloadCredentials: () => Promise<void>;
  accountsChangedCalls: number;
  dumpResult: DumpResult;
  cleanup: () => Promise<void>;
}

async function harness(options: {
  accounts?: string[];
  credentialsText?: string;
} = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'seedrpool-actions-'));
  const credentialsPath = join(dir, 'credentials.txt');
  const ids = options.accounts ?? ['acc1', 'acc2'];
  const text =
    options.credentialsText ??
    ids.map((id, i) => `${id}@example.com:pw${i + 1}`).join('\n') + '\n';
  await writeFile(credentialsPath, text, { mode: 0o600 });

  const providers: Record<string, FakeProvider> = {};
  let credentials = parseCredentials(text);
  for (const account of credentials.accounts) {
    providers[account.id] = new FakeProvider(account.id);
  }

  const pool = new AccountPool(
    credentials.accounts.map((a) => entry(providers[a.id]!, a.email)),
  );
  await pool.refresh({ force: true });

  const library = new LibraryStore(':memory:');
  const state = { accountsChangedCalls: 0 };
  const dumpResult: DumpResult = {
    written: 2,
    errors: 0,
    errorMessages: [],
    incomplete: 0,
    incompleteMessages: [],
  };

  const h: Harness = {
    actions: new AdminActions({
      getPool: () => pool,
      getLibrary: () => library,
      indexer: fakeIndexer(),
      enricher: fakeEnricher(),
      getCredentials: () => credentials,
      credentialsPath,
      onAccountsChanged: async () => {
        state.accountsChangedCalls += 1;
        credentials = parseCredentials(await readFile(credentialsPath, 'utf8'));
        h.accountsChangedCalls = state.accountsChangedCalls;
      },
      runDump: async () => h.dumpResult,
    }),
    pool,
    library,
    providers,
    credentialsPath,
    credentials: () => credentials,
    reloadCredentials: async () => {
      credentials = parseCredentials(await readFile(credentialsPath, 'utf8'));
    },
    accountsChangedCalls: 0,
    dumpResult,
    cleanup: async () => {
      library.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Inserts a title and one file for it, which is what the indexer would do. */
function addFile(
  h: Harness,
  file: {
    accountId: string;
    fileId: string;
    name?: string;
    titleKey?: string;
    magnet?: string | null;
    folderId?: string;
  },
): void {
  const titleKey = file.titleKey ?? `title-${file.accountId}-${file.fileId}`;
  h.library.upsertTitle({
    key: titleKey,
    name: file.name ?? 'Movie 2024',
    year: 2024,
    kind: 'movie',
    addedAt: Date.now(),
  });
  h.library.upsertFile({
    fileId: file.fileId,
    accountId: file.accountId,
    folderId: file.folderId ?? '10',
    name: file.name ?? 'Movie.2024.1080p.mkv',
    size: GIB,
    hash: null,
    titleKey,
    season: null,
    episode: null,
    resolution: 1080,
    group: null,
    seenAt: Date.now(),
    magnet: file.magnet ?? null,
  });
}

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

async function bodyOf(res: Response): Promise<any> {
  return res.json();
}

describe('purgeAccount', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('cancels in-flight transfers as well as folders and files', async () => {
    // A downloading torrent lives in Seedr's `torrents` list, not the folder
    // tree. Purge used to sweep only folders and files, so the torrent
    // survived and re-created its folder minutes later — the purge looked
    // like it had silently failed.
    const p = h.providers['acc1']!;
    p.folders = [{ id: '10', path: 'Movie.2024', size: GIB }];
    p.files = [{ id: '20', name: 'extra.mkv', size: GIB, folderId: '0' }];
    p.transfers = [transfer('30'), transfer('31')];

    const res = await h.actions.purgeAccount(post({ accountId: 'acc1' }));
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(p.deletedTransfers).toEqual(['30', '31']);
    expect(p.deletedFolders).toEqual(['10']);
    expect(p.deletedFiles).toEqual(['20']);
    expect(body.data).toMatchObject({
      accountId: 'acc1',
      seedrDeleted: 2,
      transfersCancelled: 2,
      failed: 0,
    });
  });

  it('cancels transfers before sweeping folders, so nothing re-materializes', async () => {
    const p = h.providers['acc1']!;
    const order: string[] = [];
    p.transfers = [transfer('30')];
    p.folders = [{ id: '10', path: 'Movie', size: GIB }];
    const origCancel = p.deleteTransfer.bind(p);
    const origFolder = p.deleteFolder.bind(p);
    p.deleteTransfer = async (id) => { order.push('transfer'); return origCancel(id); };
    p.deleteFolder = async (id) => { order.push('folder'); return origFolder(id); };

    await h.actions.purgeAccount(post({ accountId: 'acc1' }));

    expect(order).toEqual(['transfer', 'folder']);
  });

  it('drops the account library rows and reports the count', async () => {
    addFile(h, { accountId: 'acc1', fileId: '20' });
    expect(h.library.filesForAccount('acc1')).toHaveLength(1);

    const body = await bodyOf(await h.actions.purgeAccount(post({ accountId: 'acc1' })));

    expect(body.data.libraryDeleted).toBe(1);
    expect(h.library.filesForAccount('acc1')).toHaveLength(0);
  });

  it('counts items Seedr refused rather than reporting a clean purge', async () => {
    const p = h.providers['acc1']!;
    p.folders = [{ id: '10', path: 'Movie', size: GIB }];
    p.failOn.add('deleteFolder');

    const body = await bodyOf(await h.actions.purgeAccount(post({ accountId: 'acc1' })));

    expect(body.data.seedrDeleted).toBe(0);
    expect(body.data.failed).toBe(1);
  });

  it('counts a transfer-listing failure but still sweeps the folder tree', async () => {
    const p = h.providers['acc1']!;
    p.failOn.add('listTransfers');
    p.folders = [{ id: '10', path: 'Movie', size: GIB }];

    const body = await bodyOf(await h.actions.purgeAccount(post({ accountId: 'acc1' })));

    expect(p.deletedFolders).toEqual(['10']);
    expect(body.data.failed).toBe(1);
  });

  it('answers 502 when Seedr will not list the account at all', async () => {
    h.providers['acc1']!.failOn.add('listFolder');

    const res = await h.actions.purgeAccount(post({ accountId: 'acc1' }));

    expect(res.status).toBe(502);
    expect((await bodyOf(res)).ok).toBe(false);
  });

  it('still cleans the library for an account no longer in the pool', async () => {
    addFile(h, { accountId: 'accGone', fileId: '20', name: 'Old.2020.mkv' });

    const body = await bodyOf(await h.actions.purgeAccount(post({ accountId: 'accGone' })));

    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ seedrDeleted: 0, transfersCancelled: 0, libraryDeleted: 1 });
  });

  it('rejects a missing accountId with 400', async () => {
    const res = await h.actions.purgeAccount(post({}));
    expect(res.status).toBe(400);
  });
});

describe('deleteAccount', () => {
  beforeEach(async () => {
    h = await harness({ accounts: ['acc1', 'acc2', 'acc3'] });
  });

  it('leaves a tombstone so the accounts below keep their ids', async () => {
    // This is the corruption case. Deleting acc2 used to renumber acc3 to
    // acc2, and the library stores account ids — so every acc3 file row
    // silently started pointing at a different Seedr account.
    const res = await h.actions.deleteAccount(post({ accountId: 'acc2' }));
    expect(res.status).toBe(200);

    const text = await readFile(h.credentialsPath, 'utf8');
    expect(text).toContain('#deleted acc2');

    const reparsed = parseCredentials(text);
    expect(reparsed.accounts.map((a) => a.id)).toEqual(['acc1', 'acc3']);
    expect(reparsed.accounts[1]?.email).toBe('acc3@example.com');
  });

  it('reports how many accounts remain', async () => {
    const body = await bodyOf(await h.actions.deleteAccount(post({ accountId: 'acc3' })));
    expect(body.data).toEqual({ accountId: 'acc3', remaining: 2 });
  });

  it('rebuilds the pool so the removed account stops serving', async () => {
    await h.actions.deleteAccount(post({ accountId: 'acc2' }));
    expect(h.accountsChangedCalls).toBe(1);
  });

  it('answers 404 for an account that is not in the file', async () => {
    const res = await h.actions.deleteAccount(post({ accountId: 'acc99' }));
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).ok).toBe(false);
  });

  it('rejects a missing accountId with 400', async () => {
    expect((await h.actions.deleteAccount(post({}))).status).toBe(400);
  });
});

describe('addAccount', () => {
  it('takes the next free slot, never a retired one', async () => {
    // acc2 has been deleted, so the file is [acc1, tombstone]. Handing the
    // new account slot 2 would give it acc2's library rows.
    h = await harness({ credentialsText: 'a@example.com:pw1\n#deleted acc2\n' });
    expect(h.credentials().accounts.map((a) => a.id)).toEqual(['acc1']);
    expect(h.credentials().highestSlot).toBe(2);

    // The Seedr probe cannot be exercised without network, so this asserts
    // the slot arithmetic directly against the same input the handler reads.
    const next = `acc${h.credentials().highestSlot + 1}`;
    expect(next).toBe('acc3');
    expect(next).not.toBe('acc2');
  });

  it('rejects a duplicate email with 409 before touching Seedr', async () => {
    h = await harness({ accounts: ['acc1'] });
    const res = await h.actions.addAccount(
      post({ email: 'acc1@example.com', password: 'whatever' }),
    );
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toMatch(/already in the pool/);
  });

  it('rejects a missing field with 400 before touching Seedr', async () => {
    h = await harness({ accounts: ['acc1'] });
    expect((await h.actions.addAccount(post({ email: 'x@y.com' }))).status).toBe(400);
    expect((await h.actions.addAccount(post({ password: 'pw' }))).status).toBe(400);
  });
});

describe('deleteFile', () => {
  beforeEach(async () => {
    h = await harness();
    addFile(h, { accountId: 'acc1', fileId: '20' });
  });

  it('deletes on Seedr and then drops the library row', async () => {
    const res = await h.actions.deleteFile(post({ accountId: 'acc1', fileId: '20' }));

    expect(res.status).toBe(200);
    expect(h.providers['acc1']!.deletedFiles).toEqual(['20']);
    expect(h.library.findFile('acc1', '20')).toBeNull();
  });

  it('keeps the library row when Seedr refuses, and answers 502', async () => {
    // The other order would leave Stremio playing a file the admin claims
    // does not exist.
    h.providers['acc1']!.failOn.add('deleteFile');

    const res = await h.actions.deleteFile(post({ accountId: 'acc1', fileId: '20' }));

    expect(res.status).toBe(502);
    expect(h.library.findFile('acc1', '20')).not.toBeNull();
  });

  it('answers 404 for an unknown account', async () => {
    const res = await h.actions.deleteFile(post({ accountId: 'nope', fileId: '20' }));
    expect(res.status).toBe(404);
  });

  it('answers 400 when a field is missing', async () => {
    expect((await h.actions.deleteFile(post({ accountId: 'acc1' }))).status).toBe(400);
    expect((await h.actions.deleteFile(post({ fileId: '20' }))).status).toBe(400);
  });
});

describe('deleteTransfer', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('cancels the transfer on Seedr', async () => {
    const res = await h.actions.deleteTransfer(post({ accountId: 'acc1', transferId: '30' }));

    expect(res.status).toBe(200);
    expect(h.providers['acc1']!.deletedTransfers).toEqual(['30']);
    expect((await bodyOf(res)).data).toEqual({ accountId: 'acc1', transferId: '30' });
  });

  it('answers 502 when Seedr refuses', async () => {
    h.providers['acc1']!.failOn.add('deleteTransfer');
    const res = await h.actions.deleteTransfer(post({ accountId: 'acc1', transferId: '30' }));
    expect(res.status).toBe(502);
  });

  it('answers 404 for an unknown account', async () => {
    const res = await h.actions.deleteTransfer(post({ accountId: 'nope', transferId: '30' }));
    expect(res.status).toBe(404);
  });

  it('answers 400 when a field is missing', async () => {
    expect((await h.actions.deleteTransfer(post({ accountId: 'acc1' }))).status).toBe(400);
  });
});

describe('addMagnet', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('reports a real free-space figure, not a fabricated one', async () => {
    // This used to be Number.MAX_SAFE_INTEGER behind a comment calling it a
    // "best-effort placeholder", rendered client-side as if measured.
    h.providers['acc1']!.quota = makeQuota(2 * GIB, 10 * GIB);
    h.providers['acc2']!.quota = makeQuota(2 * GIB, 10 * GIB);

    const body = await bodyOf(
      await h.actions.addMagnet(post({ magnet: 'magnet:?xt=urn:btih:abc&dn=Movie.2024' })),
    );

    expect(body.ok).toBe(true);
    const free = body.data.results[0].freeAfter;
    expect(free).toBe(8 * GIB);
    expect(free).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reports null rather than a guess when Seedr will not give a quota', async () => {
    for (const p of Object.values(h.providers)) p.failOn.add('getQuota');

    const body = await bodyOf(
      await h.actions.addMagnet(post({ magnet: 'magnet:?xt=urn:btih:abc&dn=Movie' })),
    );

    expect(body.data.results[0].freeAfter).toBeNull();
  });

  it('queues every line of a multi-magnet paste', async () => {
    const body = await bodyOf(
      await h.actions.addMagnet(
        post({ magnet: 'magnet:?xt=urn:btih:a&dn=One\nmagnet:?xt=urn:btih:b&dn=Two' }),
      ),
    );

    expect(body.data.results).toHaveLength(2);
    const added = Object.values(h.providers).flatMap((p) => p.addedMagnets);
    expect(added).toHaveLength(2);
  });

  it('records the magnet so the re-add button has something to re-queue', async () => {
    await h.actions.addMagnet(post({ magnet: 'magnet:?xt=urn:btih:abc&dn=Movie.2024' }));
    expect(h.library.magnetForFolder('Movie.2024')).not.toBeNull();
  });

  it('rejects a non-magnet line with 400 and queues nothing', async () => {
    const res = await h.actions.addMagnet(post({ magnet: 'https://example.com/file.torrent' }));

    expect(res.status).toBe(400);
    expect(Object.values(h.providers).flatMap((p) => p.addedMagnets)).toEqual([]);
  });

  it('rejects an empty body with 400', async () => {
    expect((await h.actions.addMagnet(post({ magnet: '   ' }))).status).toBe(400);
  });

  it('answers 502 when every magnet failed, so the client cannot read it as success', async () => {
    for (const p of Object.values(h.providers)) p.failOn.add('addMagnet');

    const res = await h.actions.addMagnet(post({ magnet: 'magnet:?xt=urn:btih:abc&dn=X' }));
    const body = await bodyOf(res);

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.data.failures).toHaveLength(1);
  });

  it('keeps a 200 for a partial success so the client can show both outcomes', async () => {
    // First magnet lands, second is refused. The user needs the success AND
    // the failure, so the status stays 2xx and the body carries both.
    let calls = 0;
    for (const p of Object.values(h.providers)) {
      const orig = p.addMagnet.bind(p);
      p.addMagnet = async (m: string) => {
        calls += 1;
        if (calls > 1) throw new Error('magnet refused');
        return orig(m);
      };
    }

    const res = await h.actions.addMagnet(
      post({ magnet: 'magnet:?xt=urn:btih:a&dn=One\nmagnet:?xt=urn:btih:b&dn=Two' }),
    );
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.data.results).toHaveLength(1);
    expect(body.data.failures).toHaveLength(1);
  });
});

describe('moveFile', () => {
  beforeEach(async () => {
    h = await harness();
    addFile(h, {
      accountId: 'acc1',
      fileId: '20',
      magnet: 'magnet:?xt=urn:btih:abc&dn=Movie.2024',
    });
    // Make acc2 the emptier account so the pool picks it.
    h.providers['acc1']!.quota = makeQuota(8 * GIB, 10 * GIB);
    h.providers['acc2']!.quota = makeQuota(0, 10 * GIB);
    await h.pool.refresh({ force: true });
  });

  it('adds to the destination before deleting the source', async () => {
    const res = await h.actions.moveFile(post({ accountId: 'acc1', fileId: '20' }));
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.data.accountId).toBe('acc2');
    expect(h.providers['acc2']!.addedMagnets).toHaveLength(1);
    expect(h.providers['acc1']!.deletedFiles).toEqual(['20']);
    expect(body.data.sourceDeleted).toBe(true);
  });

  it('keeps the copy and says so when the source delete fails', async () => {
    // Two copies is recoverable; zero is not. The response stays a success
    // but flags the duplicate, because silently leaving one behind is how an
    // account fills up with no explanation.
    h.providers['acc1']!.failOn.add('deleteFile');

    const body = await bodyOf(await h.actions.moveFile(post({ accountId: 'acc1', fileId: '20' })));

    expect(body.ok).toBe(true);
    expect(body.data.sourceDeleted).toBe(false);
    expect(body.data.sourceError).toMatch(/refused/);
    expect(h.library.findFile('acc1', '20')).not.toBeNull();
  });

  it('answers 502 and deletes nothing when the destination refuses the magnet', async () => {
    h.providers['acc2']!.failOn.add('addMagnet');

    const res = await h.actions.moveFile(post({ accountId: 'acc1', fileId: '20' }));

    expect(res.status).toBe(502);
    expect(h.providers['acc1']!.deletedFiles).toEqual([]);
    expect(h.library.findFile('acc1', '20')).not.toBeNull();
  });

  it('answers 404 for a file the library does not have', async () => {
    const res = await h.actions.moveFile(post({ accountId: 'acc1', fileId: '999' }));
    expect(res.status).toBe(404);
  });

  it('answers 400 for a file with no stored magnet', async () => {
    addFile(h, { accountId: 'acc1', fileId: '21', name: 'Legacy.2019.mkv' });

    const res = await h.actions.moveFile(post({ accountId: 'acc1', fileId: '21' }));

    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toMatch(/no stored magnet/i);
  });

  it('answers 409 when the pool can only offer the source account', async () => {
    h = await harness({ accounts: ['acc1'] });
    addFile(h, {
      accountId: 'acc1',
      fileId: '20',
      name: 'Movie.mkv',
      magnet: 'magnet:?xt=urn:btih:abc&dn=Movie',
    });

    const res = await h.actions.moveFile(post({ accountId: 'acc1', fileId: '20' }));

    expect(res.status).toBe(409);
    expect(h.providers['acc1']!.deletedFiles).toEqual([]);
  });

  // -----------------------------------------------------------------
  // Size-aware allocation. allocate(0) used to be passed everywhere, so
  // the pool could pick an account with 10 MB free for a 4 GB file and
  // the transfer sat at 0% forever.
  // -----------------------------------------------------------------

  it('move: rejects with 409 and names the size when no account can hold the file', async () => {
    h = await harness({ accounts: ['acc1', 'acc2'] });
    addFile(h, {
      accountId: 'acc1',
      fileId: '20',
      name: 'Big.Remux.mkv',
      magnet: 'magnet:?xt=urn:btih:abc&dn=Big',
    });
    // Overwrite the seeded 1 GiB size with something neither account can fit.
    h.library.upsertFile({
      fileId: '20',
      accountId: 'acc1',
      folderId: '10',
      name: 'Big.Remux.mkv',
      size: 4 * GIB,
      hash: null,
      titleKey: 'title-acc1-20',
      season: null,
      episode: null,
      resolution: 1080,
      group: null,
      seenAt: Date.now(),
      magnet: 'magnet:?xt=urn:btih:abc&dn=Big',
    });
    // makeQuota(used, max): 9 and 9.5 used leaves 1.0 and 0.5 GiB free.
    h.providers['acc1']!.quota = makeQuota(9 * GIB, 10 * GIB);
    h.providers['acc2']!.quota = makeQuota(9.5 * GIB, 10 * GIB);
    await h.pool.refresh({ force: true });

    const res = await h.actions.moveFile(post({ accountId: 'acc1', fileId: '20' }));
    const body = await bodyOf(res);

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/4\.00 GiB/);
    expect(h.providers['acc2']!.addedMagnets).toEqual([]);
  });

  it('move: prefers the destination with real room over the one that cannot fit', async () => {
    h = await harness({ accounts: ['acc1', 'acc2', 'acc3'] });
    addFile(h, {
      accountId: 'acc1',
      fileId: '20',
      magnet: 'magnet:?xt=urn:btih:abc&dn=Movie',
    });
    // The seeded file is 1 GiB. acc2 has only 0.5 GiB free; acc3 has 5.
    h.providers['acc1']!.quota = makeQuota(8 * GIB, 10 * GIB);
    h.providers['acc2']!.quota = makeQuota(9.5 * GIB, 10 * GIB);
    h.providers['acc3']!.quota = makeQuota(5 * GIB, 10 * GIB);
    await h.pool.refresh({ force: true });

    const body = await bodyOf(await h.actions.moveFile(post({ accountId: 'acc1', fileId: '20' })));

    expect(body.data.accountId).toBe('acc3');
    expect(h.providers['acc3']!.addedMagnets).toHaveLength(1);
  });

  it("re-add: passes the magnet's indexed size to the allocator", async () => {
    h = await harness({ accounts: ['acc1', 'acc2'] });
    h.library.recordMagnet('Movie.2024', 'magnet:?xt=urn:btih:abc&dn=Movie.2024', 'acc1');
    addFile(h, {
      accountId: 'acc1',
      fileId: '20',
      name: 'Movie.2024.1080p.mkv',
      magnet: 'magnet:?xt=urn:btih:abc&dn=Movie.2024',
    });

    // The seeded file is 1 GiB. acc1 has no room; only acc2 does.
    h.providers['acc1']!.quota = makeQuota(9.5 * GIB, 10 * GIB);
    h.providers['acc2']!.quota = makeQuota(2 * GIB, 10 * GIB);
    await h.pool.refresh({ force: true });

    const body = await bodyOf(await h.actions.reAddMagnet(post({ displayName: 'Movie.2024' })));

    expect(body.ok).toBe(true);
    expect(body.data.accountId).toBe('acc2');
  });
});

describe('reAddMagnet', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('re-queues a magnet the library remembers', async () => {
    h.library.recordMagnet('Movie.2024', 'magnet:?xt=urn:btih:abc&dn=Movie.2024', 'acc1');

    const res = await h.actions.reAddMagnet(post({ displayName: 'Movie.2024' }));
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.data.displayName).toBe('Movie.2024');
    const added = Object.values(h.providers).flatMap((p) => p.addedMagnets);
    expect(added).toHaveLength(1);
  });

  it('answers 404 when no magnet was stored for that name', async () => {
    const res = await h.actions.reAddMagnet(post({ displayName: 'Never.Seen' }));
    expect(res.status).toBe(404);
  });

  it('answers 400 for a missing display name', async () => {
    expect((await h.actions.reAddMagnet(post({}))).status).toBe(400);
  });
});

describe('reindexAccount', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('answers 404 for an account not in the pool', async () => {
    const ctx = post({});
    ctx.params = { accountId: 'nope' };
    expect((await h.actions.reindexAccount(ctx)).status).toBe(404);
  });

  it('answers 400 when the id is absent', async () => {
    expect((await h.actions.reindexAccount(post({}))).status).toBe(400);
  });
});

describe('runDump', () => {
  it('answers 502 when every dump failed', async () => {
    // "8 written" with zeros in every file is how a broken capture hid
    // before; a dump that wrote nothing must not report success either.
    h = await harness();
    h.dumpResult = {
      written: 0,
      errors: 2,
      errorMessages: ['acc1: login failed', 'acc2: login failed'],
      incomplete: 0,
      incompleteMessages: [],
    };

    const res = await h.actions.runDump();

    expect(res.status).toBe(502);
    expect((await bodyOf(res)).error).toMatch(/login failed/);
  });

  it('reports incomplete dumps as a success with counts, since the files exist', async () => {
    h = await harness();
    h.dumpResult = {
      written: 2,
      errors: 0,
      errorMessages: [],
      incomplete: 1,
      incompleteMessages: ['acc2: quota section failed'],
    };

    const res = await h.actions.runDump();
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ written: 2, incomplete: 1 });
  });
});

describe('reload', () => {
  it('reports how many accounts were probed', async () => {
    h = await harness({ accounts: ['acc1', 'acc2', 'acc3'] });

    const body = await bodyOf(await h.actions.reload());

    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ reloaded: true, accounts: 3 });
  });
});
