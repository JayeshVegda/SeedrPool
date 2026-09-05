import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminActions } from '../../src/core/admin-actions.ts';
import { LibraryStore } from '../../src/library/store.ts';
import { AccountPool, type AccountPoolEntry } from '../../src/core/account-pool.ts';
import { makeQuota } from '../../src/providers/shared.ts';
import { parseCredentials, writeCredentials, type CredentialFile } from '../../src/core/credentials.ts';
import type {
  FolderContents,
  PlaybackUrl,
  Quota,
  RemoteFile,
  RemoteFolder,
  StorageProvider,
  Transfer,
} from '../../src/core/types.ts';
import type { Indexer } from '../../src/library/indexer.ts';
import type { MetadataEnricher } from '../../src/library/metadata-enricher.ts';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The movies-only ingest guard, the empty-folder cleanup, and the
 * outside-content flag. Each is a small behavior with a story; these pin the
 * story so a refactor cannot silently change it.
 */

const GIB = 1024 ** 3;

class FakeProvider implements StorageProvider {
  readonly accountId: string;
  quota: Quota;
  files: Array<{ id: string; name: string; size: number; folderId: string; isVideo?: boolean }> = [];
  folders: Array<{ id: string; name: string }> = [];
  transfers: Transfer[] = [];
  deletedFiles: string[] = [];
  deletedFolders: string[] = [];
  addedMagnets: string[] = [];

  constructor(accountId: string, used = 0, max = 10 * GIB) {
    this.accountId = accountId;
    this.quota = makeQuota(used, max);
  }

  async getQuota(): Promise<Quota> { return this.quota; }

  async listFolder(folderId: string | null): Promise<FolderContents> {
    const id = folderId ?? '0';
    const folders: RemoteFolder[] = this.folders
      .filter((f) => (id === '0' ? true : false))
      .map((f) => ({ id: f.id, path: f.name, size: 0, name: f.name }));
    const files = this.files
      .filter((f) => f.folderId === id)
      .map((f) => this.#file(f.id, f.name, f.size, f.folderId, f.isVideo ?? true));
    if (id === '0') {
      return { folders, files };
    }
    return { folders: [], files };
  }

  #file(id: string, name: string, size: number, folderId: string, isVideo: boolean): RemoteFile {
    return { id, name, size, hash: null, isVideo, isAudio: false, folderId };
  }

  async addMagnet(magnet: string): Promise<Transfer> {
    this.addedMagnets.push(magnet);
    return {
      id: String(100 + this.addedMagnets.length),
      name: null, state: 'pending', progress: 0, size: 0, folderId: null,
      seeders: 0, leechers: 0, error: null,
    };
  }

  async listTransfers(): Promise<Transfer[]> { return this.transfers; }
  async getPlaybackUrl(): Promise<PlaybackUrl> { throw new Error('not used'); }
  async deleteFile(id: string): Promise<void> {
    this.deletedFiles.push(id);
    this.files = this.files.filter((f) => f.id !== id);
  }
  async deleteFolder(id: string): Promise<void> {
    this.deletedFolders.push(id);
    this.folders = this.folders.filter((f) => f.id !== id);
  }
  async deleteTransfer(id: string): Promise<void> {
    this.transfers = this.transfers.filter((t) => t.id !== id);
  }
  async healthCheck(): Promise<{ healthy: boolean }> { return { healthy: true }; }
}

function fakeIndexer(): Indexer {
  return { scanAccount: async () => ({ accountId: 'x', videos: 0, subtitles: 0, pruned: 0 }), scanAll: async () => [], setOnScanComplete: () => {} } as unknown as Indexer;
}
function fakeEnricher(): MetadataEnricher {
  return { tick: async () => {}, start: () => {} } as unknown as MetadataEnricher;
}

function post(fields: Record<string, string>, url = 'http://x/admin/api/test') {
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    }),
    params: {} as Record<string, string>,
    url: new URL(url),
  };
}

