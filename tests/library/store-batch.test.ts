import { describe, it, expect, beforeEach } from 'vitest';
import { LibraryStore } from '../../src/library/store.ts';

function seed(store: LibraryStore) {
  const now = Date.now();
  store.upsertTitle({ key: 'movie-a', name: 'Movie A', year: 2020, kind: 'movie', addedAt: now });
  store.upsertTitle({ key: 'movie-b', name: 'Movie B', year: 2021, kind: 'movie', addedAt: now });
  store.upsertTitle({ key: 'show-c', name: 'Show C', year: 2019, kind: 'series', addedAt: now });

  store.upsertFile({
    fileId: 'f1', accountId: 'acc1', folderId: 'd1', name: 'A.1080p.mkv', size: 1000,
    hash: 'h1', titleKey: 'movie-a', season: null, episode: null, resolution: 1080,
    group: null, seenAt: 1,
  });
  store.upsertFile({
    fileId: 'f2', accountId: 'acc2', folderId: 'd2', name: 'A.2160p.mkv', size: 5000,
    hash: 'h2', titleKey: 'movie-a', season: null, episode: null, resolution: 2160,
    group: null, seenAt: 1,
  });
  store.upsertFile({
    fileId: 'f3', accountId: 'acc1', folderId: 'd3', name: 'B.720p.mkv', size: 700,
    hash: 'h3', titleKey: 'movie-b', season: null, episode: null, resolution: 720,
    group: null, seenAt: 1,
  });
  store.upsertFile({
    fileId: 'f4', accountId: 'acc3', folderId: 'd4', name: 'C.S01E01.mkv', size: 400,
    hash: 'h4', titleKey: 'show-c', season: 1, episode: 1, resolution: 1080,
    group: null, seenAt: 1,
  });
}

