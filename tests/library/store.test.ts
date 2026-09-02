import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LibraryStore } from '../../src/library/store.ts';

describe('LibraryStore', () => {
  let store: LibraryStore;

  beforeEach(() => {
    store = new LibraryStore(':memory:');
  });

  it('upserts and retrieves a title', () => {
    const inserted = store.upsertTitle({ key: 'sintel', name: 'Sintel', year: null, kind: 'movie', addedAt: 1000 });
    const t = store.getTitle('sintel');
    expect(inserted).toBe(true);
    expect(t?.name).toBe('Sintel');
    expect(t?.kind).toBe('movie');
  });

  it('returns false when upserting an existing title', () => {
    store.upsertTitle({ key: 'sintel', name: 'Sintel', year: null, kind: 'movie', addedAt: 1000 });
    const second = store.upsertTitle({ key: 'sintel', name: 'Sintel (full title)', year: null, kind: 'movie', addedAt: 2000 });
    expect(second).toBe(false);
    expect(store.getTitle('sintel')?.name).toBe('Sintel (full title)');
  });

  it('records and looks up magnets by display name', () => {
    store.recordMagnet('In.the.Mood.2000', 'magnet:?xt=urn:btih:abc&dn=In.the.Mood.2000', 'acc1');
    const got = store.magnetForFolder('In.the.Mood.2000');
    expect(got?.magnet).toContain('urn:btih:abc');
    expect(got?.accountId).toBe('acc1');
    expect(store.magnetForFolder('nope')).toBeNull();
  });

  it('overwrites an existing magnet record on conflict', () => {
    store.recordMagnet('Movie', 'magnet:?xt=A', 'acc1');
    store.recordMagnet('Movie', 'magnet:?xt=B', 'acc2');
    expect(store.magnetForFolder('Movie')?.magnet).toBe('magnet:?xt=B');
    expect(store.magnetForFolder('Movie')?.accountId).toBe('acc2');
  });

  it('lists magnets newest first', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      store.recordMagnet('A', 'magnet:?xt=A', 'acc1');
      vi.setSystemTime(2_000);
      store.recordMagnet('B', 'magnet:?xt=B', 'acc1');
      const list = store.listMagnets();
      expect(list.map((m) => m.displayName)).toEqual(['B', 'A']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a magnet by display name', () => {
    store.recordMagnet('X', 'magnet:?xt=X', 'acc1');
    expect(store.magnetForFolder('X')).not.toBeNull();
    store.forgetMagnet('X');
    expect(store.magnetForFolder('X')).toBeNull();
  });

  it('removes a single file row and drops the title if it has no remaining files', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: 'a', accountId: 'acc1', folderId: '0', name: 'a.mkv',
      size: 1, hash: null, titleKey: 'foo',
      season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
    });
    expect(store.deleteFileRow('acc1', 'a')).toBe(true);
    expect(store.findFile('acc1', 'a')).toBeNull();
    expect(store.getTitle('foo')).toBeNull();
  });

  it('returns false when deleting a non-existent file', () => {
    expect(store.deleteFileRow('acc1', 'ghost')).toBe(false);
  });

  it('lists files that have a stored magnet', () => {
    store.upsertTitle({ key: 'm', name: 'Movie', year: 2020, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: 'a', accountId: 'acc1', folderId: '0', name: 'a.mkv',
      size: 100, hash: null, titleKey: 'm', magnet: 'magnet:?xt=A',
      season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
    });
    store.upsertFile({
      fileId: 'b', accountId: 'acc2', folderId: '0', name: 'b.mkv',
      size: 200, hash: null, titleKey: 'm', magnet: null,
      season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
    });
    const list = store.listFilesWithMagnet();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      fileId: 'a', accountId: 'acc1', magnet: 'magnet:?xt=A', titleName: 'Movie',
    });
  });

  it('records activity and returns it newest-first', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      store.recordActivity('info', 'first');
      vi.setSystemTime(2_000);
      store.recordActivity('warn', 'second');
      vi.setSystemTime(3_000);
      store.recordActivity('success', 'third');
      const log = store.recentActivity();
      expect(log.map((e) => e.message)).toEqual(['third', 'second', 'first']);
      expect(log[0]?.kind).toBe('success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the activity log at 200 rows', () => {
    for (let i = 0; i < 250; i += 1) {
      store.recordActivity('info', `event-${i}`);
    }
    expect(store.recentActivity(999).length).toBe(200);
  });

  it('respects the limit argument on recentActivity', () => {
    for (let i = 0; i < 5; i += 1) store.recordActivity('info', `e${i}`);
    expect(store.recentActivity(2).length).toBe(2);
  });

  it('prefers the longer name when upserting twice', () => {
    store.upsertTitle({ key: 'sintel', name: 'Sintel', year: null, kind: 'movie', addedAt: 1000 });
    store.upsertTitle({
      key: 'sintel',
      name: 'Sintel (full title)',
      year: null,
      kind: 'movie',
      addedAt: 2000,
    });
    expect(store.getTitle('sintel')?.name).toBe('Sintel (full title)');
  });

  it('promotes a title to series when a series file is indexed', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    // The indexer re-upserts the title with the parsed kind after every file,
    // so a series file arriving promotes a previously-movie title.
    store.upsertFile({
      fileId: '1',
      accountId: 'acc1',
      folderId: '0',
      name: 'Foo S01E01.mkv',
      size: 100,
      hash: null,
      titleKey: 'foo',
      season: 1,
      episode: 1,
      resolution: 1080,
      group: null,
      seenAt: 1000,
    });
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'series', addedAt: 1000 });
    expect(store.getTitle('foo')?.kind).toBe('series');
  });

  it('keeps an existing year when the next file has none', () => {
    store.upsertTitle({ key: 'dune', name: 'Dune', year: 1984, kind: 'movie', addedAt: 1000 });
    store.upsertTitle({ key: 'dune', name: 'Dune', year: null, kind: 'movie', addedAt: 2000 });
    expect(store.getTitle('dune')?.year).toBe(1984);
  });

  it('returns titles with file aggregates', () => {
    store.upsertTitle({ key: 'matrix', name: 'Matrix', year: 1999, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: '1',
      accountId: 'acc1',
      folderId: '0',
      name: 'Matrix.1999.1080p.mkv',
      size: 5_000_000_000,
      hash: 'h1',
      titleKey: 'matrix',
      season: null,
      episode: null,
      resolution: 1080,
      group: 'RARBG',
      seenAt: 1000,
    });
    store.upsertFile({
      fileId: '2',
      accountId: 'acc2',
      folderId: '0',
      name: 'Matrix.1999.720p.mkv',
      size: 2_000_000_000,
      hash: 'h2',
      titleKey: 'matrix',
      season: null,
      episode: null,
      resolution: 720,
      group: 'YIFY',
      seenAt: 1000,
    });
    const t = store.getTitle('matrix');
    expect(t?.fileCount).toBe(2);
    expect(t?.totalSize).toBe(7_000_000_000);
    expect(t?.bestResolution).toBe(1080);
  });

  it('orders files by resolution then size', () => {
    store.upsertTitle({ key: 'matrix', name: 'Matrix', year: 1999, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: '720', accountId: 'acc1', folderId: '0', name: 'm720.mkv',
      size: 4_000_000_000, hash: null, titleKey: 'matrix',
      season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
    });
    store.upsertFile({
      fileId: '1080small', accountId: 'acc1', folderId: '0', name: 'm1080s.mkv',
      size: 2_000_000_000, hash: null, titleKey: 'matrix',
      season: null, episode: null, resolution: 1080, group: null, seenAt: 1000,
    });
    store.upsertFile({
      fileId: '1080big', accountId: 'acc1', folderId: '0', name: 'm1080b.mkv',
      size: 8_000_000_000, hash: null, titleKey: 'matrix',
      season: null, episode: null, resolution: 1080, group: null, seenAt: 1000,
    });
    const files = store.filesForTitle('matrix');
    expect(files.map((f) => f.fileId)).toEqual(['1080big', '1080small', '720']);
  });

  it('prunes files not seen in the latest scan', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: 'gone', accountId: 'acc1', folderId: '0', name: 'foo.mkv',
      size: 100, hash: null, titleKey: 'foo',
      season: null, episode: null, resolution: 720, group: null, seenAt: 500,
    });
    const pruned = store.pruneAccount('acc1', 1000);
    expect(pruned).toBe(1);
    expect(store.findFile('acc1', 'gone')).toBeNull();
  });

  it('drops a title when no files remain', () => {
    store.upsertTitle({ key: 'orphan', name: 'Orphan', year: null, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: 'x', accountId: 'acc1', folderId: '0', name: 'orphan.mkv',
      size: 100, hash: null, titleKey: 'orphan',
      season: null, episode: null, resolution: 720, group: null, seenAt: 500,
    });
    store.pruneAccount('acc1', 1000);
    expect(store.getTitle('orphan')).toBeNull();
  });

  it('groups duplicates by hash', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    for (const [id, account] of [['a1', 'acc1'], ['a2', 'acc2'], ['a3', 'acc3']]) {
      store.upsertFile({
        fileId: id, accountId: account, folderId: '0', name: 'foo.mkv',
        size: 100, hash: 'duplicate-hash', titleKey: 'foo',
        season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
      });
    }
    const dups = store.duplicateGroups();
    expect(dups.length).toBe(1);
    expect(dups[0]?.files.length).toBe(3);
  });

  it('searches titles case-insensitively', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: '1', accountId: 'acc1', folderId: '0', name: 'foo.mkv',
      size: 100, hash: null, titleKey: 'foo',
      season: null, episode: null, resolution: null, group: null, seenAt: 1000,
    });
    store.upsertTitle({ key: 'bar', name: 'Bar', year: null, kind: 'movie', addedAt: 2000 });
    store.upsertFile({
      fileId: '2', accountId: 'acc1', folderId: '0', name: 'bar.mkv',
      size: 100, hash: null, titleKey: 'bar',
      season: null, episode: null, resolution: null, group: null, seenAt: 2000,
    });
    const results = store.listTitles({ kind: 'movie', search: 'FOO' });
    expect(results.map((t) => t.name)).toEqual(['Foo']);
  });

  it('returns episodes for a series in order', () => {
    store.upsertTitle({ key: 'show', name: 'Show', year: null, kind: 'series', addedAt: 1000 });
    store.upsertFile({
      fileId: 's1e2', accountId: 'acc1', folderId: '0', name: 'show.s01e02.mkv',
      size: 100, hash: null, titleKey: 'show',
      season: 1, episode: 2, resolution: 720, group: null, seenAt: 1000,
    });
    store.upsertFile({
      fileId: 's1e1', accountId: 'acc1', folderId: '0', name: 'show.s01e01.mkv',
      size: 100, hash: null, titleKey: 'show',
      season: 1, episode: 1, resolution: 720, group: null, seenAt: 1000,
    });
    const eps = store.episodesForTitle('show');
    expect(eps).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
  });

  it('returns subtitles for a folder', () => {
    store.upsertSubtitle({
      fileId: 's1', accountId: 'acc1', folderId: '0',
      name: 'movie.en.srt', language: 'en', seenAt: 1000,
    });
    store.upsertSubtitle({
      fileId: 's2', accountId: 'acc1', folderId: '0',
      name: 'movie.es.srt', language: 'es', seenAt: 1000,
    });
    store.upsertSubtitle({
      fileId: 's3', accountId: 'acc1', folderId: 'other',
      name: 'other.en.srt', language: 'en', seenAt: 1000,
    });
    const subs = store.subtitlesForFolder('acc1', '0');
    expect(subs.map((s) => s.fileId).sort()).toEqual(['s1', 's2']);
  });

  it('rolls back a failed transaction', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    expect(() =>
      store.transaction(() => {
        store.upsertTitle({ key: 'bar', name: 'Bar', year: null, kind: 'movie', addedAt: 2000 });
        throw new Error('boom');
      }),
    ).toThrow();
    expect(store.getTitle('foo')?.name).toBe('Foo');
    expect(store.getTitle('bar')).toBeNull();
  });

  it('returns aggregate stats', () => {
    store.upsertTitle({ key: 'foo', name: 'Foo', year: null, kind: 'movie', addedAt: 1000 });
    store.upsertFile({
      fileId: '1', accountId: 'acc1', folderId: '0', name: 'foo.mkv',
      size: 1_000_000, hash: null, titleKey: 'foo',
      season: null, episode: null, resolution: 720, group: null, seenAt: 1000,
    });
    store.upsertSubtitle({
      fileId: 's1', accountId: 'acc1', folderId: '0',
      name: 'foo.en.srt', language: 'en', seenAt: 1000,
    });
    const stats = store.stats();
    expect(stats.titles).toBe(1);
    expect(stats.files).toBe(1);
    expect(stats.totalSize).toBe(1_000_000);
    expect(stats.subtitles).toBe(1);
  });
});
