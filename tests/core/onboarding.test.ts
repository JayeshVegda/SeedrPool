import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../../src/core/token-store.ts';
import {
  nextAccountId,
  beginOnboarding,
  completeAuth,
  type PendingAuth,
} from '../../src/core/onboarding.ts';

let dir: string;
let path: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seedrpool-onboard-'));
  path = join(dir, 'accounts.env');
  store = new TokenStore(path);
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function pendingAuth(overrides: Partial<PendingAuth> = {}): PendingAuth {
  return {
    accountId: 'acc1',
    request: {
      deviceCode: 'device-code-1',
      userCode: 'ABCD1234',
      verificationUrl: 'https://v2.seedr.cc/api/v0.1/p/oauth/device/verify?code=ABCD1234',
      expiresIn: 1800,
      // Zero-length polls keep tests fast.
      interval: 0,
    },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const quota = async () => 4831838208;

describe('nextAccountId', () => {
  it('starts at acc1', () => {
    expect(nextAccountId([])).toBe('acc1');
  });

  it('skips ids already taken', () => {
    expect(nextAccountId(['acc1', 'acc2'])).toBe('acc3');
  });

  it('fills gaps rather than always appending', () => {
    expect(nextAccountId(['acc1', 'acc3'])).toBe('acc2');
  });
});

describe('beginOnboarding', () => {
  it('requests one device code per account and assigns fresh ids', async () => {
    let n = 0;
    vi.stubGlobal('fetch', () => {
      n += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: `dc-${n}`,
            user_code: `UC${n}`,
            verification_uri_complete: `/oauth/device/verify?code=UC${n}`,
            expires_in: 1800,
            interval: 5,
          }),
          { status: 200 },
        ),
      );
    });

    await store.upsert({
      id: 'acc1',
      label: 'existing',
      userId: '1',
      tokens: { accessToken: 'a', refreshToken: 'r', issuedAt: 0, expiresIn: 3600 },
      spaceMax: 0,
      needsReauth: false,
    });

    const pending = await beginOnboarding(store, 3);
    expect(pending.map((p) => p.accountId)).toEqual(['acc2', 'acc3', 'acc4']);
    // Relative paths from the API are made absolute for clickable links.
    expect(pending[0]?.request.verificationUrl).toBe(
      'https://v2.seedr.cc/oauth/device/verify?code=UC1',
    );
  });
});

describe('completeAuth', () => {
  it('persists tokens once the user approves', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      // Pending twice, then approved: mirrors real device-flow polling.
      if (calls < 3) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'at-new',
            refresh_token: 'rt-new',
            expires_in: 3600,
            user_id: 4860136,
          }),
          { status: 200 },
        ),
      );
    });

    const result = await completeAuth(store, pendingAuth(), quota);

    expect(result).toMatchObject({
      accountId: 'acc1',
      status: 'authorized',
      userId: '4860136',
      spaceMax: 4831838208,
    });

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('SEEDR_ACC1_REFRESH_TOKEN=rt-new');
    expect(onDisk).toContain('SEEDR_ACC1_USER_ID=4860136');
  });

  it('reports expiry when the code lapses unapproved', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      ),
    );

    const result = await completeAuth(
      store,
      pendingAuth({ expiresAt: Date.now() - 1 }),
      quota,
    );
    expect(result).toEqual({ accountId: 'acc1', status: 'expired' });
    expect(store.list()).toEqual([]);
  });

  it('keeps approved tokens even when the quota lookup fails', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            user_id: 7,
          }),
          { status: 200 },
        ),
      ),
    );

    // Losing a just-approved token because of a cosmetic quota read would force
    // the user to approve again.
    const result = await completeAuth(store, pendingAuth(), async () => {
      throw new Error('quota unavailable');
    });

    expect(result).toMatchObject({ status: 'authorized', spaceMax: 0 });
    expect(store.get('acc1')?.tokens.refreshToken).toBe('rt');
  });

  it('reports a hard failure without storing anything', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_client' }), { status: 403 }),
      ),
    );

    const result = await completeAuth(store, pendingAuth(), quota);
    expect(result.status).toBe('failed');
    expect(store.list()).toEqual([]);
  });

  it('stops promptly when aborted', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      ),
    );

    const controller = new AbortController();
    const promise = completeAuth(store, pendingAuth({ request: {
      deviceCode: 'dc',
      userCode: 'UC',
      verificationUrl: 'https://example.com',
      expiresIn: 1800,
      interval: 1,
    } }), quota, { signal: controller.signal });

    controller.abort();
    const result = await promise;
    expect(result).toEqual({ accountId: 'acc1', status: 'failed', reason: 'aborted' });
  });

  it('refuses a grant with no refresh token, which would expire in an hour', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'at-only', expires_in: 3600 }), {
          status: 200,
        }),
      ),
    );

    const result = await completeAuth(store, pendingAuth(), quota);
    expect(result.status).toBe('failed');
    expect(store.list()).toEqual([]);
  });
});
