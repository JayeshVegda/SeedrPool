import { describe, it, expect, beforeEach } from 'vitest';
import { AddonApp, parseExtra, posterSvg, unwrapId } from '../src/addon/app.ts';
import { LibraryStore } from '../src/library/store.ts';
import type { Config } from '../src/core/config.ts';
import type { AccountPool } from '../src/core/account-pool.ts';
import type { PlaybackUrl, StorageProvider } from '../src/core/types.ts';

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  credentialsPath: '/dev/null',
  tokenPath: '/dev/null',
  databasePath: '/dev/null',
  addonSecret: 'testsecret',
  publicUrl: 'https://example.test',
  adminUser: 'jay',
  adminPassword: 'pw',
  tmdbApiKey: null,
};

class FakeProvider {
  readonly accountId: string;
  constructor(id: string) {
    this.accountId = id;
  }
  async getPlaybackUrl(fileId: string): Promise<PlaybackUrl> {
    return { url: `https://seedr.test/ff/${fileId}`, filename: '', expiresAt: null, kind: 'direct' };
  }
  async getQuota() {
    return { used: 0, max: 0, get free() { return 0; } };
  }
  async listFolder() {
    return { folders: [], files: [] };
  }
  async addMagnet() {
    throw new Error('not used');
  }
  async listTransfers() {
    return [];
  }
  async deleteFile() {}
  async deleteFolder() {}
  async deleteTransfer() {}
  async healthCheck() {
    return { healthy: true };
  }
}

function buildPool(providers: StorageProvider[]): AccountPool {
  return {
    capacity: () => ({ used: 0, max: 0, free: 0, healthyAccounts: providers.length, totalAccounts: providers.length }),
    healthyProviders: () => providers,
    provider: (id: string) => providers.find((p) => p.accountId === id),
    acquireStream: () => () => {},
    refresh: async () => [],
    markCdnBroken: () => {},
    markCdnHealthy: () => {},
  } as unknown as AccountPool;
}

function ctxFor(id: string, extra: Record<string, string> = {}): {
  request: Request;
  params: Record<string, string>;
  url: URL;
} {
  const params: Record<string, string> = { id };
  for (const [k, v] of Object.entries(extra)) params[k] = v;
  return {
    request: new Request('http://x/'),
    params,
    url: new URL('http://x/'),
  };
}

describe('unwrapId', () => {
  it('strips a .json suffix', () => {
    expect(unwrapId('tt0133093.json')).toBe('tt0133093');
  });
  it('returns the same id when there is no suffix', () => {
    expect(unwrapId('tt0133093')).toBe('tt0133093');
  });
  it('strips .json only from the end', () => {
    expect(unwrapId('weird.json.value')).toBe('weird.json.value');
  });
});

describe('parseExtra', () => {
  it('parses a search argument', () => {
    expect(parseExtra('search=dune')).toEqual({ search: 'dune' });
  });

  it('parses multiple arguments', () => {
    expect(parseExtra('search=dune&skip=200')).toEqual({ search: 'dune', skip: '200' });
  });

  it('returns an empty object for the empty segment', () => {
    expect(parseExtra('')).toEqual({});
  });
});

describe('AddonApp.manifest', () => {
  it('lists the two catalogs and has no idPrefixes (Cinemeta called in parallel)', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    const response = app.manifest();
    const body = await response.json();

    expect(body.id).toBe('dev.zayu.seedrpool');
    expect(body.resources).toContain('catalog');
    expect(body.resources).toContain('meta');
    expect(body.resources).toContain('stream');
    expect(body.resources).toContain('subtitles');
    expect(body.idPrefixes).toBeUndefined();
    expect(body.behaviorHints.p2p).toBe(false);
    expect(body.catalogs.map((c: { type: string }) => c.type).sort()).toEqual(['movie', 'series']);
  });
});

