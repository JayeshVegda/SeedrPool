import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../src/core/token-store.ts';
import {
  SeedrV2Provider,
  ReauthRequiredError,
  SeedrApiError,
  parseExpiry,
  describeError,
  toTransfer,
  makeQuota,
} from '../src/providers/seedr-v2.ts';

let dir: string;
let path: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seedrpool-provider-'));
  path = join(dir, 'accounts.env');
  store = new TokenStore(path);
  await store.load();
  await store.upsert({
    id: 'acc1',
    label: 'test',
    userId: '4860136',
    tokens: {
      accessToken: 'access-current',
      refreshToken: 'refresh-current',
      // Fresh, so no proactive refresh fires unless a test forces it.
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: 3600,
    },
    spaceMax: 4831838208,
    needsReauth: false,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Queues canned responses in order, recording every request made. */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve(
      new Response(JSON.stringify(r?.body ?? {}), {
        status: r?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return calls;
}

describe('pure helpers', () => {
  it('parses the e= expiry from a signed url', () => {
    expect(
      parseExpiry('https://nw35.seedr.cc/ff_get/1/2/x.mp4?st=abc&e=1788264633'),
    ).toBe(1788264633);
  });

  it('returns null when no expiry is present or the url is malformed', () => {
    expect(parseExpiry('https://example.com/x.mp4')).toBeNull();
    expect(parseExpiry('not a url')).toBeNull();
  });

  it('prefers Seedr reason_phrase when describing errors', () => {
    expect(describeError({ reason_phrase: 'Token has been revoked' })).toBe(
      'Token has been revoked',
    );
    expect(describeError({ error: 'authorization_pending' })).toBe('authorization_pending');
    expect(describeError({})).toBe('unknown error');
  });

  it('computes free space without going negative', () => {
    expect(makeQuota(100, 1000).free).toBe(900);
    expect(makeQuota(2000, 1000).free).toBe(0);
  });

  it('maps a dead magnet to a running transfer with no seeders', () => {
    // Seedr reports dead magnets as indefinitely running rather than failed, so
    // the seeder count is the only signal the UI can use.
    const t = toTransfer({
      id: 196008353,
      name: null,
      state: 'running',
      progress: 0,
      size: 0,
      torrent_payload: { seeders: 0, leechers: 0 },
    });
    expect(t).toMatchObject({ state: 'running', progress: 0, seeders: 0, name: null });
  });

  it('treats a task carrying an error as failed regardless of state', () => {
    expect(toTransfer({ id: 1, state: 'running', error: 'boom' }).state).toBe('failed');
  });

  it('exposes folder_created_id as the resulting folder', () => {
    expect(toTransfer({ id: 1, state: 'finished', folder_created_id: 1432576760 }).folderId).toBe(
      '1432576760',
    );
  });
});

describe('SeedrV2Provider requests', () => {
  it('sends the bearer token and maps quota', async () => {
    const calls = stubFetch([
      { status: 200, body: { space_used: 276445467, space_max: 4831838208 } },
    ]);
    const quota = await new SeedrV2Provider('acc1', store).getQuota();

    expect(quota.used).toBe(276445467);
    expect(quota.free).toBe(4831838208 - 276445467);
    expect(calls[0]?.url).toBe('https://v2.seedr.cc/api/v0.1/p/fs/root/contents');
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer access-current',
    );
  });

  it('normalizes folder listings, including root path-vs-name', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          folders: [{ id: 1432576760, path: 'Big Buck Bunny', size: 276445467 }],
          files: [
            {
              id: 5983597752,
              name: 'Big Buck Bunny.mp4',
              size: 276134947,
              hash: '18cd76f6',
              folder_id: 1432576760,
              is_video: true,
              is_audio: false,
            },
          ],
        },
      },
    ]);

    const contents = await new SeedrV2Provider('acc1', store).listFolder(null);
    expect(contents.folders[0]).toEqual({
      id: '1432576760',
      path: 'Big Buck Bunny',
      size: 276445467,
    });
    expect(contents.files[0]).toMatchObject({
      id: '5983597752',
      isVideo: true,
      hash: '18cd76f6',
    });
  });

  it('returns a playback url with its expiry', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          url: 'https://nw35.seedr.cc/ff_get/4860136/5983597752/x.mp4?st=a&e=1788264633',
          name: 'x.mp4',
          success: true,
        },
      },
    ]);
    const playback = await new SeedrV2Provider('acc1', store).getPlaybackUrl('5983597752');
    expect(playback.expiresAt).toBe(1788264633);
    expect(playback.filename).toBe('x.mp4');
  });

  it('rejects a magnet the api refuses', async () => {
    stubFetch([{ status: 200, body: { success: false, reason_phrase: 'nope' } }]);
    await expect(new SeedrV2Provider('acc1', store).addMagnet('magnet:?xt=1')).rejects.toThrow(
      SeedrApiError,
    );
  });

  it('reports a pending transfer when a magnet is accepted', async () => {
    stubFetch([
      { status: 200, body: { user_torrent_id: 196008266, title: 'Big Buck Bunny', success: true } },
    ]);
    const t = await new SeedrV2Provider('acc1', store).addMagnet('magnet:?xt=1');
    expect(t).toMatchObject({ id: '196008266', state: 'pending', progress: 0 });
  });
});

