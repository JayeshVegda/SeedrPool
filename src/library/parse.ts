/**
 * Filename parsing for media titles.
 *
 * Release names are messy and there is no authoritative grammar, so this is
 * heuristic by design: extract what is confidently present and leave the rest
 * null rather than guessing.
 */

export interface ParsedName {
  /** Cleaned title with separators and metadata stripped. */
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** Vertical resolution, e.g. 1080. */
  resolution: number | null;
  /** Release group, when it appears in the conventional trailing position. */
  group: string | null;
  kind: 'movie' | 'series';
}

/** Tokens that mark the end of a title and the start of release metadata. */
const METADATA_TOKENS = [
  '2160p', '1440p', '1080p', '720p', '576p', '480p', '360p',
  '4k', 'uhd', 'hdr10', 'hdr', 'dolby', 'dv', 'sdr',
  'bluray', 'blu-ray', 'brrip', 'bdrip', 'remux',
  'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'dvdrip', 'dvd',
  'hdcam', 'cam', 'ts', 'telesync', 'screener', 'r5',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'atmos', 'flac', 'mp3',
  'dual', 'multi', 'subbed', 'dubbed', 'repack', 'proper', 'extended',
  'unrated', 'directors', 'imax', 'limited', 'internal',
];

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|m4v|webm|ts|m2ts|mpg|mpeg)$/i;

/**
 * Leading junk that release sites prepend to filenames.
 *
 * Measured against Jay's real library: `www.1TamilMV.ing - MOURINHO S01E02.mkv`
 * would otherwise be titled "www 1TamilMV ing - MOURINHO", which no metadata
 * provider can match.
 *
 * Both patterns require a dash-style separator after the prefix. Matching a bare
 * dot would eat real titles — `The.Matrix.1999.1080p...` looks exactly like a
 * domain followed by a dot.
 */
const LEADING_JUNK = [
  // www.site.tld followed by a dash, e.g. "www.1TamilMV.ing - "
  /^\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,6}\s*[-–_]+\s*/i,
  // A bracketed tag at the start, e.g. "[YTS.MX] ". A bracketed year is left
  // alone, since that is the title's own year rather than a site tag.
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

/** Parses a release-style filename into structured fields. */
export function parseMediaName(filename: string): ParsedName {
  const withoutExtension = filename.replace(VIDEO_EXTENSIONS, '');
  const cleaned = stripLeadingJunk(withoutExtension);

  // Resolution and group are read from the full name: a leading `[1080p]` tag is
  // junk for titling purposes but still states the resolution.
  const resolution = extractResolution(withoutExtension);
  const group = extractGroup(withoutExtension);
  const episodeInfo = extractSeasonEpisode(cleaned);
  const year = extractYear(cleaned);

  // The title ends at the first metadata token, year, or season marker.
  const title = extractTitle(cleaned, {
    year,
    seasonIndex: episodeInfo?.index ?? null,
  });

  return {
    title,
    year,
    season: episodeInfo?.season ?? null,
    episode: episodeInfo?.episode ?? null,
    resolution,
    group,
    kind: episodeInfo ? 'series' : 'movie',
  };
}

function extractResolution(name: string): number | null {
  const explicit = /\b(2160|1440|1080|720|576|480|360)[pi]\b/i.exec(name);
  if (explicit?.[1]) return Number(explicit[1]);
  // 4K and UHD are conventional aliases for 2160p.
  if (/\b(4k|uhd)\b/i.test(name)) return 2160;
  return null;
}

/**
 * Extracts season and episode, covering the common notations.
 *
 * Returns the match index so the title can be truncated there.
 */
function extractSeasonEpisode(
  name: string,
): { season: number; episode: number | null; index: number } | null {
  // S01E02, s1e2, S01.E02
  const standard = /\bS(\d{1,2})[\s._-]?E(\d{1,3})\b/i.exec(name);
  if (standard?.[1] && standard[2]) {
    return {
      season: Number(standard[1]),
      episode: Number(standard[2]),
      index: standard.index,
    };
  }

  // 1x02
  const cross = /\b(\d{1,2})x(\d{1,3})\b/i.exec(name);
  if (cross?.[1] && cross[2]) {
    return { season: Number(cross[1]), episode: Number(cross[2]), index: cross.index };
  }

  // "Season 1 Episode 2"
  const verbose = /\bseason[\s._-]?(\d{1,2})(?:[\s._-]?episode[\s._-]?(\d{1,3}))?\b/i.exec(name);
  if (verbose?.[1]) {
    return {
      season: Number(verbose[1]),
      episode: verbose[2] ? Number(verbose[2]) : null,
      index: verbose.index,
    };
  }

  // Bare S01, typically a season pack.
  const seasonOnly = /\bS(\d{2})\b/.exec(name);
  if (seasonOnly?.[1]) {
    return { season: Number(seasonOnly[1]), episode: null, index: seasonOnly.index };
  }

  return null;
}

/** Finds a plausible release year, preferring a parenthesised one. */
function extractYear(name: string): number | null {
  const currentYear = new Date().getFullYear();

  // Parenthesised years are unambiguous, so try them first.
  const bracketed = /[([](19\d{2}|20\d{2})[)\]]/.exec(name);
  if (bracketed?.[1]) return Number(bracketed[1]);

  // Otherwise take the last plausible year, since titles may contain numbers.
  const all = [...name.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const value = Number(all[i]?.[1]);
    if (value >= 1900 && value <= currentYear + 1) return value;
  }
  return null;
}

/** Extracts a trailing release group, e.g. `-RARBG` or `[YTS.MX]`. */
function extractGroup(name: string): string | null {
  const bracketed = /\[([A-Za-z0-9._-]{2,20})\]\s*$/.exec(name);
  if (bracketed?.[1]) return bracketed[1];

  const dashed = /-([A-Za-z0-9]{2,20})$/.exec(name.trim());
  if (dashed?.[1] && !/^\d+$/.test(dashed[1])) return dashed[1];

  return null;
}

/** Truncates at the first metadata marker and normalizes separators. */
function extractTitle(
  name: string,
  context: { year: number | null; seasonIndex: number | null },
): string {
  let working = name;

  // Cut at the season marker when present, since anything after is episode data.
  if (context.seasonIndex !== null && context.seasonIndex > 0) {
    working = working.slice(0, context.seasonIndex);
  }

  // Cut at the year, which conventionally follows the title.
  if (context.year !== null) {
    const yearMatch = new RegExp(`[([]?${context.year}[)\\]]?`).exec(working);
    if (yearMatch && yearMatch.index > 0) {
      working = working.slice(0, yearMatch.index);
    }
  }

  // Cut at the earliest metadata token.
  let cut = working.length;
  for (const token of METADATA_TOKENS) {
    const match = new RegExp(`\\b${escapeRegex(token)}\\b`, 'i').exec(working);
    if (match && match.index > 0 && match.index < cut) {
      cut = match.index;
    }
  }
  working = working.slice(0, cut);

  return working
    .replace(/[._]+/g, ' ')
    // A leading bracketed year belongs to the title's metadata, not its name.
    .replace(/^\s*[([{]\s*((?:19|20)\d{2})\s*[)\]}]\s*/, '')
    .replace(/\s*-\s*$/, '')
    .replace(/[([{]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
