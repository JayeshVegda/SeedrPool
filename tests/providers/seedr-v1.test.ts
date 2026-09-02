import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SeedrV1Provider,
  InvalidCredentialsError,
  isV1RateLimited,
  toTransfer,
} from '../../src/providers/seedr-v1.ts';
import { RateLimitError, SeedrApiError } from '../../src/providers/shared.ts';
import { RateLimiter } from '../../src/core/rate-limiter.ts';

const CREDENTIAL = { id: 'acc1', email: 'jay@example.com', password: 'hunter2' };

/** No delay between requests, so tests do not pay the 250 ms production gap. */
function fastLimiter() {
  return new RateLimiter({ minGapMs: 0, cooldownMs: 0 });
}

interface Call {
  url: string;
  method: string;
  body: string;
}

/** Queues canned responses in order, recording every request made. */
function stubFetch(responses: Array<{ status?: number; body: unknown; headers?: HeadersInit }>) {
  const calls: Call[] = [];
  let i = 0;

  vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit = {}) => {
    const body = init.body;
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: body instanceof URLSearchParams ? body.toString() : String(body ?? ''),
    });

    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(
      typeof r?.body === 'string' ? r.body : JSON.stringify(r?.body ?? {}),
      {
        status: r?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(r?.headers ?? {}) },
      },
    );
  });

  return calls;
}

const LOGIN_OK = {
  body: {
    access_token: 'tok-1',
    refresh_token: 'ref-1',
    expires_in: 2_586_746,
    token_type: 'Bearer',
  },
};

const QUOTA_OK = {
  body: { space_used: 129_302_391, space_max: 6_979_321_856, result: true },
};

let provider: SeedrV1Provider;

beforeEach(() => {
  provider = new SeedrV1Provider(CREDENTIAL, fastLimiter());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login', () => {
  it('exchanges email and password for a token before the first call', async () => {
    const calls = stubFetch([LOGIN_OK, QUOTA_OK]);

    const quota = await provider.getQuota();

    expect(quota.used).toBe(129_302_391);
    expect(quota.free).toBe(6_979_321_856 - 129_302_391);

    expect(calls[0]?.url).toBe('https://www.seedr.cc/oauth_test/token.php');
    const loginBody = new URLSearchParams(calls[0]?.body ?? '');
    expect(loginBody.get('grant_type')).toBe('password');
    expect(loginBody.get('client_id')).toBe('seedr_chrome');
    expect(loginBody.get('username')).toBe('jay@example.com');
    expect(loginBody.get('password')).toBe('hunter2');
  });

  it('caches the token so a second call does not log in again', async () => {
    const calls = stubFetch([LOGIN_OK, QUOTA_OK, QUOTA_OK]);

    await provider.getQuota();
    await provider.getQuota();

    const logins = calls.filter((c) => c.url.includes('token.php'));
    expect(logins).toHaveLength(1);
  });

  it('collapses concurrent first calls into one login', async () => {
    const calls = stubFetch([LOGIN_OK, QUOTA_OK]);

    await Promise.all([provider.getQuota(), provider.getQuota(), provider.getQuota()]);

    expect(calls.filter((c) => c.url.includes('token.php'))).toHaveLength(1);
  });

  it('re-logs in once and retries when the cached token is rejected', async () => {
    const calls = stubFetch([
      LOGIN_OK,
      // Seedr reports an invalid token as 401 access_denied.
      { status: 401, body: { result: false, error: 'access_denied' } },
      LOGIN_OK,
      QUOTA_OK,
    ]);

    const quota = await provider.getQuota();

    expect(quota.max).toBe(6_979_321_856);
    expect(calls.filter((c) => c.url.includes('token.php'))).toHaveLength(2);
  });

  it('reports a wrong password rather than retrying it forever', async () => {
    const calls = stubFetch([
      { status: 401, body: { error: 'invalid_grant', error_description: 'Invalid username and password combination' } },
    ]);

    await expect(provider.getQuota()).rejects.toThrow(InvalidCredentialsError);

    // A second call must not touch the network: the password cannot become right.
    const before = calls.length;
    await expect(provider.getQuota()).rejects.toThrow(InvalidCredentialsError);
    expect(calls).toHaveLength(before);
  });

  it('treats a throttled login as transient, not as a bad password', async () => {
    stubFetch([{ status: 429, body: { error: 'Rate limit exceeded. Please try again later.' } }]);

    await expect(provider.getQuota()).rejects.toThrow(RateLimitError);

    // The account must stay usable once the throttle clears.
    stubFetch([LOGIN_OK, QUOTA_OK]);
    await expect(provider.getQuota()).resolves.toBeTruthy();
  });

  it('treats a 403 carrying a rate-limit message as throttling', () => {
    // Seedr does not always use 429.
    expect(isV1RateLimited(403, { error: 'Rate limit exceeded' })).toBe(true);
    expect(isV1RateLimited(429, {})).toBe(true);
    expect(isV1RateLimited(401, { error: 'access_denied' })).toBe(false);
  });
});

