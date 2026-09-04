/**
 * Error types and helpers shared by the Seedr provider layer.
 *
 * These live outside the provider file so the pool, the admin, and the tests
 * can catch a `RateLimitError` without importing Seedr's endpoint knowledge.
 * Only V1 remains — V2 was deleted once Seedr stopped authorizing new device
 * grants — but the split is still the right shape: `AccountPool` branches on
 * these error names and must not depend on a specific API version.
 */

import type { Quota } from '../core/types.ts';

/** Raised for transport or unexpected-status failures. */
export class SeedrApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SeedrApiError';
    this.status = status;
  }
}

/**
 * Raised when Seedr is throttling. Always transient — the caller should back off
 * and retry rather than treat the operation as failed.
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export function makeQuota(used: number, max: number): Quota {
  return {
    used,
    max,
    get free() {
      return Math.max(0, this.max - this.used);
    },
  };
}

/** Extracts the `e=` unix expiry that Seedr embeds in signed URLs. */
export function parseExpiry(url: string): number | null {
  try {
    const e = new URL(url).searchParams.get('e');
    if (!e) return null;
    const parsed = Number(e);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
