/**
 * Error types and helpers shared by the Seedr V1 and V2 providers.
 *
 * These live outside both provider files because the two APIs are otherwise
 * independent: V1 must not import from V2 just to reuse an error class.
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

/** Builds a readable message from Seedr's inconsistent error shapes. */
export function describeError(data: Record<string, unknown>): string {
  for (const key of ['reason_phrase', 'error_description', 'error', 'message']) {
    const value = data[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return 'unknown error';
}

/** Reads a `Retry-After` header, when the server provides one. */
export function retryAfterSeconds(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