describe('AddonApp.catalog', () => {
  let store: LibraryStore;
  let app: AddonApp;

  beforeEach(() => {
    store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    app = new AddonApp(store, () => pool, config);

    store.upsertTitle({ key: 'matrix', name: 'The Matrix', year: 1999, kind: 'movie', addedAt: 1000, imdbId: 'tt0133093', tmdbId: null });
    store.upsertFile({
      fileId: '1', accountId: 'acc1', folderId: '0', name: 'matrix.1080p.mkv',
      size: 5_000_000_000, hash: 'h1', titleKey: 'matrix',
      season: null, episode: null, resolution: 1080, group: 'RARBG', seenAt: 1000,
    });
    store.upsertTitle({ key: 'breakingbad', name: 'Breaking Bad', year: null, kind: 'series', addedAt: 2000, imdbId: 'tt0903747', tmdbId: null });
    store.upsertFile({
      fileId: '2', accountId: 'acc1', folderId: '0', name: 'bb.s01e01.mkv',
      size: 1_000_000_000, hash: 'h2', titleKey: 'breakingbad',
      season: 1, episode: 1, resolution: 720, group: null, seenAt: 2000,
    });
  });

  it('returns only movies for type=movie', async () => {
    const response = app.catalog({
      ...ctxFor('x'),
      params: { type: 'movie', catalogId: 'seedrpool-movies' },
    } as never);
    const body = await response.json();
    expect(body.metas.length).toBe(1);
    expect(body.metas[0].name).toBe('The Matrix');
    // IMDb id is the Stremio id so Cinemeta gets called.
    expect(body.metas[0].id).toBe('tt0133093');
    expect(body.metas[0].imdb_id).toBe('tt0133093');
    // No `poster` field: Cinemeta fills it.
    expect(body.metas[0].poster).toBeUndefined();
  });

  it('falls back to sp: id when the title has no IMDb match yet', async () => {
    // A title without files is never browsable, so the orphan must have at
    // least one file for the catalog query to include it.
    store.upsertTitle({ key: 'orphan', name: 'Orphan Movie', year: 2020, kind: 'movie', addedAt: 1500, imdbId: null, tmdbId: null });
    store.upsertFile({
      fileId: 'o1', accountId: 'acc1', folderId: '0', name: 'orphan.mkv',
      size: 100, hash: 'h', titleKey: 'orphan',
      season: null, episode: null, resolution: 720, group: null, seenAt: 1500,
    });
    const response = app.catalog({
      ...ctxFor('x'),
      params: { type: 'movie', catalogId: 'seedrpool-movies' },
    } as never);
    const body = await response.json();
    const orphan = body.metas.find((m: { name: string }) => m.name === 'Orphan Movie');
    expect(orphan).toBeDefined();
    expect(orphan.id).toBe('sp:orphan');
    expect(orphan.imdb_id).toBeUndefined();
  });

  it('searches the catalog', async () => {
    const response = app.catalog({
      ...ctxFor('x'),
      params: { type: 'movie', catalogId: 'seedrpool-movies', extra: 'search=matrix' },
    } as never);
    const body = await response.json();
    expect(body.metas.map((m: { name: string }) => m.name)).toEqual(['The Matrix']);
  });
});

describe('AddonApp.meta', () => {
  it('returns null meta for an unknown IMDb id', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    const response = app.meta(ctxFor('tt0000000.json'));
    const body = await response.json();
    expect(body.meta).toBeNull();
  });

  it('returns null meta for a non-IMDb id (no sp: ids served here)', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    const response = app.meta(ctxFor('sp:foo.json'));
    const body = await response.json();
    expect(body.meta).toBeNull();
  });

  it('returns videos for a series', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    store.upsertTitle({ key: 'bb', name: 'Breaking Bad', year: null, kind: 'series', addedAt: 2000, imdbId: 'tt0903747', tmdbId: null });
    store.upsertFile({
      fileId: 'a', accountId: 'acc1', folderId: '0', name: 'bb.s01e01.mkv',
      size: 1, hash: null, titleKey: 'bb',
      season: 1, episode: 1, resolution: 720, group: null, seenAt: 2000,
    });
    store.upsertFile({
      fileId: 'b', accountId: 'acc1', folderId: '0', name: 'bb.s01e02.mkv',
      size: 1, hash: null, titleKey: 'bb',
      season: 1, episode: 2, resolution: 720, group: null, seenAt: 2000,
    });
    const response = app.meta(ctxFor('tt0903747'));
    const body = await response.json();
    expect(body.meta.videos.length).toBe(2);
    // Stremio matches videos[].id against the stream request id, so all
    // episodes share the parent IMDb id.
    expect(body.meta.videos[0].id).toBe('tt0903747');
    expect(body.meta.videos[0].season).toBe(1);
    expect(body.meta.videos[0].episode).toBe(1);
  });
});

