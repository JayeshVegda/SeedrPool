import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TmdbClient, posterUrl, backdropUrl } from '../src/library/tmdb.ts';
import { MetadataEnricher } from '../src/library/metadata-enricher.ts';
import { LibraryStore } from '../src/library/store.ts';
import type { LibraryTitle } from '../src/library/store.ts';
import type { TmdbMatch, TitleQuery } from '../src/library/tmdb.ts';

function match(overrides: Partial<TmdbMatch> = {}): TmdbMatch {
  return {
    tmdbId: 603,
    imdbId: 'tt0133093',
    posterPath: '/abc.jpg',
    backdropPath: '/def.jpg',
    overview: 'A computer hacker learns...',
    releaseDate: '1999-03-31',
    voteAverage: 8.7,
    genres: ['Action', 'Sci-Fi'],
    runtimeMinutes: 136,
    ...overrides,
  };
}

describe('TmdbClient', () => {
  it('is disabled with an empty key', () => {
    const client = new TmdbClient('');
    expect(client.enabled).toBe(false);
  });

  it('returns null from findMatch when disabled', async () => {
    const client = new TmdbClient('');
    const result = await client.findMatch({ name: 'The Matrix', year: 1999, kind: 'movie' });
    expect(result).toBeNull();
  });

  it('searches by name and year, then returns the match details', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-31' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            imdb_id: 'tt0133093',
            poster_path: '/abc.jpg',
            backdrop_path: '/def.jpg',
            overview: 'A computer hacker learns...',
            release_date: '1999-03-31',
            vote_average: 8.7,
            genres: [{ name: 'Action' }, { name: 'Sci-Fi' }],
            runtime: 136,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ imdb_id: 'tt0133093' }), { status: 200 }),
      );

    const client = new TmdbClient('test-key');
    const result = await client.findMatch({ name: 'The Matrix', year: 1999, kind: 'movie' });

    expect(result).not.toBeNull();
    expect(result?.imdbId).toBe('tt0133093');
    expect(result?.runtimeMinutes).toBe(136);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const searchUrl = (fetchSpy.mock.calls[0]?.[0] as URL).toString();
    expect(searchUrl).toContain('search/movie');
    expect(searchUrl).toContain('query=The+Matrix');
    expect(searchUrl).toContain('year=1999');
  });

  it('returns null when the search returns no results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = new TmdbClient('test-key');
    const result = await client.findMatch({ name: 'No Such Film', year: 1999, kind: 'movie' });
    expect(result).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('rate limited', { status: 429 }),
    );
    const client = new TmdbClient('test-key');
    const result = await client.findMatch({ name: 'The Matrix', year: 1999, kind: 'movie' });
    expect(result).toBeNull();
  });

  it('returns null when the matched entry has no IMDb id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 1, title: 'Foo' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            imdb_id: null,
            poster_path: null,
            backdrop_path: null,
            overview: '',
            vote_average: 0,
            genres: [],
            runtime: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ imdb_id: null }), { status: 200 }));
    const client = new TmdbClient('test-key');
    const result = await client.findMatch({ name: 'Foo', year: null, kind: 'movie' });
    expect(result).toBeNull();
  });
});

describe('posterUrl / backdropUrl', () => {
  it('returns the full TMDB CDN URL for a poster', () => {
    expect(posterUrl('/abc.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
  });
  it('returns null when the path is null', () => {
    expect(posterUrl(null)).toBeNull();
  });
  it('returns the full TMDB CDN URL for a backdrop', () => {
    expect(backdropUrl('/def.jpg')).toBe('https://image.tmdb.org/t/p/w1280/def.jpg');
  });
});

describe('MetadataEnricher', () => {
  let store: LibraryStore;
  let client: TmdbClient;
  let enricher: MetadataEnricher;

  beforeEach(() => {
    store = new LibraryStore(':memory:');
    client = new TmdbClient('test-key');
    enricher = new MetadataEnricher(store, client);
  });

  it('is a no-op when the client is null', async () => {
    const disabled = new MetadataEnricher(store, null);
    const touched = await disabled.tick();
    expect(touched).toBe(0);
  });

  it('looks up titles without imdb_id and writes the result', async () => {
    const title: LibraryTitle = {
      key: 'matrix',
      name: 'The Matrix',
      year: 1999,
      kind: 'movie',
      addedAt: 1000,
      imdbId: null,
      tmdbId: null,
    };
    store.upsertTitle(title);

    const spy = vi
      .spyOn(client, 'findMatch')
      .mockResolvedValue(match({ imdbId: 'tt0133093', tmdbId: 603 }));

    const touched = await enricher.tick();
    expect(touched).toBe(1);
    const updated = store.getTitle('matrix');
    expect(updated?.imdbId).toBe('tt0133093');
    expect(updated?.tmdbId).toBe(603);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('skips titles that already have an imdb_id', async () => {
    store.upsertTitle({
      key: 'known',
      name: 'Known Movie',
      year: 2000,
      kind: 'movie',
      addedAt: 1000,
      imdbId: 'tt0000001',
      tmdbId: 1,
    });
    const spy = vi.spyOn(client, 'findMatch');
    const touched = await enricher.tick();
    expect(touched).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('caps the work per tick at 20', async () => {
    for (let i = 0; i < 25; i += 1) {
      store.upsertTitle({
        key: `t${i}`,
        name: `Movie ${i}`,
        year: 2000 + i,
        kind: 'movie',
        addedAt: 1000 + i,
        imdbId: null,
        tmdbId: null,
      });
    }
    const spy = vi
      .spyOn(client, 'findMatch')
      .mockResolvedValue(match({ imdbId: 'tt0000001', tmdbId: 1 }));
    const touched = await enricher.tick();
    expect(touched).toBe(20);
    expect(spy).toHaveBeenCalledTimes(20);
  });

  it('does not start a timer if not started', () => {
    expect(enricher.isRunning).toBe(false);
  });

  it('start() enables a timer and stop() clears it', async () => {
    enricher.start();
    expect(enricher.isRunning).toBe(true);
    enricher.stop();
    expect(enricher.isRunning).toBe(false);
  });
});
