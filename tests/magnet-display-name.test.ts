import { describe, it, expect } from 'vitest';
import { magnetDisplayName } from '../src/admin/app.ts';

describe('magnetDisplayName', () => {
  it('extracts and decodes the dn= parameter', () => {
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc&dn=In.the.Mood.2000')).toBe(
      'In.the.Mood.2000',
    );
  });

  it('handles URL-encoded values', () => {
    expect(
      magnetDisplayName('magnet:?xt=urn:btih:abc&dn=In%20the%20Mood%20for%20Love%202000'),
    ).toBe('In the Mood for Love 2000');
  });

  it('decodes plus signs as spaces (the form-encoded convention)', () => {
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc&dn=Foo+Bar')).toBe('Foo Bar');
  });

  it('returns null when there is no dn= parameter', () => {
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc')).toBeNull();
  });

  it('returns null on a malformed URL', () => {
    expect(magnetDisplayName('not a magnet')).toBeNull();
  });

  it('returns null when dn= cannot be decoded', () => {
    // %ZZ is not a valid percent escape; decodeURIComponent throws.
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc&dn=%ZZ')).toBeNull();
  });
});