let dir: string;
let providers: Record<string, FakeProvider>;
let library: LibraryStore;
let actions: AdminActions;
let pool: AccountPool;
let credentials: CredentialFile;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seedrpool-guard-'));
  const credentialsPath = join(dir, 'credentials.txt');
  await writeFile(credentialsPath, 'a@example.com:pw1\nb@example.com:pw2\n', { mode: 0o600 });
  credentials = parseCredentials(await readFile(credentialsPath, 'utf8'));

  providers = {};
  for (const acc of credentials.accounts) providers[acc.id] = new FakeProvider(acc.id);
  pool = new AccountPool(
    credentials.accounts.map((a) => ({
      provider: providers[a.id]!,
      label: a.email,
      needsReauth: false,
    } as AccountPoolEntry)),
  );
  await pool.refresh({ force: true });
  library = new LibraryStore(':memory:');

  actions = new AdminActions({
    getPool: () => pool,
    getLibrary: () => library,
    indexer: fakeIndexer(),
    enricher: fakeEnricher(),
    getCredentials: () => credentials,
    credentialsPath,
    onAccountsChanged: async () => {},
    runDump: async () => ({
      written: 0, errors: 0, errorMessages: [], incomplete: 0, incompleteMessages: [],
    }),
  });
});

afterEach(async () => {
  library.close();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------

describe('movies-only ingest guard', () => {
  it('rejects an episode magnet before touching the pool', async () => {
    const res = await actions.addMagnet(
      post({ magnet: 'magnet:?xt=urn:btih:a&dn=Show.Name.S01E02.1080p.mkv' }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/movies only/i);
    expect(body.error).toMatch(/S01E02/);
    // Nothing was queued.
    expect(Object.values(providers).flatMap((p) => p.addedMagnets)).toEqual([]);
  });

  it('rejects a season-pack magnet', async () => {
    const res = await actions.addMagnet(
      post({ magnet: 'magnet:?xt=urn:btih:b&dn=Some.Show.Season.3.720p' }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/movies only/i);
  });

  it('rejects a series mixed into a multi-magnet paste, before anything queues', async () => {
    const res = await actions.addMagnet(
      post({ magnet: 'magnet:?xt=urn:btih:c&dn=A.Movie.2023.1080p\nmagnet:?xt=urn:btih:d&dn=Show.S01E05.720p' }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/movies only/i);
    expect(Object.values(providers).flatMap((p) => p.addedMagnets)).toEqual([]);
  });

  it('accepts a movie', async () => {
    const res = await actions.addMagnet(
      post({ magnet: 'magnet:?xt=urn:btih:e&dn=Oppenheimer.2023.1080p.BluRay' }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.results).toHaveLength(1);
  });

  it('accepts a magnet with no episode markers at all', async () => {
    // No SxxExx, no season pack, no verbose form — treated as a movie and
    // let through; a wrong guess is one delete, a missed movie is a missing
    // library entry.
    const res = await actions.addMagnet(
      post({ magnet: 'magnet:?xt=urn:btih:f&dn=Some.Oddly.Named.Release' }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------

describe('empty-folder cleanup', () => {
  it('deletes the parent folder when the last file in it is deleted', async () => {
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'A.Movie.2023' }];
    p.files = [{ id: '20', name: 'A.Movie.2023.1080p.mkv', size: GIB, folderId: '10' }];

    library.upsertTitle({ key: 'amovie-2023', name: 'A Movie', year: 2023, kind: 'movie', addedAt: 1 });
    library.upsertFile({
      fileId: '20', accountId: 'acc1', folderId: '10', name: 'A.Movie.2023.1080p.mkv',
      size: GIB, hash: null, titleKey: 'amovie-2023', season: null, episode: null,
      resolution: 1080, group: null, seenAt: 1, magnet: null,
    });

    const body = await (await actions.deleteFile(post({ accountId: 'acc1', fileId: '20' }))).json();
    expect(body.ok).toBe(true);
    expect(body.data.folderRemoved).toBe(true);
    expect(p.deletedFolders).toEqual(['10']);
    expect(p.folders).toEqual([]);
  });

  it('keeps the folder when other files remain in it', async () => {
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'Pack' }];
    p.files = [
      { id: '20', name: 'part1.mkv', size: GIB, folderId: '10' },
      { id: '21', name: 'part2.mkv', size: GIB, folderId: '10' },
    ];
    library.upsertTitle({ key: 'pack', name: 'Pack', year: null, kind: 'movie', addedAt: 1 });
    for (const id of ['20', '21']) {
      library.upsertFile({
        fileId: id, accountId: 'acc1', folderId: '10', name: `part.mkv`,
        size: GIB, hash: null, titleKey: 'pack', season: null, episode: null,
        resolution: null, group: null, seenAt: 1, magnet: null,
      });
    }

    const body = await (await actions.deleteFile(post({ accountId: 'acc1', fileId: '20' }))).json();
    expect(body.data.folderRemoved).toBe(false);
    expect(p.deletedFolders).toEqual([]);
  });

  it('a Seedr refusal of the folder delete does not fail the file delete', async () => {
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'Solo' }];
    p.files = [{ id: '20', name: 'solo.mkv', size: GIB, folderId: '10' }];
    library.upsertTitle({ key: 'solo', name: 'Solo', year: null, kind: 'movie', addedAt: 1 });
    library.upsertFile({
      fileId: '20', accountId: 'acc1', folderId: '10', name: 'solo.mkv',
      size: GIB, hash: null, titleKey: 'solo', season: null, episode: null,
      resolution: null, group: null, seenAt: 1, magnet: null,
    });
    // listFolder on a folder throws — Seedr hiccup on the hygiene check.
    const orig = p.listFolder.bind(p);
    p.listFolder = async (id: string | null) => {
      if (id === '10') throw new Error('Seedr hiccup');
      return orig(id);
    };

    const res = await actions.deleteFile(post({ accountId: 'acc1', fileId: '20' }));
    const body = await res.json();
    // The delete itself still reports success; hygiene is best-effort.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.folderRemoved).toBe(false);
    expect(p.deletedFiles).toEqual(['20']);
  });
});

// ---------------------------------------------------------------------

describe('outside-content flag', () => {
  it('appears when a scan sees a new file with no magnet on record', async () => {
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'Friend.Downloaded.This' }];
    p.files = [{ id: '30', name: 'Friend.Downloaded.This.1080p.mkv', size: GIB, folderId: '10' }];

    // Run a real scan: the fake pool's provider is a StorageProvider.
    const { Indexer } = await import('../../src/library/indexer.ts');
    const indexer = new Indexer(library, () => pool);
    const result = await indexer.scanAccount(p);

    expect(result.videos).toBe(1);
    const flagged = library.externalContent();
    expect(flagged.get('acc1')?.example).toBe('Friend.Downloaded.This.1080p.mkv');
    expect(flagged.get('acc1')?.firstSeenAt).toBeGreaterThan(0);
  });

  it('does not flag a file queued through SeedrPool (magnet on record)', async () => {
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'Our.Movie.2023' }];
    p.files = [{ id: '40', name: 'Our.Movie.2023.1080p.mkv', size: GIB, folderId: '10' }];
    library.recordMagnet('Our.Movie.2023', 'magnet:?xt=urn:btih:ours&dn=Our.Movie.2023', 'acc1');

    const { Indexer } = await import('../../src/library/indexer.ts');
    const indexer = new Indexer(library, () => pool);
    await indexer.scanAccount(p);

    expect(library.externalContent().has('acc1')).toBe(false);
  });

  it('does not re-flag on rescan of the same external file', async () => {
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'Once' }];
    p.files = [{ id: '50', name: 'Once.2020.mkv', size: GIB, folderId: '10' }];

    const { Indexer } = await import('../../src/library/indexer.ts');
    const indexer = new Indexer(library, () => pool);
    await indexer.scanAccount(p);
    const first = library.externalContent().get('acc1')!;
    await indexer.scanAccount(p);

    // Same first-seen timestamp: the row was not rewritten.
    expect(library.externalContent().get('acc1')?.firstSeenAt).toBe(first.firstSeenAt);
    // And exactly one activity entry, not one per scan.
    const entries = library
      .recentActivity(50)
      .filter((a) => a.message === 'Outside content on acc1');
    expect(entries).toHaveLength(1);
  });

  it('legacy files that pre-date the magnets table are not flagged', async () => {
    // A file already in the index (from an old deploy) whose folder has no
    // magnet must not look like fresh outside content on every scan.
    const p = providers['acc1']!;
    p.folders = [{ id: '10', name: 'Ancient' }];
    p.files = [{ id: '60', name: 'Ancient.1999.mkv', size: GIB, folderId: '10' }];
    library.upsertTitle({ key: 'ancient', name: 'Ancient', year: 1999, kind: 'movie', addedAt: 1 });
    library.upsertFile({
      fileId: '60', accountId: 'acc1', folderId: '10', name: 'Ancient.1999.mkv',
      size: GIB, hash: null, titleKey: 'ancient', season: null, episode: null,
      resolution: null, group: null, seenAt: 1, magnet: null,
    });

    const { Indexer } = await import('../../src/library/indexer.ts');
    const indexer = new Indexer(library, () => pool);
    await indexer.scanAccount(p);

    expect(library.externalContent().has('acc1')).toBe(false);
  });

  it('purge clears the flag along with everything else', async () => {
    library.flagExternalContent('acc1', 'something');
    expect(library.externalContent().has('acc1')).toBe(true);

    await actions.purgeAccount(post({ accountId: 'acc1' }));
    expect(library.externalContent().has('acc1')).toBe(false);
  });
});
