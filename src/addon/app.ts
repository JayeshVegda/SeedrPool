/**
 * Stremio addon protocol.
 *
 * Implemented directly rather than with the SDK: the protocol is a handful of
 * JSON endpoints, and the official SDK would add a dependency plus its own HTTP
 * server for no benefit (RESEARCH.md).
 *
 * Two protocol requirements drive the shape of this file:
 *   - every route needs CORS allowing all origins, including `/manifest.json`;
 *   - `stream.url` must not be a Seedr URL. `ff_get` links expire in ~24 h, so
 *     streams point at `/play/...` here, which mints a fresh URL per playback and
 *     redirects. Seedr credentials never reach the client.
 *
 * Ids: catalog and meta endpoints use IMDb ids (`tt...`). The metadata
 * service writes these onto each title as the indexer sees it. Stremio hands
 * the same id to Cinemeta, which fills in cast, director, runtime, rating,
 * description, and the rest of the rich fields automatically. Stream
 * requests come back to us with the IMDb id; we resolve it to the internal
 * title key, then to the underlying Seedr file.
 */

import type { AccountPool } from '../core/account-pool.ts';
import type { Config } from '../core/config.ts';
import type { LibraryFile, LibraryStore, TitleSummary } from '../library/store.ts';
import { json, redirect, type RouteContext } from '../core/router.ts';
import { formatBytes } from '../admin/html.ts';
import { posterUrl, backdropUrl, type TmdbMatch } from '../library/tmdb.ts';
import packageVersion from '../../package.json' with { type: 'json' };

/** Matches an IMDb id segment. */
const IMDB_ID = /^tt\d{6,}$/i;

const CATALOG_MOVIES = 'seedrpool-movies';
const CATALOG_SERIES = 'seedrpool-series';

export class AddonApp {
  #store: LibraryStore;
  #pool: () => AccountPool;
  #config: Config;

  constructor(store: LibraryStore, pool: () => AccountPool, config: Config) {
    this.#store = store;
    this.#pool = pool;
    this.#config = config;
  }

