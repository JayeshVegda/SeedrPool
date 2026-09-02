/**
 * TMDB v3 client.
 *
 * Two flows are used:
 *   1. Search for a title by name and year.
 *   2. Fetch the IMDb id and artwork for a TMDB id.
 *
 * TMDB requires an API key; pass it in the constructor or the client will
 * refuse every request. The free tier is enough for a small library.
 *
 * Rate limits: TMDB's public API allows ~50 req/s per key, and the enricher
 * caps itself at 20 lookups per tick. No client-side limiter is needed.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Result of a successful TMDB lookup. */
export interface TmdbMatch {
  tmdbId: number;
  imdbId: string;
  /** TMDB image paths, e.g. `/abc.jpg`. Use `posterUrl` for full URLs. */
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  releaseDate: string | null;
  voteAverage: number;
  /** Genres translated to English names. */
  genres: string[];
  /** Runtime in minutes for movies, average episode runtime for series. */
  runtimeMinutes: number | null;
}

/** What a title needs to be matched against. */
export interface TitleQuery {
  name: string;
  year: number | null;
  kind: 'movie' | 'series';
}

export class TmdbClient {
  #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  get enabled(): boolean {
    return this.#apiKey !== '';
  }

  /** Best-effort search for a single title. Returns null on no match or error. */
  async findMatch(query: TitleQuery): Promise<TmdbMatch | null> {
    if (!this.enabled) return null;
    try {
      const searchPath = query.kind === 'series' ? 'search/tv' : 'search/movie';
      const yearParam = query.kind === 'series' ? 'first_air_date_year' : 'year';
      const url = new URL(`${TMDB_BASE}/${searchPath}`);
      url.searchParams.set('query', query.name);
      if (query.year !== null) url.searchParams.set(yearParam, String(query.year));
      url.searchParams.set('language', 'en-US');
      url.searchParams.set('include_adult', 'false');

      const search = await this.#fetch<{
        results: Array<{ id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }>;
      }>(url);
      const first = search.results[0];
      if (!first) return null;
      return this.fetchByTmdbId(first.id, query.kind);
    } catch {
      return null;
    }
  }

  /** Fetches the IMDb id, artwork, and overview for a known TMDB id. */
  async fetchByTmdbId(tmdbId: number, kind: 'movie' | 'series'): Promise<TmdbMatch | null> {
    if (!this.enabled) return null;
    try {
      const basePath = kind === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
      const [main, external] = await Promise.all([
        this.#fetch<{
          imdb_id?: string;
          external_ids?: { imdb_id?: string };
          poster_path: string | null;
          backdrop_path: string | null;
          overview: string;
          release_date?: string;
          first_air_date?: string;
          vote_average: number;
          genres: Array<{ name: string }>;
          runtime?: number;
          episode_run_time?: number[];
        }>(new URL(`${TMDB_BASE}/${basePath}?language=en-US`)),
        // Series do not include imdb_id on the main endpoint, so always pull
        // external_ids and prefer whichever is non-null.
        this.#fetch<{ imdb_id?: string }>(
          new URL(`${TMDB_BASE}/${basePath}/external_ids`),
        ).catch(() => null),
      ]);

      const imdbId = main.imdb_id ?? main.external_ids?.imdb_id ?? external?.imdb_id ?? null;
      if (imdbId === null || !imdbId.startsWith('tt')) return null;

      const runtime =
        main.runtime ??
        (main.episode_run_time && main.episode_run_time.length > 0
          ? main.episode_run_time[0] ?? null
          : null);

      return {
        tmdbId,
        imdbId,
        posterPath: main.poster_path,
        backdropPath: main.backdrop_path,
        overview: main.overview,
        releaseDate: main.release_date ?? main.first_air_date ?? null,
        voteAverage: main.vote_average,
        genres: main.genres.map((g) => g.name),
        runtimeMinutes: runtime ?? null,
      };
    } catch {
      return null;
    }
  }

  async #fetch<T>(url: URL): Promise<T> {
    // The v3 API key works as a query param. The v4 read-access token works
    // as a Bearer header. We use v3 keys, so prefer the query param. Falling
    // back to Bearer lets the same client accept a v4 token if one is set
    // (a future convenience, not currently used).
    url.searchParams.set('api_key', this.#apiKey);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`tmdb ${url.pathname} ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

/** Returns the TMDB CDN URL for a poster path at the requested size. */
export function posterUrl(path: string | null, size: 'w185' | 'w342' | 'w500' | 'original' = 'w342'): string | null {
  if (path === null) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

/** Returns the TMDB CDN URL for a backdrop at the requested size. */
export function backdropUrl(path: string | null, size: 'w780' | 'w1280' | 'original' = 'w1280'): string | null {
  if (path === null) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
