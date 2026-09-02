import { describe, it, expect } from 'vitest';
import { parseMediaName, mediaKey, normalizeTitle } from '../../src/library/parse.ts';

describe('parseMediaName', () => {
  it('parses a clean movie', () => {
    const p = parseMediaName('Sintel.mp4');
    expect(p.title).toBe('Sintel');
    expect(p.year).toBeNull();
    expect(p.season).toBeNull();
    expect(p.episode).toBeNull();
    expect(p.resolution).toBeNull();
    expect(p.group).toBeNull();
    expect(p.kind).toBe('movie');
  });

  it('strips a www.site.tld prefix', () => {
    const p = parseMediaName('www.1TamilMV.ing - MOURINHO S01E02.mkv');
    expect(p.title).toBe('MOURINHO');
    expect(p.season).toBe(1);
    expect(p.episode).toBe(2);
    expect(p.kind).toBe('series');
  });

  it('strips a [site.tag] prefix but leaves a bracketed year', () => {
    const p = parseMediaName('[YTS.MX] Dune Part Two (2024) 1080p WEBRip x265.mp4');
    expect(p.title).toBe('Dune Part Two');
    expect(p.year).toBe(2024);
    expect(p.resolution).toBe(1080);
  });

  it('extracts year, resolution, and group from a release name', () => {
    const p = parseMediaName('The.Matrix.1999.1080p.BluRay.x264-RARBG.mkv');
    expect(p.title).toBe('The Matrix');
    expect(p.year).toBe(1999);
    expect(p.resolution).toBe(1080);
    expect(p.group).toBe('RARBG');
  });

  it('parses 1x03 format', () => {
    const p = parseMediaName('Movie 1x03 HDTV.avi');
    expect(p.title).toBe('Movie');
    expect(p.season).toBe(1);
    expect(p.episode).toBe(3);
  });

  it('strips a leading bracketed year', () => {
    const p = parseMediaName('(2019) Parasite 1080p.mkv');
    expect(p.title).toBe('Parasite');
    expect(p.year).toBe(2019);
  });

  it('extracts 4K/UHD as 2160p', () => {
    const p = parseMediaName('Show.Name.2020.UHD.BluRay.x265.mkv');
    expect(p.resolution).toBe(2160);
  });

  it('handles a season pack with no episode', () => {
    const p = parseMediaName('Show S02 1080p WEB-DL.mkv');
    expect(p.season).toBe(2);
    expect(p.episode).toBeNull();
    expect(p.kind).toBe('series');
  });

  it('does not strip The.Matrix as if it were a domain', () => {
    // The dot between Matrix and 1999 has no dash, so the domain prefix must
    // not match. Regression for a too-greedy early version.
    const p = parseMediaName('The.Matrix.1999.1080p.BluRay.x264-RARBG.mkv');
    expect(p.title).toBe('The Matrix');
  });

  it('refuses to strip everything when the name is only a tag', () => {
    const p = parseMediaName('[group].mp4');
    // Falls back to the original (sans extension) rather than an empty title.
    expect(p.title).not.toBe('');
  });
});

describe('mediaKey', () => {
  it('matches across accounts regardless of resolution', () => {
    const a = parseMediaName('Cosmos.Laundromat.1080p.mkv');
    const b = parseMediaName('Cosmos Laundromat.mp4');
    expect(mediaKey(a)).toBe(mediaKey(b));
  });

  it('treats "Foo & Bar" and "Foo and Bar" as the same title', () => {
    const a = parseMediaName('Foo & Bar.2020.mkv');
    const b = parseMediaName('Foo and Bar 2020.mkv');
    expect(mediaKey(a)).toBe(mediaKey(b));
  });

  it('treats the same series with and without year as the same', () => {
    const a = parseMediaName('www.1TamilMV.ing - Mourinho (2026) S01E02.mkv');
    const b = parseMediaName('Mourinho S01E03.mkv');
    // Series key drops the year so a single season-marked file does not
    // fragment the show across the library.
    expect(mediaKey(a)).toBe(mediaKey(b));
  });
});

describe('normalizeTitle', () => {
  it('lowercases and removes non-alphanumerics', () => {
    expect(normalizeTitle('Spider-Man: No Way Home')).toBe('spidermannowayhome');
  });
});
