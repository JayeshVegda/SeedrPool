/**
 * Pulls the human-readable display name out of a magnet URI.
 *
 * The display name lives in the `dn=` parameter, URL-encoded, with `+`
 * as a space alias. Returns null when the magnet has no name.
 */
export function magnetDisplayName(magnet: string): string | null {
  const match = /[?&]dn=([^&]+)/.exec(magnet);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1].replaceAll('+', ' '));
  } catch {
    return null;
  }
}