describe('addMagnet', () => {
  it('sends the magnet in the POST body under the "magnet" field', async () => {
    const calls = stubFetch([
      LOGIN_OK,
      {
        body: {
          user_torrent_id: 196_012_634,
          title: 'Sintel',
          torrent_hash: '08ada5a7a6183aae1e09d831df6748d566095a10',
          success: true,
          result: true,
        },
      },
    ]);

    const transfer = await provider.addMagnet('magnet:?xt=urn:btih:08ada5a7');

    expect(transfer.id).toBe('196012634');
    expect(transfer.name).toBe('Sintel');
    expect(transfer.state).toBe('pending');

    const add = calls[1];
    expect(add?.method).toBe('POST');
    expect(add?.url).toContain('func=add_torrent');
    // `torrent_magnet` returns 404 and the query string files it to the wishlist.
    expect(new URLSearchParams(add?.body ?? '').get('magnet')).toBe(
      'magnet:?xt=urn:btih:08ada5a7',
    );
    expect(add?.url).not.toContain('magnet%3A');
  });

  it('fails when Seedr parks the magnet in the wishlist instead of downloading', async () => {
    stubFetch([
      LOGIN_OK,
      {
        body: {
          reason_phrase: 'queue_full_added_to_wishlist',
          wt: { user_id: 398_088, title: 'Sintel', size: 0 },
        },
      },
    ]);

    // Nothing downloads in this case, so it must not look like success.
    await expect(provider.addMagnet('magnet:?xt=urn:btih:1')).rejects.toThrow(/wishlist/);
  });

  it('fails when no torrent id comes back', async () => {
    stubFetch([LOGIN_OK, { status: 400, body: { status_code: 400, reason_phrase: 'no_torrent_passed' } }]);
    await expect(provider.addMagnet('magnet:?xt=urn:btih:1')).rejects.toThrow(SeedrApiError);
  });
});

describe('listFolder', () => {
  it('reads the root as folder 0 and maps files', async () => {
    const calls = stubFetch([
      LOGIN_OK,
      {
        body: {
          id: 12_847_330,
          folders: [{ id: 1_432_582_823, path: 'Sintel', name: 'Sintel', size: 129_302_391 }],
          files: [
            {
              id: 5_983_629_956,
              name: 'Sintel.mp4',
              size: 129_241_752,
              hash: 'abc123',
              folder_id: 1_432_582_823,
              is_video: true,
              is_audio: false,
            },
          ],
          result: true,
        },
      },
    ]);

    const contents = await provider.listFolder(null);

    expect(new URLSearchParams(calls[1]?.body ?? '').get('content_id')).toBe('0');
    expect(contents.folders[0]).toEqual({ id: '1432582823', path: 'Sintel', name: 'Sintel', size: 129_302_391 });
    expect(contents.files[0]).toEqual({
      id: '5983629956',
      name: 'Sintel.mp4',
      size: 129_241_752,
      hash: 'abc123',
      isVideo: true,
      isAudio: false,
      folderId: '1432582823',
    });
  });

  it('falls back to the queried folder id when a file omits folder_id', async () => {
    stubFetch([
      LOGIN_OK,
      { body: { files: [{ id: 1, name: 'loose.mp4', is_video: true }], result: true } },
    ]);

    const contents = await provider.listFolder('999');
    expect(contents.files[0]?.folderId).toBe('999');
  });
});