describe('AddonApp.stream', () => {
  it('returns a stream per physical file', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    store.upsertTitle({ key: 'matrix', name: 'The Matrix', year: 1999, kind: 'movie', addedAt: 1000, imdbId: 'tt0133093', tmdbId: null });
    store.upsertFile({
      fileId: 'a', accountId: 'acc1', folderId: '0', name: 'matrix.1080p.mkv',
      size: 5_000_000_000, hash: 'h1', titleKey: 'matrix',
      season: null, episode: null, resolution: 1080, group: 'RARBG', seenAt: 1000,
    });
    store.upsertFile({
      fileId: 'b', accountId: 'acc2', folderId: '0', name: 'matrix.720p.mkv',
      size: 2_000_000_000, hash: 'h2', titleKey: 'matrix',
      season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
    });

    const response = app.stream(ctxFor('tt0133093'));
    const body = await response.json();
    expect(body.streams.length).toBe(2);
    expect(body.streams[0].name).toBe('SeedrPool 1080p');
    expect(body.streams[0].url).toBe(`https://example.test/testsecret/play/acc1/a`);
    expect(body.streams[0].behaviorHints.videoSize).toBe(5_000_000_000);
    expect(body.streams[0].behaviorHints.notWebReady).toBe(true);
  });

  it('emits a per-show binge group for series (not per-resolution)', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    store.upsertTitle({ key: 'bb', name: 'Breaking Bad', year: null, kind: 'series', addedAt: 1000, imdbId: 'tt0903747', tmdbId: null });
    store.upsertFile({
      fileId: 'a', accountId: 'acc1', folderId: '0', name: 'bb.s01e01.1080p.mkv',
      size: 1, hash: null, titleKey: 'bb',
      season: 1, episode: 1, resolution: 1080, group: null, seenAt: 1000,
    });
    const response = app.stream(ctxFor('tt0903747'));
    const body = await response.json();
    // Binge group is per-title, so 720p and 1080p of the next episode both
    // auto-play.
    expect(body.streams[0].behaviorHints.bingeGroup).toBe('seedrpool-bb');
  });
});

describe('AddonApp.subtitles', () => {
  it('returns subtitles in the same folder as the video, with 3-letter lang codes', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    store.upsertTitle({ key: 'matrix', name: 'The Matrix', year: 1999, kind: 'movie', addedAt: 1000, imdbId: 'tt0133093', tmdbId: null });
    store.upsertFile({
      fileId: 'a', accountId: 'acc1', folderId: '0', name: 'matrix.mkv',
      size: 1, hash: null, titleKey: 'matrix',
      season: null, episode: null, resolution: 1080, group: null, seenAt: 1000,
    });
    store.upsertSubtitle({
      fileId: 's1', accountId: 'acc1', folderId: '0',
      name: 'matrix.en.srt', language: 'en', seenAt: 1000,
    });
    store.upsertSubtitle({
      fileId: 's2', accountId: 'acc1', folderId: '0',
      name: 'matrix.spa.srt', language: 'es', seenAt: 1000,
    });

    const response = app.subtitles(ctxFor('tt0133093'));
    const body = await response.json();
    expect(body.subtitles.length).toBe(2);
    const langs = body.subtitles.map((s: { lang: string }) => s.lang).sort();
    // OpenSubtitles 3-letter codes.
    expect(langs).toEqual(['eng', 'spa']);
  });
});

describe('AddonApp.play', () => {
  it('mints a fresh URL and 302s to it', async () => {
    const store = new LibraryStore(':memory:');
    const provider = new FakeProvider('acc1');
    const pool = buildPool([provider]);
    const app = new AddonApp(store, () => pool, config);

    const response = await app.play({
      request: new Request('http://x/'),
      params: { accountId: 'acc1', fileId: 'file42' },
      url: new URL('http://x/'),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://seedr.test/ff/file42');
  });

  it('returns 404 for an unknown account', async () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    const response = await app.play({
      request: new Request('http://x/'),
      params: { accountId: 'nope', fileId: 'file42' },
      url: new URL('http://x/'),
    });
    expect(response.status).toBe(404);
  });
});

describe('AddonApp.poster', () => {
  it('returns a valid SVG', () => {
    const store = new LibraryStore(':memory:');
    const pool = buildPool([]);
    const app = new AddonApp(store, () => pool, config);

    store.upsertTitle({ key: 'matrix', name: 'The Matrix', year: 1999, kind: 'movie', addedAt: 1000, imdbId: null, tmdbId: null });
    const response = app.poster({
      request: new Request('http://x/'),
      params: { key: 'matrix.svg' },
      url: new URL('http://x/'),
    });
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    return response.text().then((svg) => {
      expect(svg).toContain('The Matrix');
      expect(svg).toContain('1999');
    });
  });

  it('produces consistent output for a name (deterministic hue)', () => {
    const a = posterSvg('Foo', '2020');
    const b = posterSvg('Foo', '2020');
    expect(a).toBe(b);
  });
});
