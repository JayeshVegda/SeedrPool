/**
 * Filename parsing for media titles.
 *
 * Primary engine is `parse-torrent-title` (clement-escolano, MIT, zero
 * dependencies, 23 KB). It already handles the structured release metadata
 * — resolution, year, season, codec, group — better than the regex ladder
 * it replaces. We run our own site-prefix stripper first, because PTT does
 * not handle the `www.1TamilMV.ing - TITLE` shape that real public-tracker
 * releases often arrive in.
 *
 * What we kept from the hand-rolled version:
 *   - The site-prefix stripper (PTT cannot guess which `xxx.tld` tokens are
 *     domain names versus title fragments).
 *   - The extension stripper (PTT does not strip `.mkv`).
 *   - The year-validity bound (PTT happily returns 2099 if the file says so).
 *   - The `mediaKey` shape (depends on title + year, not PTT's own output).
 *
 * What we dropped:
 *   - The 70-line METADATA_TOKENS list, replaced by PTT's built-in detector.
 *   - The bespoke S01E02 / 1x02 / "Season N Episode M" extractor.
 *   - The trailing-group regex.
 *   - The title-cuts-at-first-metadata-token logic.
 */

import { parse as ptt } from 'parse-torrent-title';

export interface ParsedName {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  resolution: number | null;
  group: string | null;
  kind: 'movie' | 'series';
}

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|m4v|webm|ts|m2ts|mpg|mpeg)$/i;

/**
 * Leading junk that release sites prepend to filenames.
 *
 * PTT's heuristics are built for the "Movie.Year.Quality" shape and do
 * not recognize site domains, so `www.1TamilMV.ing - MOURINHO S01E02.mkv`
 * would otherwise be titled "www 1TamilMV ing - MOURINHO", which no
 * metadata provider can match.
 *
 * Both patterns require a dash-style separator after the prefix. Matching
 * a bare dot would eat real titles — `The.Matrix.1999.1080p...` looks
 * exactly like a domain followed by a dot.
 */
const LEADING_JUNK = [
  // www.site.tld followed by a dash, e.g. "www.1TamilMV.ing - ".
  //
  // The TLD is matched as any run of letters rather than a fixed 2-6 range:
  // real pirate-site domains use long new-gTLDs, and a 2-6 cap missed one in
  // production — `www.5MovieRulz.software - Breakfast (2026) ...` indexed
  // under the title "www 5MovieRulz software - Breakfast", matched nothing
  // on TMDB, and the file was invisible in Stremio while sitting right there
  // on Seedr. The dash separator is what makes an unbounded TLD safe:
  // `The.Matrix.1999.1080p - ...`-style titles still cannot match, because
  // there is no dash directly after a `.tld`-looking token.
  /^\s*(?:www\.)?[a-z0-9-]+\.[a-z]+\s*[-–_]+\s*/i,
  // A bracketed tag at the start, e.g. "[YTS.MX] ". A bracketed year is
  // left alone, since that is the title's own year rather than a site tag.
  /^\s*[[({](?!\s*(?:19|20)\d{2}\s*[)\]}])[^\])}]{1,30}[\])}]\s*[-–_]?\s*/,
];

/** Strips repeated leading site prefixes and bracketed tags. */
function stripLeadingJunk(name: string): string {
  let working = name;
  // Bounded loop: some names carry a domain and a bracketed tag.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = working;
    for (const pattern of LEADING_JUNK) {
      working = working.replace(pattern, '');
    }
    if (working === before) break;
  }
  // Refuse to strip everything: a name that is only a tag keeps its original.
  return working.trim() === '' ? name : working;
}

/**
 * Trailing tracker tags that sites append to filenames.
 *
 * PTT treats the last bracketed token as `group`, so
 * `...x264-KILLERS[ettv]` would otherwise report `ettv` (the tracker)
 * instead of `KILLERS` (the release group). Stripping the trailing tag
 * lets PTT see `...x264-KILLERS` and return the real group. A trailing
 * year like `(2024)` is left alone since that is title metadata.
 */
const TRAILING_JUNK = /\s*[[({](?!\s*(?:19|20)\d{2}\s*[)\]}]\s*$)[^\])}]{1,30}[\])}]\s*$/;

/** Strips trailing tracker tags, refusing to strip everything. */
function stripTrailingJunk(name: string): string {
  let working = name;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = working;
    working = working.replace(TRAILING_JUNK, '');
    if (working === before) break;
  }
  return working.trim() === '' ? name : working;
}

/**
 * Returns the resolution as a number (1080, 2160, 720, …) or null.
 *
 * PTT returns the human-readable string ('1080p', '2160p', '4k'). The
 * downstream code (addon's stream description, admin pills, library
 * filters) all use the integer form, so this adapter is the one place
 * that knows about the convention.
 */
function resolutionToNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  if (lower === '4k' || lower === 'uhd') return 2160;
  const m = /^(\d{3,4})p$/.exec(lower);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Whether to keep a year PTT reported.
 *
 * PTT does not bound the year to "plausible" values, so a release that
 * says "2099" (typo, fake, or wishful) would otherwise pass through. The
 * public-tracker dates we care about are 1990 through next year.
 */
function keepYear(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const upper = new Date().getFullYear() + 1;
  return value >= 1990 && value <= upper ? value : null;
}

/** Strips surrounding whitespace and a leading bracketed year. */
function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[._]+/g, ' ')
    // A leading bracketed year belongs to the title's metadata, not its name.
    .replace(/^\s*[([{]\s*((?:19|20)\d{2})\s*[)\]}]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parses a release-style filename into structured fields. */
export function parseMediaName(filename: string): ParsedName {
  const withoutExtension = filename.replace(VIDEO_EXTENSIONS, '');
  const cleaned = stripTrailingJunk(stripLeadingJunk(withoutExtension));

  const parsed = ptt(cleaned) as {
    title?: unknown;
    year?: unknown;
    season?: unknown;
    episode?: unknown;
    resolution?: unknown;
    group?: unknown;
  };

  const title = cleanTitle(parsed.title);
  const season = typeof parsed.season === 'number' ? parsed.season : null;
  const episode = typeof parsed.episode === 'number' ? parsed.episode : null;

  return {
    title,
    year: keepYear(parsed.year),
    season,
    episode,
    resolution: resolutionToNumber(parsed.resolution),
    group: typeof parsed.group === 'string' && parsed.group !== '' ? parsed.group : null,
    kind: season !== null || episode !== null ? 'series' : 'movie',
  };
}

/**
 * Normalizes a title for comparison: lowercase, alphanumeric only.
 *
 * Used to group different releases of the same film across accounts.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Stable identifier for a logical title, used as the addon's media id.
 *
 * Movies include the year (so a 1998 `The Avengers` and a 2012 one stay
 * separate). Series omit it (so `Mourinho` with one year-marked filename and
 * `Mourinho` without still collapse to a single entry).
 */
export function mediaKey(parsed: ParsedName): string {
  const base = normalizeTitle(parsed.title);
  if (base === '') return '';
  return parsed.kind === 'series' || parsed.year === null ? base : `${base}-${parsed.year}`;
}