describe('listTransfers', () => {
  it('reads in-progress torrents from the root listing', async () => {
    // V1 has no task endpoint; active torrents live in the root's `torrents`.
    stubFetch([
      LOGIN_OK,
      {
        body: {
          torrents: [
            {
              id: 196_013_131,
              name: 'Sintel',
              size: 129_302_391,
              progress: 42,
              seeders: 7,
              leechers: 2,
              stopped: 0,
              warnings: [],
            },
          ],
          result: true,
        },
      },
    ]);

    const transfers = await provider.listTransfers();

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      id: '196013131',
      name: 'Sintel',
      state: 'running',
      progress: 42,
      seeders: 7,
    });
  });

  it('yields nothing when the account has no active torrents', async () => {
    stubFetch([LOGIN_OK, { body: { folders: [], files: [], torrents: [], result: true } }]);
    await expect(provider.listTransfers()).resolves.toEqual([]);
  });
});

describe('toTransfer', () => {
  it('marks a stopped torrent as paused', () => {
    expect(toTransfer({ id: 1, stopped: 1, progress: 10 }).state).toBe('paused');
  });

  it('marks a complete torrent as finished', () => {
    expect(toTransfer({ id: 1, progress: 100 }).state).toBe('finished');
  });

  it('surfaces the first warning as the error', () => {
    expect(toTransfer({ id: 1, warnings: ['', 'no space left'] }).error).toBe('no space left');
  });

  it('reports a dead magnet as running with no peers, matching Seedr', () => {
    // Seedr never fails these, so the pool's stall detector is the only signal.
    const dead = toTransfer({ id: 1, progress: 0, seeders: 0, size: 0 });
    expect(dead).toMatchObject({ state: 'running', progress: 0, seeders: 0 });
    expect(dead.error).toBeNull();
  });
});

describe('getPlaybackUrl', () => {
  it('returns the ff_get url with its embedded expiry', async () => {
    stubFetch([
      LOGIN_OK,
      {
        body: {
          url: 'https://nw34.seedr.cc/ff_get/398088/5983629956/Sintel.mp4?st=abc&e=1788270396',
          name: 'Sintel.mp4',
          success: true,
          result: true,
        },
      },
    ]);

    // Probe is fired after `fetch_file` succeeds; the fake fetch returns 200
    // by default so the probe is treated as success.
    const playback = await provider.getPlaybackUrl('5983629956');

    expect(playback.url).toContain('/ff_get/');
    expect(playback.filename).toBe('Sintel.mp4');
    expect(playback.expiresAt).toBe(1_788_270_396);
    expect(playback.kind).toBe('direct');
  });

  it('fails when Seedr returns no url', async () => {
    stubFetch([LOGIN_OK, { body: { result: true } }]);
    await expect(provider.getPlaybackUrl('1')).rejects.toThrow(SeedrApiError);
  });

  it('falls back to HLS when the ff_get URL returns 404', async () => {
    stubFetch([
      LOGIN_OK,
      {
        body: {
          url: 'https://rd12.seedr.cc/ff_get/78724/5984206081/Lady.Vengeance.mp4?st=abc&e=1788354048',
          name: 'Lady.Vengeance.mp4',
          success: true,
          result: true,
        },
      },
      // The probe call: 404 → fall back to HLS.
      { status: 404, body: '' },
      // get_folder walk to find the file's presentation_urls.
      {
        body: {
          files: [
            {
              folder_file_id: 5984206081,
              presentation_urls: {
                video: {
                  hls: 'https://rd12.seedr.cc/presentations/p/file/v1/78724/5984206081/assets/video/master-2160.m3u8?st=abc&e=1788271612',
                },
              },
            },
          ],
          folders: [],
        },
      },
    ]);

    const playback = await provider.getPlaybackUrl('5984206081');

    expect(playback.kind).toBe('hls');
    expect(playback.url).toContain('/presentations/');
    expect(playback.filename).toBe('Lady.Vengeance.mp4');
  });

  it('throws when ff_get 404s and the file has no HLS manifest', async () => {
    stubFetch([
      LOGIN_OK,
      {
        body: {
          url: 'https://rd12.seedr.cc/ff_get/78724/5984206081/Lady.Vengeance.mp4?st=abc&e=1788354048',
          name: 'Lady.Vengeance.mp4',
          success: true,
          result: true,
        },
      },
      { status: 404, body: '' },
      // Folder walk: file exists but no presentation_urls.
      {
        body: {
          files: [{ folder_file_id: 5984206081 }],
          folders: [],
        },
      },
    ]);

    await expect(provider.getPlaybackUrl('5984206081')).rejects.toThrow(SeedrApiError);
  });

  it('walks subfolders to find the HLS manifest', async () => {
    stubFetch([
      LOGIN_OK,
      {
        body: {
          url: 'https://rd12.seedr.cc/ff_get/78724/99/movie.mp4?st=abc&e=1788354048',
          name: 'movie.mp4',
          success: true,
          result: true,
        },
      },
      { status: 404, body: '' },
      // Root has only a subfolder, no matching file.
      {
        body: {
          files: [],
          folders: [{ id: 'sub-1' }],
        },
      },
      // Subfolder has the file with the HLS manifest.
      {
        body: {
          files: [
            {
              folder_file_id: 99,
              presentation_urls: {
                video: { hls: 'https://rd12.seedr.cc/presentations/.../master.m3u8' },
              },
            },
          ],
          folders: [],
        },
      },
    ]);

    const playback = await provider.getPlaybackUrl('99');
    expect(playback.kind).toBe('hls');
    expect(playback.url).toContain('presentations/');
  });
});