describe('token rotation', () => {
  it('refreshes proactively when the access token is near expiry', async () => {
    await store.updateTokens('acc1', {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      // Inside the 120s refresh margin. Kept deliberately narrow: a wide margin
      // makes every request in the window attempt a refresh, which trips Seedr's
      // per-client throttle.
      issuedAt: Math.floor(Date.now() / 1000) - 3550,
      expiresIn: 3600,
    });

    const calls = stubFetch([
      {
        status: 200,
        body: {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 3600,
          user_id: 4860136,
        },
      },
      { status: 200, body: { space_used: 0, space_max: 4831838208 } },
    ]);

    await new SeedrV2Provider('acc1', store).getQuota();

    expect(calls[0]?.url).toContain('/oauth/token');
    // The rotated token must be on disk, not just in memory.
    expect(await readFile(path, 'utf8')).toContain('SEEDR_ACC1_REFRESH_TOKEN=refresh-new');
    expect((calls[1]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer access-new',
    );
  });

  it('refreshes once when several requests race, so the token is consumed once', async () => {
    await store.updateTokens('acc1', {
      accessToken: '',
      refreshToken: 'refresh-old',
      issuedAt: 0,
      expiresIn: 3600,
    });

    let refreshCount = 0;
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).includes('/oauth/token')) {
        refreshCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'access-new',
              refresh_token: `refresh-${refreshCount}`,
              expires_in: 3600,
              user_id: 1,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ space_used: 0, space_max: 1 }), { status: 200 }),
      );
    });

    const provider = new SeedrV2Provider('acc1', store);
    await Promise.all([provider.getQuota(), provider.getQuota(), provider.getQuota()]);

    // Two concurrent refreshes would each consume the same single-use token and
    // the loser would break the chain permanently.
    expect(refreshCount).toBe(1);
  });

  it('flags needsReauth when the refresh token is revoked', async () => {
    await store.updateTokens('acc1', {
      accessToken: '',
      refreshToken: 'refresh-revoked',
      issuedAt: 0,
      expiresIn: 3600,
    });
    stubFetch([{ status: 401, body: { status_code: 401, reason_phrase: 'Token has been revoked' } }]);

    const provider = new SeedrV2Provider('acc1', store);
    await expect(provider.getQuota()).rejects.toThrow(ReauthRequiredError);

    expect(store.get('acc1')?.needsReauth).toBe(true);
    // Persisted, so a restart does not retry a dead chain.
    expect(await readFile(path, 'utf8')).toContain('SEEDR_ACC1_NEEDS_REAUTH=1');
  });

  it('refuses a grant that omits a refresh token', async () => {
    await store.updateTokens('acc1', {
      accessToken: '',
      refreshToken: 'refresh-old',
      issuedAt: 0,
      expiresIn: 3600,
    });
    // Storing an access token with no refresh token would silently die in an hour.
    stubFetch([{ status: 200, body: { access_token: 'only-access', expires_in: 3600 } }]);

    await expect(new SeedrV2Provider('acc1', store).getQuota()).rejects.toThrow(
      /no refresh token/,
    );
  });

  it('retries once on an unexpected 401, since tokens can expire early', async () => {
    const calls = stubFetch([
      { status: 401, body: { reason_phrase: 'expired' } },
      {
        status: 200,
        body: { access_token: 'access-new2', refresh_token: 'refresh-new2', expires_in: 3600 },
      },
      { status: 200, body: { space_used: 1, space_max: 2 } },
    ]);

    const quota = await new SeedrV2Provider('acc1', store).getQuota();
    expect(quota.used).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain('/oauth/token');
  });

  it('refuses to use an account already flagged for re-auth', async () => {
    await store.markNeedsReauth('acc1', 'revoked earlier');
    stubFetch([{ status: 200, body: {} }]);
    await expect(new SeedrV2Provider('acc1', store).getQuota()).rejects.toThrow(
      ReauthRequiredError,
    );
  });

  it('reports an unhealthy account instead of throwing from healthCheck', async () => {
    await store.markNeedsReauth('acc1', 'revoked');
    stubFetch([{ status: 200, body: {} }]);
    const health = await new SeedrV2Provider('acc1', store).healthCheck();
    expect(health).toEqual({ healthy: false, reason: 'needs re-authorization' });
  });

  it('reports a healthy account when quota resolves', async () => {
    stubFetch([{ status: 200, body: { space_used: 0, space_max: 1 } }]);
    expect(await new SeedrV2Provider('acc1', store).healthCheck()).toEqual({ healthy: true });
  });
});