describe('LibraryStore batch queries', () => {
  let store: LibraryStore;

  beforeEach(() => {
    store = new LibraryStore(':memory:');
    seed(store);
  });

  describe('filesForTitles', () => {
    it('returns one entry per requested key', () => {
      const m = store.filesForTitles(['movie-a', 'movie-b', 'show-c']);
      expect(m.size).toBe(3);
      expect(m.get('movie-a')).toHaveLength(2);
      expect(m.get('movie-b')).toHaveLength(1);
      expect(m.get('show-c')).toHaveLength(1);
    });

    it('matches filesForTitle exactly, so the batch path is a drop-in', () => {
      // This equivalence is the whole safety argument for replacing 3N
      // single-title queries with one batch query on the library page.
      for (const key of ['movie-a', 'movie-b', 'show-c']) {
        const single = store.filesForTitle(key);
        const batched = store.filesForTitles([key]).get(key);
        expect(batched).toEqual(single);
      }
    });

    it('preserves the best-first ordering within each title', () => {
      const files = store.filesForTitles(['movie-a']).get('movie-a')!;
      // 2160p before 1080p, same as filesForTitle's ORDER BY.
      expect(files[0]?.resolution).toBe(2160);
      expect(files[1]?.resolution).toBe(1080);
    });

    it('returns an empty array for a title with no files, not undefined', () => {
      store.upsertTitle({ key: 'orphan', name: 'Orphan', year: null, kind: 'movie', addedAt: Date.now() });
      const m = store.filesForTitles(['orphan']);
      expect(m.get('orphan')).toEqual([]);
    });

    it('returns an empty map for an empty input', () => {
      expect(store.filesForTitles([]).size).toBe(0);
    });

    it('handles more keys than SQLite\'s variable limit', () => {
      // The chunking exists so a large library cannot blow the 999-variable
      // ceiling. Ask for 1200 keys; only the real ones come back populated.
      const keys = Array.from({ length: 1200 }, (_, i) => `synthetic-${i}`);
      keys.push('movie-a');
      const m = store.filesForTitles(keys);
      expect(m.size).toBe(1201);
      expect(m.get('movie-a')).toHaveLength(2);
      expect(m.get('synthetic-500')).toEqual([]);
    });
  });

  describe('perAccountStats', () => {
    it('aggregates titles, files, and bytes per account', () => {
      const stats = store.perAccountStats();
      expect(stats.get('acc1')).toEqual({ titles: 2, files: 2, bytes: 1700 });
      expect(stats.get('acc2')).toEqual({ titles: 1, files: 1, bytes: 5000 });
      expect(stats.get('acc3')).toEqual({ titles: 1, files: 1, bytes: 400 });
    });

    it('omits accounts with no files rather than reporting zeros', () => {
      expect(store.perAccountStats().has('acc9')).toBe(false);
    });

    it('counts distinct titles, not file rows', () => {
      // acc1 holds one file each from two different titles.
      expect(store.perAccountStats().get('acc1')?.titles).toBe(2);
    });
  });

  describe('titlesForAccount', () => {
    it('returns only titles with a file on that account', () => {
      const t = store.titlesForAccount('acc2').map((x) => x.key);
      expect(t).toEqual(['movie-a']);
    });

    it('reports per-title aggregates scoped to that account', () => {
      const [movieA] = store.titlesForAccount('acc2');
      // Only acc2's 2160p copy counts, not acc1's 1080p one.
      expect(movieA?.fileCount).toBe(1);
      expect(movieA?.totalSize).toBe(5000);
      expect(movieA?.bestResolution).toBe(2160);
    });

    it('returns an empty list for an unknown account', () => {
      expect(store.titlesForAccount('nope')).toEqual([]);
    });
  });

  describe('filesForAccount', () => {
    it('returns files largest first, joined with the title name', () => {
      const files = store.filesForAccount('acc1');
      expect(files.map((f) => f.fileId)).toEqual(['f1', 'f3']);
      expect(files[0]?.titleName).toBe('Movie A');
    });

    it('returns an empty list for an unknown account', () => {
      expect(store.filesForAccount('nope')).toEqual([]);
    });
  });

  describe('activityForAccount', () => {
    it('matches on both message and detail', () => {
      store.recordActivity('info', 'Magnet added to acc1', 'Some Movie');
      store.recordActivity('info', 'Something happened', 'on acc1');
      store.recordActivity('info', 'Unrelated to any account', null as unknown as undefined);
      const rows = store.activityForAccount('acc1');
      expect(rows).toHaveLength(2);
    });

    it('returns newest first', () => {
      store.recordActivity('info', 'first on acc5');
      store.recordActivity('info', 'second on acc5');
      const rows = store.activityForAccount('acc5');
      expect(rows[0]?.message).toBe('second on acc5');
    });

    it('honours the limit', () => {
      for (let i = 0; i < 10; i += 1) store.recordActivity('info', `event ${i} on acc7`);
      expect(store.activityForAccount('acc7', 3)).toHaveLength(3);
    });

    it('returns an empty list when nothing mentions the account', () => {
      expect(store.activityForAccount('acc99')).toEqual([]);
    });
  });

  describe('metadata reset', () => {
    it('clearTitleIds nulls both ids for one title only', () => {
      store.setTitleIds('movie-a', { imdbId: 'tt1', tmdbId: 1 });
      store.setTitleIds('movie-b', { imdbId: 'tt2', tmdbId: 2 });
      store.clearTitleIds('movie-a');
      expect(store.getTitle('movie-a')?.imdbId).toBeNull();
      expect(store.getTitle('movie-a')?.tmdbId).toBeNull();
      expect(store.getTitle('movie-b')?.imdbId).toBe('tt2');
    });

    it('clearAllTitleIds nulls every title and reports the count', () => {
      store.setTitleIds('movie-a', { imdbId: 'tt1', tmdbId: 1 });
      store.setTitleIds('movie-b', { imdbId: 'tt2', tmdbId: 2 });
      const n = store.clearAllTitleIds();
      expect(n).toBe(3); // all three titles are updated
      expect(store.titlesNeedingLookup()).toHaveLength(3);
    });

    it('a cleared title reappears in titlesNeedingLookup', () => {
      store.setTitleIds('movie-a', { imdbId: 'tt1', tmdbId: 1 });
      expect(store.titlesNeedingLookup().map((t) => t.key)).not.toContain('movie-a');
      store.clearTitleIds('movie-a');
      expect(store.titlesNeedingLookup().map((t) => t.key)).toContain('movie-a');
    });
  });
});