describe('delete', () => {
  it('deletes a file, folder, and torrent through the one delete endpoint', async () => {
    const calls = stubFetch([LOGIN_OK, { body: { success: true, result: true } }]);

    await provider.deleteFile('5983629956');
    expect(calls[1]?.url).toContain('func=delete');
    expect(new URLSearchParams(calls[1]?.body ?? '').get('delete_arr')).toBe(
      '[{"type":"file","id":5983629956}]',
    );

    await provider.deleteFolder('1432582823');
    expect(new URLSearchParams(calls[2]?.body ?? '').get('delete_arr')).toBe(
      '[{"type":"folder","id":1432582823}]',
    );

    await provider.deleteTransfer('196013131');
    expect(new URLSearchParams(calls[3]?.body ?? '').get('delete_arr')).toBe(
      '[{"type":"torrent","id":196013131}]',
    );
  });
});

describe('healthCheck', () => {
  it('passes when quota can be read', async () => {
    stubFetch([LOGIN_OK, QUOTA_OK]);
    await expect(provider.healthCheck()).resolves.toEqual({ healthy: true });
  });

  it('reports rejected credentials distinctly from other failures', async () => {
    stubFetch([{ status: 401, body: { error: 'invalid_grant' } }]);
    await expect(provider.healthCheck()).resolves.toEqual({
      healthy: false,
      reason: 'credentials rejected',
    });
  });
});

describe('error handling', () => {
  it('treats result:false as a failure even with HTTP 200', async () => {
    stubFetch([LOGIN_OK, { status: 200, body: { result: false, error: 'something broke' } }]);
    await expect(provider.getQuota()).rejects.toThrow(/something broke/);
  });

  it('does not crash on an HTML error page', async () => {
    stubFetch([
      LOGIN_OK,
      { status: 502, body: '<html><body>Bad Gateway</body></html>', headers: { 'Content-Type': 'text/html' } },
    ]);
    await expect(provider.getQuota()).rejects.toThrow(SeedrApiError);
  });

  it('never puts the password in an error message', async () => {
    stubFetch([{ status: 401, body: { error: 'invalid_grant' } }]);

    const err = await provider.getQuota().catch((e: unknown) => e);
    expect(String(err)).not.toContain('hunter2');
  });
});