  /** Base URL for addon routes, including the unguessable secret segment. */
  get #base(): string {
    return `${this.#config.publicUrl}/${this.#config.addonSecret}`;
  }

  manifest(): Response {
    const stats = this.#store.stats();

    return json({
      id: 'dev.zayu.seedrpool',
      // From package.json, the single source of truth. This was hardcoded to
      // '0.1.0' while the shipped version moved on, so Stremio's addon list
      // displayed a version nobody was running.
      version: packageVersion.version,
      name: 'SeedrPool',
      description:
        `Private library pooled from ${this.#pool().capacity().totalAccounts} Seedr ` +
        `accounts. ${stats.titles} titles, ${formatBytes(stats.totalSize)}.`,
      // Served from this addon so the manifest has no external dependencies.
      logo: `${this.#base}/logo.png`,
      resources: ['catalog', 'meta', 'stream', 'subtitles'],
      types: ['movie', 'series'],
      catalogs: [
        {
          type: 'movie',
          id: CATALOG_MOVIES,
          name: 'SeedrPool Movies',
          // `search` makes the catalog searchable; `skip` enables paging.
          extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
        },
        {
          type: 'series',
          id: CATALOG_SERIES,
          name: 'SeedrPool Series',
          extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
        },
      ],
      // No `idPrefixes`: Stremio will call us for every meta request and
      // Cinemeta in parallel, then merge the responses. The IMDb ids in the
      // catalog do the routing.
      behaviorHints: {
        // Library content is pooled from real accounts, not public trackers,
        // so the P2P warning would be misleading.
        p2p: false,
      },
    });
  }

  /** Catalog listing, with optional search and paging. */
  catalog(ctx: RouteContext): Response {
    const type = ctx.params['type'] === 'series' ? 'series' : 'movie';
    const extra = parseExtra(ctx.params['extra'] ?? '');

    const titles = this.#store.listTitles({
      kind: type,
      ...(extra['search'] !== undefined ? { search: extra['search'] } : {}),
      limit: 1000,
    });

    // Stremio pages with `skip` rather than page numbers.
    const skip = Number(extra['skip'] ?? 0);
    const page = titles.slice(Number.isFinite(skip) ? skip : 0, (skip || 0) + 100);

    return json({ metas: page.map((t) => this.#toMetaPreview(t)) });
  }

  /** Full metadata for one title, including the episode list for series. */
  meta(ctx: RouteContext): Response {
    const imdbId = unwrapId(ctx.params['id'] ?? '');
    if (!IMDB_ID.test(imdbId)) return json({ meta: null }, { status: 404 });

    const title = this.#store.getTitleByImdbId(imdbId);
    if (!title) return json({ meta: null }, { status: 404 });

    const base = this.#toMetaPreview(title);

    if (title.kind !== 'series') {
      return json({ meta: base });
    }

    const videos = this.#store.episodesForTitle(title.key).map((ep) => ({
      // Stremio matches this against the stream request id, so the same IMDb
      // id appears across every episode — Cinemeta stays consistent.
      id: imdbId,
      title: `Episode ${ep.episode ?? 1}`,
      season: ep.season,
      episode: ep.episode ?? 1,
      released: new Date(title.addedAt).toISOString(),
    }));

    return json({ meta: { ...base, videos } });
  }

  /**
   * Streams for a title or episode.
   *
   * Stremio uses the same `id` here as in `meta.id`, which is now the IMDb
   * id. We resolve it to the internal title key, then to the files.
   */
  stream(ctx: RouteContext): Response {
    const imdbId = unwrapId(ctx.params['id'] ?? '');
    if (!IMDB_ID.test(imdbId)) return json({ streams: [] });
    const title = this.#store.getTitleByImdbId(imdbId);
    if (!title) return json({ streams: [] });

    const files = this.#store.filesForTitle(title.key);
    return json({ streams: files.map((file) => this.#toStream(file, title.name)) });
  }

  /** Sidecar subtitles found in the same Seedr folder as the video. */
  subtitles(ctx: RouteContext): Response {
    const imdbId = unwrapId(ctx.params['id'] ?? '');
    if (!IMDB_ID.test(imdbId)) return json({ subtitles: [] });
    const title = this.#store.getTitleByImdbId(imdbId);
    if (!title) return json({ subtitles: [] });

    const video = this.#store.filesForTitle(title.key)[0];
    if (!video) return json({ subtitles: [] });

    const subs = this.#store.subtitlesForFolder(video.accountId, video.folderId);

    return json({
      subtitles: subs.map((sub, index) => ({
        id: `${sub.accountId}-${sub.fileId}`,
        url: `${this.#base}/play/${sub.accountId}/${sub.fileId}`,
        // OpenSubtitles-style 3-letter code; fall back to a stable placeholder
        // when the filename did not carry a language tag.
        lang: toOpenSubtitlesCode(sub.language) ?? `und${index}`,
      })),
    });
  }

  /**
   * Mints a fresh Seedr URL and redirects to it.
   *
   * This is the only route a media player hits directly. It must stay a redirect
   * rather than a proxy: proxying 4.6 MB/s of video through a 256 MiB container
   * would waste bandwidth and memory for no gain.
   *
   * `?download=1` asks the browser to save the file rather than play it
   * inline. Seedr serves `application/octet-stream` with no
   * `Content-Disposition`, so a plain link opens a blank tab in some
   * browsers and streams inline in others. We cannot set a header on the
   * redirect target — it is Seedr's response, not ours — but appending
   * Seedr's own `filename` hint to the URL makes the CDN send the
   * attachment disposition. The admin's Download buttons use this.
   */
  async play(ctx: RouteContext): Promise<Response> {
    const accountId = ctx.params['accountId'] ?? '';
    const fileId = ctx.params['fileId'] ?? '';
    const wantsDownload = ctx.url.searchParams.get('download') === '1';

    const provider = this.#pool().provider(accountId);
    if (!provider) return new Response('unknown account', { status: 404 });

    // Count the stream for admin visibility and placement fairness. Released
    // immediately: this request ends at the redirect, and the player's actual
    // read happens against Seedr where we cannot observe its lifetime.
    const release = this.#pool().acquireStream(accountId);

    try {
      const playback = await provider.getPlaybackUrl(fileId);
      // The provider falls back to HLS when the direct CDN endpoint is
      // returning 404. A single HLS response is enough to flag the
      // account's CDN as broken — the pool then routes new content
      // elsewhere for the next 30 minutes, and the admin page shows a
      // warning pill. Conversely, a direct response is the strongest
      // signal that this account's CDN is currently fine.
      if (playback.kind === 'hls') {
        this.#pool().markCdnBroken(accountId, 'ff_get 404, fell back to HLS');
      } else {
        this.#pool().markCdnHealthy(accountId);
      }

      const target = wantsDownload
        ? withAttachmentHint(playback.url, playback.filename)
        : playback.url;

      // 302 rather than 301: the URL expires, so it must never be cached.
      return redirect(target, 302);
    } catch (err) {
      console.error(
        `play ${accountId}/${fileId} failed:`,
        err instanceof Error ? err.message : err,
      );
      return new Response('could not mint playback url', { status: 502 });
    } finally {
      release();
    }
  }

  /**
   * Returns the live Seedr CDN URL for a file as JSON. Used by the operator
   * console's "Copy download URL" button — the URL is the same `ff_get`
   * address Stremio's player would follow, which then 302s to the
   * `/download/archive/<sha256>?token=...&exp=...` archive URL.
   */
  async fileUrl(ctx: RouteContext): Promise<Response> {
    const result = await this.#mintPlaybackUrl(ctx);
    if (result instanceof Response) return result;
    const params = ctx.request.url.includes('?')
      ? new URLSearchParams(ctx.request.url.split('?')[1] ?? '')
      : new URLSearchParams();
    return new Response(
      JSON.stringify({
        url: result.url,
        filename: result.filename,
        expiresAt: result.expiresAt,
        kind: result.kind,
        accountId: ctx.params['accountId'] ?? params.get('accountId') ?? '',
        fileId: ctx.params['fileId'] ?? params.get('fileId') ?? '',
      }),
      { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }

  /**
   * 302-redirects to the live Seedr CDN URL. Used by the operator
   * console's "Download" button — opens the file in a new tab, the
   * browser follows the Seedr 302 to the archive URL.
   */
  async fileDownload(ctx: RouteContext): Promise<Response> {
    const url = await this.#mintPlaybackUrl(ctx);
    if (url instanceof Response) return url;
    return redirect(url.url, 302);
  }

  /**
   * Mints a fresh Seedr URL for a file. Returns either a response (on
   * error) or the playback metadata.
   */
  async #mintPlaybackUrl(
    ctx: RouteContext,
  ): Promise<
    | Response
    | { url: string; filename: string; expiresAt: number | null; kind: 'direct' | 'hls' }
  > {
    const params = ctx.request.url.includes('?')
      ? new URLSearchParams(ctx.request.url.split('?')[1] ?? '')
      : new URLSearchParams();
    const accountId = ctx.params['accountId'] ?? params.get('accountId') ?? '';
    const fileId = ctx.params['fileId'] ?? params.get('fileId') ?? '';
    if (!accountId || !fileId) {
      return new Response(JSON.stringify({ error: 'missing accountId or fileId' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const provider = this.#pool().provider(accountId);
    if (!provider) {
      return new Response(JSON.stringify({ error: `unknown account ${accountId}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    try {
      return await provider.getPlaybackUrl(fileId);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }
  }

  /**
   * Generated poster fallback.
   *
   * Used only when the title has no IMDb match yet, so we have no TMDB poster
   * to point at. Most entries go straight to TMDB; this is the safety net
   * for the first 30 minutes after a magnet finishes.
   */
  poster(ctx: RouteContext): Response {
    const raw = ctx.params['key'] ?? '';
    // Titles may have colons in the key after URL-decoding. The router passed
    // us a percent-encoded key plus a `.svg` suffix; strip that.
    const key = raw.endsWith('.svg') ? raw.slice(0, -4) : raw;
    const title = this.#store.getTitle(key);
    const name = title?.name ?? 'Unknown';
    const year = title?.year !== null && title?.year !== undefined ? String(title.year) : '';

    return new Response(posterSvg(name, year), {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        // Safe to cache: the poster only changes if the title's name changes.
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  /** Addon logo, same generator as posters so there is no binary asset. */
  logo(): Response {
    return new Response(posterSvg('SeedrPool', ''), {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  #toMetaPreview(title: TitleSummary) {
    const resolution = title.bestResolution !== null ? `${title.bestResolution}p` : 'unknown';
    // The Stremio id MUST be the IMDb id, otherwise Cinemeta will not be called
    // in parallel. Titles without an IMDb match get a synthetic id so they
    // remain browseable but skip Cinemeta enrichment.
    const id = title.imdbId ?? `sp:${title.key}`;
    const description =
      `${title.fileCount} file(s), ${formatBytes(title.totalSize)}, ${resolution}. ` +
      'Stored in your Seedr pool.';

    const meta: Record<string, unknown> = {
      id,
      type: title.kind,
      name: title.name,
      posterShape: 'poster',
      description,
    };

    if (title.imdbId !== null) {
      // Stremio reads this and pairs the meta with Cinemeta's entry.
      meta['imdb_id'] = title.imdbId;
    }
    if (title.year !== null) {
      meta['releaseInfo'] = String(title.year);
    }
    return meta;
  }

  #toStream(file: LibraryFile, titleName: string) {
    const quality = file.resolution !== null ? `${file.resolution}p` : 'unknown';
    const groupSuffix = file.group !== null ? ` · ${file.group}` : '';
    const episode =
      file.season !== null && file.episode !== null
        ? ` S${String(file.season).padStart(2, '0')}E${String(file.episode).padStart(2, '0')}`
        : '';

    // Per-show binge group, not per-resolution: a 720p and 1080p of the next
    // episode both trigger Stremio's auto-play.
    const bingeGroup = `seedrpool-${file.titleKey}`;

    return {
      name: `SeedrPool ${quality}`,
      // `description` replaces the deprecated `title` field. Includes the account
      // so Jay can see which copy is serving without opening the admin page.
      description:
        `${titleName}${episode}\n${formatBytes(file.size)}${groupSuffix}\n` +
        `${file.accountId} · ${file.name}`,
      url: `${this.#base}/play/${file.accountId}/${file.fileId}`,
      behaviorHints: {
        // Seedr serves application/octet-stream, not video/mp4, so the web
        // player cannot be trusted to handle it (RESEARCH.md).
        notWebReady: true,
        // Passed to subtitle addons for matching.
        filename: file.name,
        videoSize: file.size,
        bingeGroup,
      },
    };
  }
}

/**
 * Adds Seedr's download-filename hint to a playback URL.
 *
 * Seedr's `ff_get` endpoint accepts a `filename` query parameter and echoes
 * it back as `Content-Disposition: attachment`, which is the only lever we
 * have: the bytes come from Seedr's CDN, so we cannot attach a header of our
 * own to a 302 target.
 *
 * An HLS manifest is left untouched — a `.m3u8` is a playlist, and asking the
 * browser to save it yields a text file rather than a video.
 */
export function withAttachmentHint(url: string, filename: string): string {
  if (filename === '') return url;
  if (url.includes('.m3u8')) return url;
  try {
    const parsed = new URL(url);
    // Do not clobber a hint Seedr already set.
    if (parsed.searchParams.has('filename')) return url;
    parsed.searchParams.set('filename', filename);
    return parsed.toString();
  } catch {
    // A malformed URL is Seedr's problem, not ours; hand it back untouched
    // rather than failing the download outright.
    return url;
  }
}

/**
 * Strips the `.json` suffix Stremio always appends to meta/stream/subtitles
 * ids. The router does not split this off because the path is matched
 * segment-by-segment.
 */
export function unwrapId(id: string): string {
  return id.endsWith('.json') ? id.slice(0, -5) : id;
}

/** Maps a guessed 2-letter code to OpenSubtitles' 3-letter codes. */
function toOpenSubtitlesCode(code: string | null): string | null {
  if (code === null) return null;
  const lower = code.toLowerCase();
  const mapped = OPEN_SUBTITLES_CODES[lower];
  if (mapped !== undefined) return mapped;
  // Already 3 letters? Pass through.
  if (/^[a-z]{3}$/.test(lower)) return lower;
  return null;
}

/** Mapping of common 2-letter codes to OpenSubtitles' preferred 3-letter codes. */
const OPEN_SUBTITLES_CODES: Record<string, string> = {
  en: 'eng',
  es: 'spa',
  fr: 'fre',
  de: 'ger',
  it: 'ita',
  pt: 'por',
  nl: 'dut',
  pl: 'pol',
  ru: 'rus',
  ja: 'jpn',
  ko: 'kor',
  zh: 'chi',
  ar: 'ara',
  hi: 'hin',
  ta: 'tam',
  te: 'tel',
};

/**
 * Parses Stremio's extra-args segment.
 *
 * Arrives as a querystring-shaped path segment, e.g. `search=dune&skip=100`.
 */
export function parseExtra(segment: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (segment === '') return out;

  for (const [key, value] of new URLSearchParams(segment)) {
    out[key] = value;
  }
  return out;
}

/** Builds a text-only poster. Deterministic hue so a title looks consistent. */
export function posterSvg(name: string, year: string): string {
  const hue = hashHue(name);
  const lines = wrapText(name, 14, 4);

  const text = lines
    .map(
      (line, i) =>
        `<text x="150" y="${190 + i * 42}" font-size="34" font-weight="600" ` +
        `text-anchor="middle" fill="#f2f4f8">${escapeXml(line)}</text>`,
    )
    .join('');

  const yearText =
    year === ''
      ? ''
      : `<text x="150" y="${190 + lines.length * 42 + 14}" font-size="24" ` +
        `text-anchor="middle" fill="#9aa3b2">${escapeXml(year)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="hsl(${hue},38%,26%)"/>
<stop offset="100%" stop-color="hsl(${hue},42%,12%)"/>
</linearGradient></defs>
<rect width="300" height="450" fill="url(#g)"/>
<g font-family="system-ui,-apple-system,Segoe UI,sans-serif">${text}${yearText}
<text x="150" y="424" font-size="15" text-anchor="middle" fill="#6ea8fe" opacity="0.75">SeedrPool</text>
</g></svg>`;
}

/** Greedy word wrap, truncating with an ellipsis past `maxLines`. */
function wrapText(value: string, perLine: number, maxLines: number): string[] {
  const words = value.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= perLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }

  if (current !== '' && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return ['Untitled'];

  const last = lines[lines.length - 1];
  if (lines.length === maxLines && last !== undefined && words.join(' ').length > value.length) {
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Re-exported for tests that want the TMDB URL helpers. */
export { posterUrl, backdropUrl };
export type { TmdbMatch };
