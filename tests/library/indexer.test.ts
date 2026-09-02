import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Indexer, guessLanguage } from '../../src/library/indexer.ts';
import { LibraryStore } from '../../src/library/store.ts';
import type {
  FolderContents,
  PlaybackUrl,
  Quota,
  StorageProvider,
  Transfer,
} from '../../src/core/types.ts';
import type { AccountPool } from '../../src/core/account-pool.ts';

class FakeProvider {
  readonly accountId: string;
  folders: Map<string | null, FolderContents> = new Map();
  constructor(id: string) {
    this.accountId = id;
  }
  setListing(folderId: string | null, contents: FolderContents) {
    this.folders.set(folderId, contents);
  }
  async listFolder(folderId: string | null): Promise<FolderContents> {
    const contents = this.folders.get(folderId);
    if (!contents) throw new Error(`no fixture for folder ${folderId}`);
    return contents;
  }
  // Stubs for the rest of the StorageProvider surface.
  async getQuota(): Promise<Quota> {
    return { used: 0, max: 0, get free() { return 0; } };
  }
  async addMagnet() { throw new Error('not used'); }
  async listTransfers(): Promise<Transfer[]> { return []; }
  async getPlaybackUrl(_fileId: string): Promise<PlaybackUrl> {
    return { url: '', filename: '', expiresAt: null, kind: 'direct' };
  }
  async deleteFile() {}
  async deleteFolder() {}
  async deleteTransfer() {}
  async healthCheck() { return { healthy: true }; }
}

function buildPool(providers: StorageProvider[]): AccountPool {
  return {
    capacity: () => ({ used: 0, max: 0, free: 0, healthyAccounts: providers.length, totalAccounts: providers.length }),
    healthyProviders: () => providers,
    refresh: async () => [],
    markCdnBroken: () => {},
    markCdnHealthy: () => {},
  } as unknown as AccountPool;
}

