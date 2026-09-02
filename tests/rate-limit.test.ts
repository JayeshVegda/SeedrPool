import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../src/core/token-store.ts';
import { completeAuth, type PendingAuth } from '../src/core/onboarding.ts';
import { isRateLimited, RateLimitError, pollDeviceCode } from '../src/providers/seedr-v2.ts';

let dir: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seedrpool-ratelimit-'));
  store = new TokenStore(join(dir, 'accounts.env'));
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function pendingAuth(): PendingAuth {
  return {
    accountId: 'acc2',
    request: {
      deviceCode: 'dc',
      userCode: 'UC',
      verificationUrl: 'https://example.com',
      expiresIn: 1800,
      interval: 0,
    },
    expiresAt: Date.now() + 60_000,
  };
}

describe('isRateLimited', () => {
  it('detects an explicit 429', () => {
    expect(isRateLimited(429, {})).toBe(true);
  });

  it('detects Seedr rate-limit text on a non-429 status', () => {
    // Observed in practice: HTTP 403 carrying a rate-limit reason_phrase.
    expect(
      isRateLimited(403, { reason_phrase: 'Rate limit exceeded. Please try again later.' }),
    ).toBe(true);
  });

  it('does not treat ordinary failures as throttling', () => {
    expect(isRateLimited(401, { reason_phrase: 'Token has been revoked' })).toBe(false);
    expect(isRateLimited(400, { error: 'authorization_pending' })).toBe(false);
  });
});

describe('pollDeviceCode throttling', () => {
  it('raises RateLimitError rather than failing the flow', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ reason_phrase: 'Rate limit exceeded' }), { status: 403 }),
      ),
    );
    await expect(pollDeviceCode('dc')).rejects.toThrow(RateLimitError);
  });
});

describe('completeAuth backoff', () => {
  it('keeps polling through throttling and still completes', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      // Throttled twice before the approval lands. Previously this aborted the
      // whole onboarding run and lost all five accounts at once.
      if (calls <= 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ reason_phrase: 'Rate limit exceeded' }), { status: 403 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            user_id: 99,
          }),
          { status: 200 },
        ),
      );
    });

    const result = await completeAuth(store, pendingAuth(), async () => 1024, {
      rateLimitBackoffMs: 1,
      maxBackoffMs: 4,
    });

    expect(result).toMatchObject({ accountId: 'acc2', status: 'authorized', userId: '99' });
    expect(calls).toBeGreaterThan(2);
    expect(store.get('acc2')?.tokens.refreshToken).toBe('rt');
  });

  it('gives up on a genuine failure without retrying', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_client' }), { status: 403 }),
      );
    });

    const result = await completeAuth(store, pendingAuth(), async () => 0);
    expect(result.status).toBe('failed');
    expect(calls).toBe(1);
  });
});
