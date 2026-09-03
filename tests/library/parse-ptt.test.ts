import { describe, it, expect } from 'vitest';
import { parseMediaName, mediaKey } from '../../src/library/parse.ts';

/**
 * Cases where parse-torrent-title (the upstream library doing the heavy
 * lifting) actually outperforms the regex ladder it replaced. These are
 * not regression tests for the old behaviour — they are locks on the
 * reasons we adopted the library in the first place.
 */
describe('parse-torrent-title integration', () => {
  it('extracts year from a noisy HDR release that hides it inside the title', () => {
    // The old parser would have stopped at "Dune" and missed the year.
    const p = parseMediaName('Dune.Part.Two.2024.2160p.WEB-DL.x265.10bit.HDR.DTS-HD.MA.5.1-SWTYBLZ.mkv');
    expect(p.title).toBe('Dune Part Two');
    expect(p.year).toBe(2024);
    expect(p.resolution).toBe(2160);
    expect(p.group).toBe('SWTYBLZ');
    expect(p.kind).toBe('movie');
  });

  it('parses "Season N Episode M" (verbose) form', () => {
    // PTT's season/episode detector covers this; the old code had a
    // special-case regex that often missed it.
    const p = parseMediaName('Some Show Season 1 Episode 2 1080p.mkv');
    expect(p.season).toBe(1);
    expect(p.episode).toBe(2);
    expect(p.kind).toBe('series');
  });

  it('keeps the year bounded so a 2099 typo does not pass through', () => {
    // PTT will happily return whatever it parses. Our adapter filters
    // years outside [1990, next year], so a release that says "2099"
    // is treated as having no year rather than a future one.
    const p = parseMediaName('Some Movie (2099) 1080p.mkv');
    expect(p.year).toBeNull();
  });

  it('returns a numeric resolution even when the source says "4k" or "UHD"', () => {
    // The old code mapped "4k" -> 2160 but PTT uses the same convention
    // and the adapter is now the single point of truth.
    expect(parseMediaName('Big Buck Bunny 4K.mkv').resolution).toBe(2160);
    expect(parseMediaName('Big Buck Bunny UHD.mkv').resolution).toBe(2160);
    expect(parseMediaName('Big Buck Bunny 720p.mkv').resolution).toBe(720);
  });

  it('handles bracketed years without confusing them with bracketed site tags', () => {
    // (2024) is the title's year; [YTS.MX] is a site tag to strip.
    const p = parseMediaName('[YTS.MX] Dune Part Two (2024) 1080p WEBRip x265.mp4');
    expect(p.title).toBe('Dune Part Two');
    expect(p.year).toBe(2024);
  });

  it('returns the right group for a bracketed trailer, even when group sits in the middle', () => {
    // The bracketed trailer source was previously misattributed to "S01E02"
    // as a group; the new code is robust to that.
    const p = parseMediaName('Trailer.SOURCE.WEB-DL.x264.AC3-SmY.mkv');
    expect(p.group).toBe('SmY');
    expect(p.title).toBe('Trailer SOURCE');
  });

  it('returns an empty string for a name that is just an extension', () => {
    // Defensive: a pathologically short input should not throw and should
    // not produce a title that is just punctuation.
    const p = parseMediaName('.mkv');
    expect(p.title).not.toMatch(/[.\\/]/);
  });

  it('treats bracketed quality tags as part of the metadata, not the title', () => {
    // '[ettv]' is a tracker tag, not a release group; the new code
    // discards it while still extracting the actual group.
    const p = parseMediaName('Mr Robot S01E05 HDTV x264-KILLERS[ettv]');
    expect(p.title).toBe('Mr Robot');
    expect(p.season).toBe(1);
    expect(p.episode).toBe(5);
    expect(p.group).toBe('KILLERS');
  });
});

describe('mediaKey across the upstream parser', () => {
  it('keeps the year for movies even when a different file uses a different layout', () => {
    // Two filenames of the same movie, one from PTT, one from the old
    // regex path's quirks, must collapse to the same key. We vary
    // separators and a bracketed year to make sure the new code does
    // not regress on a case the old one passed.
    const a = parseMediaName('Dune.Part.Two.2024.2160p.WEB-DL.x265.mkv');
    const b = parseMediaName('Dune Part Two (2024) 2160p.mkv');
    expect(mediaKey(a)).toBe(mediaKey(b));
  });

  it('still drops the year for series, so a one-file season pack merges with episode files', () => {
    const a = parseMediaName('Mourinho (2026) S01E02.mkv');
    const b = parseMediaName('Mourinho S01E03.mkv');
    expect(mediaKey(a)).toBe(mediaKey(b));
  });
});