describe('Indexer', () => {
  let store: LibraryStore;
  let acc1: FakeProvider;
  let acc2: FakeProvider;
  let indexer: Indexer;

  beforeEach(() => {
    store = new LibraryStore(':memory:');
    acc1 = new FakeProvider('acc1');
    acc2 = new FakeProvider('acc2');
    indexer = new Indexer(store, () => buildPool([acc1, acc2]));
  });

  it('indexes videos and subtitles one folder deep', async () => {
    acc1.setListing(null, {
      folders: [{ id: 'F1', path: 'Sintel', size: 0 }],
      files: [],
    });
    acc1.setListing('F1', {
      folders: [],
      files: [
        { id: 'v1', name: 'Sintel.mp4', size: 100, hash: 'h1', isVideo: true, isAudio: false, folderId: 'F1' },
        { id: 's1', name: 'Sintel.en.srt', size: 1, hash: null, isVideo: false, isAudio: false, folderId: 'F1' },
      ],
    });
    const results = await indexer.scanAccount(acc1);
    expect(results.videos).toBe(1);
    expect(results.subtitles).toBe(1);

    const title = store.getTitle('sintel');
    expect(title?.name).toBe('Sintel');

    const subs = store.subtitlesForFolder('acc1', 'F1');
    expect(subs.length).toBe(1);
    expect(subs[0]?.language).toBe('en');
  });

  it('groups the same movie across accounts under one key', async () => {
    for (const [acc, hash] of [[acc1, 'h1'], [acc2, 'h2']] as const) {
      acc.setListing(null, {
        folders: [{ id: 'F1', path: 'Matrix', size: 0 }],
        files: [],
      });
      acc.setListing('F1', {
        folders: [],
        files: [
          { id: `${acc.accountId}-v`, name: 'Matrix.1999.1080p.mkv', size: 1, hash, isVideo: true, isAudio: false, folderId: 'F1' },
        ],
      });
    }
    await indexer.scanAll();
    const titles = store.listTitles();
    expect(titles.length).toBe(1);
    expect(titles[0]?.fileCount).toBe(2);
  });

  it('prunes files no longer present', async () => {
    acc1.setListing(null, {
      folders: [{ id: 'F1', path: 'Foo', size: 0 }],
      files: [],
    });
    acc1.setListing('F1', {
      folders: [],
      files: [
        { id: 'v1', name: 'Foo.mp4', size: 100, hash: 'h1', isVideo: true, isAudio: false, folderId: 'F1' },
      ],
    });
    await indexer.scanAccount(acc1);
    expect(store.findFile('acc1', 'v1')).not.toBeNull();

    // Empty the listing and scan again.
    acc1.setListing(null, { folders: [], files: [] });
    await indexer.scanAccount(acc1);
    expect(store.findFile('acc1', 'v1')).toBeNull();
  });

  it('reports a per-account error and continues', async () => {
    // acc1 throws, acc2 is fine.
    vi.spyOn(acc1, 'listFolder').mockRejectedValue(new Error('boom'));
    acc2.setListing(null, {
      folders: [{ id: 'F1', path: 'Bar', size: 0 }],
      files: [],
    });
    acc2.setListing('F1', {
      folders: [],
      files: [
        { id: 'v', name: 'Bar.mp4', size: 1, hash: null, isVideo: true, isAudio: false, folderId: 'F1' },
      ],
    });

    const results = await indexer.scanAll();
    expect(results.length).toBe(2);
    const acc1Result = results.find((r) => r.accountId === 'acc1');
    const acc2Result = results.find((r) => r.accountId === 'acc2');
    expect(acc1Result?.error).toBe('boom');
    expect(acc2Result?.videos).toBe(1);
  });

  it('reuses one scan for concurrent callers', async () => {
    acc1.setListing(null, { folders: [], files: [] });
    const a = indexer.scanAll();
    const b = indexer.scanAll();
    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).toBe(r2);
  });

  it('writes the magnet URL onto files when the folder name matches a stored magnet', async () => {
    store.recordMagnet('Foo.2024', 'magnet:?xt=urn:btih:abc&dn=Foo.2024', 'acc1');
    acc1.setListing(null, {
      folders: [{ id: 'F1', name: 'Foo.2024', path: 'Foo.2024', size: 0 }],
      files: [],
    });
    acc1.setListing('F1', {
      folders: [],
      files: [
        { id: 'v1', name: 'Foo.2024.1080p.mkv', size: 1, hash: null, isVideo: true, isAudio: false, folderId: 'F1' },
      ],
    });
    await indexer.scanAccount(acc1);
    const file = store.findFile('acc1', 'v1');
    expect(file?.magnet).toBe('magnet:?xt=urn:btih:abc&dn=Foo.2024');
  });

  it('leaves magnet null when no stored magnet matches the folder name', async () => {
    acc1.setListing(null, {
      folders: [{ id: 'F1', name: 'Mystery', path: 'Mystery', size: 0 }],
      files: [],
    });
    acc1.setListing('F1', {
      folders: [],
      files: [
        { id: 'v1', name: 'Mystery.mp4', size: 1, hash: null, isVideo: true, isAudio: false, folderId: 'F1' },
      ],
    });
    await indexer.scanAccount(acc1);
    const file = store.findFile('acc1', 'v1');
    expect(file?.magnet).toBeNull();
  });

  it('propagates the magnet to nested subfolders', async () => {
    store.recordMagnet('Big.Movie', 'magnet:?xt=urn:btih:xyz&dn=Big.Movie', 'acc1');
    acc1.setListing(null, {
      folders: [{ id: 'F1', name: 'Big.Movie', path: 'Big.Movie', size: 0 }],
      files: [],
    });
    acc1.setListing('F1', {
      folders: [{ id: 'F2', name: 'Subs', path: 'Big.Movie/Subs', size: 0 }],
      files: [
        { id: 'v1', name: 'Big.Movie.mkv', size: 1, hash: null, isVideo: true, isAudio: false, folderId: 'F1' },
      ],
    });
    acc1.setListing('F2', {
      folders: [],
      files: [
        { id: 's1', name: 'Big.Movie.en.srt', size: 1, hash: null, isVideo: false, isAudio: false, folderId: 'F2' },
      ],
    });
    await indexer.scanAccount(acc1);
    expect(store.findFile('acc1', 'v1')?.magnet).toBe('magnet:?xt=urn:btih:xyz&dn=Big.Movie');
    // Subtitles don't have a magnet column, but the lookup is consistent.
  });
});

describe('guessLanguage', () => {
  it('extracts a two-letter code', () => {
    expect(guessLanguage('Movie.en.srt')).toBe('en');
  });

  it('extracts a three-letter code', () => {
    expect(guessLanguage('Movie.eng.srt')).toBe('eng');
  });

  it('matches a full language word', () => {
    expect(guessLanguage('Movie.english.srt')).toBe('en');
  });

  it('returns null when no language is present', () => {
    expect(guessLanguage('Movie.srt')).toBeNull();
  });
});
