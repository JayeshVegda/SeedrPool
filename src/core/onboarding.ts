/**
 * Device-code onboarding for new accounts.
 *
 * Seedr V2 has no password grant and approval requires a logged-in browser
 * session, so each account is authorized once by hand (RESEARCH.md). This module
 * runs several device flows at once so the user can approve them in one sitting
 * rather than serially.
 *
 * Once approved, an account never needs attention again unless its refresh chain
 * breaks.
 */

import type { TokenStore } from './token-store.ts';
import {
  requestDeviceCode,
  pollDeviceCode,
  RateLimitError,
  type DeviceCodeRequest,
} from '../providers/seedr-v2.ts';

/** A pending authorization the user has not yet approved. */
export interface PendingAuth {
  /** Local account id this will become, e.g. `acc2`. */
  accountId: string;
  request: DeviceCodeRequest;
  /** Unix ms after which the device code is no longer valid. */
  expiresAt: number;
}

export type OnboardResult =
  | { accountId: string; status: 'authorized'; userId: string; spaceMax: number }
  | { accountId: string; status: 'expired' }
  | { accountId: string; status: 'failed'; reason: string };

/** Allocates the next free `accN` id given the ids already in use. */
export function nextAccountId(existing: string[]): string {
  const used = new Set(existing);
  for (let i = 1; ; i += 1) {
    const candidate = `acc${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Starts `count` device flows and returns the links for the user to approve.
 *
 * Codes expire in 30 minutes, so requesting many at once is a tradeoff: it saves
 * repeated round trips but leaves less time per account.
 */
export async function beginOnboarding(
  store: TokenStore,
  count: number,
): Promise<PendingAuth[]> {
  const existing = store.list().map((a) => a.id);
  const pending: PendingAuth[] = [];

  for (let i = 0; i < count; i += 1) {
    const accountId = nextAccountId([...existing, ...pending.map((p) => p.accountId)]);
    const request = await requestDeviceCode();
    pending.push({
      accountId,
      request,
      expiresAt: Date.now() + request.expiresIn * 1000,
    });
  }

  return pending;
}

/** Tunables for polling; the defaults suit real use and tests override them. */
export interface PollOptions {
  signal?: AbortSignal;
  /** First backoff step after a throttled poll. Doubles up to `maxBackoffMs`. */
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Polls one pending authorization until approved or expired, then persists it.
 *
 * `fetchQuota` supplies the account's capacity once tokens exist; it is injected
 * so this module stays independent of provider construction.
 */
export async function completeAuth(
  store: TokenStore,
  pending: PendingAuth,
  fetchQuota: (accessToken: string) => Promise<number>,
  options: PollOptions = {},
): Promise<OnboardResult> {
  const pollIntervalMs = Math.max(1, pending.request.interval) * 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  let backoffMs = options.rateLimitBackoffMs ?? 5_000;

  while (Date.now() < pending.expiresAt) {
    if (options.signal?.aborted) {
      return { accountId: pending.accountId, status: 'failed', reason: 'aborted' };
    }

    let grant;
    try {
      grant = await pollDeviceCode(pending.request.deviceCode);
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Seedr throttles this endpoint when several flows poll together. The
        // device code stays valid, so back off and keep going rather than
        // discarding an approval the user may already have given.
        await sleep(backoffMs, options.signal);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }
      return {
        accountId: pending.accountId,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (grant) {
      // Capacity is informational; a failure here must not discard tokens the
      // user just approved.
      let spaceMax = 0;
      try {
        spaceMax = await fetchQuota(grant.accessToken);
      } catch {
        spaceMax = 0;
      }

      await store.upsert({
        id: pending.accountId,
        label: pending.accountId,
        userId: grant.userId,
        tokens: {
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          issuedAt: Math.floor(Date.now() / 1000),
          expiresIn: grant.expiresIn,
        },
        spaceMax,
        needsReauth: false,
      });

      return {
        accountId: pending.accountId,
        status: 'authorized',
        userId: grant.userId,
        spaceMax,
      };
    }

    await sleep(pollIntervalMs, options.signal);
  }

  return { accountId: pending.accountId, status: 'expired' };
}

/**
 * Re-authorizes an existing account whose refresh chain broke.
 *
 * The account keeps its id and label so library rows continue to resolve.
 */
export async function completeReauth(
  store: TokenStore,
  accountId: string,
  pending: PendingAuth,
  fetchQuota: (accessToken: string) => Promise<number>,
  options: PollOptions = {},
): Promise<OnboardResult> {
  const existing = store.get(accountId);
  const result = await completeAuth(store, { ...pending, accountId }, fetchQuota, options);

  if (result.status === 'authorized' && existing) {
    await store.upsert({
      ...existing,
      userId: result.userId,
      tokens: store.get(accountId)?.tokens ?? existing.tokens,
      spaceMax: result.spaceMax || existing.spaceMax,
      needsReauth: false,
    });
  }

  return result;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
