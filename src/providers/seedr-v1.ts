/**
 * Seedr V1 API client and `StorageProvider` implementation.
 *
 * Alongside `seedr-v2.ts`, this is the only place permitted to know Seedr's
 * endpoints and payload shapes (agents.md rule 3).
 *
 * Why V1 rather than V2: V2 requires a per-account browser approval against an
 * OAuth client we do not own, and Seedr now refuses new authorizations for it.
 * V1 has a password grant that needs no browser and no client registration.
 *
 * Measured behaviour this depends on (RESEARCH.md):
 *   - password grant is IDEMPOTENT: logging in twice returns the same access
 *     token and the earlier one keeps working, so tokens are a cache rather than
 *     a fragile single-use chain;
 *   - access tokens last ~30 days (`expires_in` ≈ 2,586,000);
 *   - the magnet field is `magnet`. Sending `torrent_magnet` in the body returns
 *     404, and sending it in the query string silently files the torrent to the
 * wishlist instead of downloading it;
 *   - `fetch_file` returns an `ff_get` URL for the untranscoded original:
 *     content-length present, `accept-ranges: bytes`, mid-file Range → 206,
 *     ~4.6 MB/s, so the 360p web-player cap does not apply;
 *   - an invalid token yields HTTP 401 `{"result":false,"error":"access_denied"}`;
 *   - a dead magnet sits in `torrents` at progress 0 with 0 seeders forever
 *     rather than failing.
 *   - some accounts' files are served from a CDN host where `ff_get` returns
 *     404 with `Retry-After: 5` even for a freshly-minted URL. We probe the
 *     URL and, on 404, look up the file via `get_folder` to find the HLS
 *     `presentation_urls.video.hls` manifest, which works on every CDN
 *     host Seedr uses. The HLS manifest is not range-byte seekable, so we
 *     hand it off to an external player; the `kind: 'hls'` field on the
 *     PlaybackUrl lets the Stremio client make that decision.
 */

import type {
  FolderContents,
  PlaybackUrl,
  Quota,
  RemoteFile,
  RemoteFolder,
  StorageProvider,
  Transfer,
} from '../core/types.ts';
import type { AccountCredential } from '../core/credentials.ts';
import { RateLimiter } from '../core/rate-limiter.ts';
import { RateLimitError, SeedrApiError, makeQuota, parseExpiry } from './shared.ts';

const TOKEN_URL = 'https://www.seedr.cc/oauth_test/token.php';
const RESOURCE_URL = 'https://www.seedr.cc/oauth_test/resource.php';

/**
 * V1's password-grant client id. Long-standing and public, used by Seedr's own
 * browser integration. Unlike the V2 client id this is not gated per app.
 */
const CLIENT_ID = 'seedr_chrome';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Re-login this many seconds before nominal expiry.
 *
 * Generous because tokens last ~30 days, so a day of margin costs nothing and
 * removes any chance of a token expiring mid-playback.
 */
const RELOGIN_MARGIN_SECONDS = 86_400;

/**
 * Separate limiter from V2's.
 *
 * Throttling is per client id, and V1 uses a different one, so sharing V2's
 * budget would make an unrelated V2 throttle stall every V1 account.
 */
export const seedrV1RateLimiter = new RateLimiter();

/** Raised when Seedr rejects an account's email and password. */
export class InvalidCredentialsError extends Error {
  readonly accountId: string;

  constructor(accountId: string, reason: string) {
    super(`account ${accountId} credentials rejected: ${reason}`);
    this.name = 'InvalidCredentialsError';
    this.accountId = accountId;
  }
}

/** A cached access token with the time it was issued. */
interface CachedToken {
  accessToken: string;
  issuedAt: number;
  expiresIn: number;
}

/**
 * Structured snapshot of an account. The token field holds a short prefix
 * and suffix only — never the full access token. `null` when the provider
 * has not yet logged in (e.g. just added to the pool, first probe pending).
 */
export interface AccountDump {
  accountId: string;
  email: string;
  capturedAt: number;
  token: { issuedAt: number; expiresIn: number; prefix: string; suffix: string } | null;
  quota: { used: number; max: number; free: number };
  root: {
    folders: Array<{ id: string; name: string; size: number }>;
    files: Array<{ id: string; name: string; size: number; folderId: string }>;
  };
  transfers: Array<{
    id: string; name: string | null; state: string; progress: number;
    size: number; seeders: number; leechers: number; error: string | null;
  }>;
}

export class SeedrV1Provider implements StorageProvider {
  readonly accountId: string;
  readonly email: string;
  #password: string;
  #token: CachedToken | null = null;
  /** Collapses concurrent logins so one burst costs one request. */
  #loginInFlight: Promise<string> | null = null;
  #limiter: RateLimiter;
  /**
   * Set once Seedr has rejected the password. Retrying a wrong password on every
   * request would burn the login endpoint's budget for no possible gain.
   */
  #credentialsRejected: string | null = null;

  constructor(credential: AccountCredential, limiter: RateLimiter = seedrV1RateLimiter) {
    this.accountId = credential.id;
    this.email = credential.email;
    this.#password = credential.password;
    this.#limiter = limiter;
  }

  async getQuota(): Promise<Quota> {
    const data = await this.#call<{ space_used?: number; space_max?: number }>(
      'get_memory_bandwidth',
    );
    return makeQuota(data.space_used ?? 0, data.space_max ?? 0);
  }

  async listFolder(folderId: string | null): Promise<FolderContents> {
    // V1 addresses the root as folder 0 rather than with a separate endpoint.
    const contentId = folderId ?? '0';
    const data = await this.#call<V1FolderResponse>('list_contents', {
      content_type: 'folder',
      content_id: contentId,
    });

    return {
      folders: (data.folders ?? []).map(toRemoteFolder),
      files: (data.files ?? []).map((f) => toRemoteFile(f, contentId)),
    };
  }

  async addMagnet(magnet: string): Promise<Transfer> {
    // Field name is `magnet`, in the POST body. See the file header.
    const data = await this.#call<{
      user_torrent_id?: number;
      title?: string | null;
      torrent_hash?: string;
      success?: boolean;
      wt?: unknown;
    }>('add_torrent', { magnet });

    // Seedr answers `queue_full_added_to_wishlist` when it parks a torrent in the
    // wishlist. Nothing downloads in that case, so it must not look like success.
    if (data.wt !== undefined) {
      throw new SeedrApiError(
        'Seedr queued this magnet to the wishlist instead of downloading it; ' +
          'the account queue is full',
      );
    }

    if (data.user_torrent_id === undefined) {
      throw new SeedrApiError('magnet rejected: no torrent id returned');
    }

    // Metadata resolves asynchronously, so size and peers are not known yet.
    return {
      id: String(data.user_torrent_id),
      name: data.title ?? null,
      state: 'pending',
      progress: 0,
      size: 0,
      folderId: null,
      seeders: 0,
      leechers: 0,
      error: null,
    };
  }

  /**
   * In-progress downloads.
   *
   * V1 has no task endpoint: active torrents appear in the root listing's
   * `torrents` array and disappear once they finish and become folders.
   */
  async listTransfers(): Promise<Transfer[]> {
    const data = await this.#call<V1FolderResponse>('list_contents', {
      content_type: 'folder',
      content_id: '0',
    });
    return (data.torrents ?? []).map(toTransfer);
  }

  async getPlaybackUrl(fileId: string): Promise<PlaybackUrl> {
    const data = await this.#call<{ url?: string; name?: string }>('fetch_file', {
      folder_file_id: fileId,
    });
    if (!data.url) {
      throw new SeedrApiError(`no playback url for file ${fileId}`);
    }

    // Probe the `ff_get` URL. On most accounts this is a 200 and we hand it
    // straight to the player. On some accounts (currently: a small fraction
    // routed to specific CDN hosts), every `ff_get` request returns 404 with
    // `Retry-After: 5` even for a URL minted seconds ago. We do not want a
    // single bad account to break a stream, so we fall back to the HLS
    // manifest that lives on the same file under `presentation_urls`.
    if (await probeFfGet(data.url)) {
      return {
        url: data.url,
        filename: data.name ?? '',
        expiresAt: parseExpiry(data.url),
        kind: 'direct',
      };
    }

    const hls = await this.#findHlsForFile(fileId);
    if (hls === null) {
      throw new SeedrApiError(
        `ff_get 404 and no HLS fallback for file ${fileId}; ` +
          'CDN appears broken and Seedr has no presentation stream',
      );
    }
    return {
      url: hls,
      filename: data.name ?? '',
      expiresAt: parseExpiry(hls),
      kind: 'hls',
    };
  }

  /**
   * Walks the account's folder tree looking for the file with the given id,
   * returning its HLS manifest URL when found. Seedr's V1 does not expose
   * `presentation_urls` from `fetch_file`, so we have to find the file
   * again via `get_folder`. Each `get_folder` call is a separate request;
   * for a library with shallow nesting (depth 2-3 in practice) this is
   * cheap. The recursion stops as soon as the file is located.
   */
  async #findHlsForFile(fileId: string): Promise<string | null> {
    const stack: Array<string | null> = [null];
    while (stack.length > 0) {
      const folderId = stack.pop();
      const page = await this.#call<{
        files: Array<{
          folder_file_id: number | string;
          presentation_urls?: { video?: { hls?: string } };
        }>;
        folders: Array<{ id: string | number }>;
      }>('get_folder', folderId === null ? {} : { id: String(folderId) });

      for (const file of page.files ?? []) {
        if (String(file.folder_file_id) === fileId) {
          return file.presentation_urls?.video?.hls ?? null;
        }
      }
      for (const folder of page.folders ?? []) {
        stack.push(String(folder.id));
      }
    }
    return null;
  }

  deleteFile(fileId: string): Promise<void> {
    return this.#delete('file', fileId);
  }

  deleteFolder(folderId: string): Promise<void> {
    return this.#delete('folder', folderId);
  }

  deleteTransfer(transferId: string): Promise<void> {
    return this.#delete('torrent', transferId);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.getQuota();
      return { healthy: true };
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return { healthy: false, reason: 'credentials rejected' };
      }
      return { healthy: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Captures a structured snapshot of the account: identity, current
   * token (masked), quota, root folder contents, in-flight transfers.
   *
   * The intent is the operator can `cat data/dumps/acc1.json` to
   * inspect what's happening with an account without hitting Seedr
   * every time. Used by the periodic dumper in `src/index.ts` and
   * the operator console's "dump" button.
   *
   * The access token is **never** written in full. The dump stores a
   * short prefix and suffix plus a flag so a re-issued token is
   * distinguishable in the file without leaking the secret.
   */
  async dumpAccount(): Promise<AccountDump> {
    // The token cache is local to the provider instance. We materialize
    // it before the API calls below so a 401-then-relogin does not
    // rewrite the timestamp between snapshots.
    await this.#accessToken();
    const cached = this.#token;
    const tokenDisplay = cached
      ? { issuedAt: cached.issuedAt, expiresIn: cached.expiresIn, prefix: cached.accessToken.slice(0, 6), suffix: cached.accessToken.slice(-4) }
      : null;

    const [quota, root, transfers] = await Promise.all([
      this.getQuota().catch((err) => ({ used: 0, max: 0, get free() { return 0; }, error: err instanceof Error ? err.message : String(err) } as never)),
      this.listFolder(null).catch((err) => ({ folders: [], files: [], error: err instanceof Error ? err.message : String(err) } as never)),
      this.listTransfers().catch(() => []),
    ]);

    return {
      accountId: this.accountId,
      email: this.email,
      capturedAt: Date.now(),
      token: tokenDisplay,
      quota: { used: quota.used, max: quota.max, free: quota.free },
      root: {
        folders: root.folders.map((f) => ({ id: f.id, name: f.name ?? f.path, size: f.size })),
        files: root.files.map((f) => ({ id: f.id, name: f.name, size: f.size, folderId: f.folderId })),
      },
      transfers: transfers.map((t) => ({
        id: t.id, name: t.name, state: t.state, progress: t.progress, size: t.size, seeders: t.seeders, leechers: t.leechers, error: t.error,
      })),
    };
  }

  /** V1 deletes files, folders, and torrents through one endpoint. */
  async #delete(type: 'file' | 'folder' | 'torrent', id: string): Promise<void> {
    await this.#call('delete', {
      delete_arr: JSON.stringify([{ type, id: Number(id) }]),
    });
  }

  /**
   * Authenticated call, retried once after a fresh login.
   *
   * Re-login is cheap and idempotent here, so a 401 is handled transparently
   * rather than surfaced as an error the way V2's broken chain must be.
   */
  async #call<T>(func: string, form?: Record<string, string>): Promise<T> {
    let token = await this.#accessToken();
    let res = await this.#send(func, token, form);
    let data = await readJson(res);

    if (res.status === 401 || data['error'] === 'access_denied') {
      token = await this.#login({ force: true });
      res = await this.#send(func, token, form);
      data = await readJson(res);
    }

    if (isV1RateLimited(res.status, data)) {
      this.#limiter.penalize(retryAfter(res));
      throw new RateLimitError(describeV1Error(data));
    }

    if (res.status === 401 || data['error'] === 'access_denied') {
      // A fresh login still refused: the password itself is wrong.
      this.#credentialsRejected = describeV1Error(data);
      throw new InvalidCredentialsError(this.accountId, this.#credentialsRejected);
    }

    if (!res.ok || data['result'] === false) {
      throw new SeedrApiError(`${func} failed: ${describeV1Error(data)}`, res.status);
    }

    this.#limiter.succeed();
    return data as T;
  }

  #send(
    func: string,
    token: string,
    form?: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(RESOURCE_URL);
    url.searchParams.set('access_token', token);
    url.searchParams.set('func', func);

    // GET for reads, form-encoded POST for anything with parameters. Passing
    // parameters in the query string changes behaviour for add_torrent, so they
    // always go in the body.
    if (!form) {
      return this.#fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    }

    return this.#fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form),
    });
  }

  /** Returns a cached token, logging in when absent or near expiry. */
  async #accessToken(): Promise<string> {
    if (this.#credentialsRejected !== null) {
      throw new InvalidCredentialsError(this.accountId, this.#credentialsRejected);
    }

    const cached = this.#token;
    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.issuedAt;
      if (age < cached.expiresIn - RELOGIN_MARGIN_SECONDS) return cached.accessToken;
    }

    return this.#login();
  }

  /**
   * Exchanges email and password for an access token.
   *
   * Concurrent callers share one in-flight login. Not for correctness — the grant
   * is idempotent — but to avoid eight accounts each firing a login on startup.
   */
  #login(options: { force?: boolean } = {}): Promise<string> {
    if (options.force) this.#token = null;

    this.#loginInFlight ??= this.#doLogin().finally(() => {
      this.#loginInFlight = null;
    });
    return this.#loginInFlight;
  }

  async #doLogin(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      type: 'login',
      username: this.email,
      password: this.#password,
    });

    const res = await this.#fetch(new URL(TOKEN_URL), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await readJson(res);

    // Checked before the credential branch: a throttled login says nothing about
    // whether the password is correct, and must not disable the account.
    if (isV1RateLimited(res.status, data)) {
      this.#limiter.penalize(retryAfter(res));
      throw new RateLimitError(describeV1Error(data));
    }

    const accessToken = data['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      const reason = describeV1Error(data);
      // 401 here is a genuine bad-password response.
      if (res.status === 401) {
        this.#credentialsRejected = reason;
        throw new InvalidCredentialsError(this.accountId, reason);
      }
      throw new SeedrApiError(`login failed: ${reason}`, res.status);
    }

    this.#limiter.succeed();
    this.#token = {
      accessToken,
      issuedAt: Math.floor(Date.now() / 1000),
      // Seedr reports ~30 days. Fall back to an hour if it ever stops saying.
      expiresIn: typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600,
    };
    return accessToken;
  }

  /** Every outbound request passes through the shared V1 limiter. */
  async #fetch(url: URL, init: RequestInit): Promise<Response> {
    await this.#limiter.acquire();
    return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
}

interface V1FolderResponse {
  space_used?: number;
  space_max?: number;
  folders?: V1Folder[];
  files?: V1File[];
  torrents?: V1Torrent[];
}

interface V1Folder {
  id: number;
  /** Root listings expose `path`; nested folders also carry `name`. */
  path?: string;
  name?: string;
  size?: number;
}

interface V1File {
  id: number;
  name: string;
  size?: number;
  hash?: string;
  folder_id?: number;
  is_video?: boolean;
  is_audio?: boolean;
}

interface V1Torrent {
  id: number;
  name?: string | null;
  size?: number;
  progress?: number;
  seeders?: number;
  leechers?: number;
  stopped?: number;
  warnings?: string[];
}

function toRemoteFolder(f: V1Folder): RemoteFolder {
  const folder: RemoteFolder = {
    id: String(f.id),
    path: f.path ?? f.name ?? '',
    size: f.size ?? 0,
  };
  if (f.name !== undefined) folder.name = f.name;
  return folder;
}

function toRemoteFile(f: V1File, fallbackFolderId: string): RemoteFile {
  return {
    id: String(f.id),
    name: f.name,
    size: f.size ?? 0,
    hash: f.hash ?? null,
    isVideo: f.is_video === true,
    isAudio: f.is_audio === true,
    // Root-level files carry no folder_id, so fall back to the folder queried.
    folderId: String(f.folder_id ?? fallbackFolderId),
  };
}

/**
 * Maps a V1 torrent entry onto a `Transfer`.
 *
 * V1 has no state field: presence in `torrents` means in progress, and a torrent
 * that finishes leaves the array entirely. `stopped` marks a paused download.
 */
export function toTransfer(t: V1Torrent): Transfer {
  const warning = t.warnings?.find((w) => w !== '') ?? null;
  return {
    id: String(t.id),
    name: t.name ?? null,
    state: t.stopped ? 'paused' : t.progress === 100 ? 'finished' : 'running',
    progress: t.progress ?? 0,
    size: t.size ?? 0,
    // V1 does not report the destination folder until the torrent is gone from
    // this list and the folder appears in the root listing.
    folderId: null,
    seeders: t.seeders ?? 0,
    leechers: t.leechers ?? 0,
    error: warning,
  };
}

/** True when a V1 response indicates throttling rather than a real failure. */
export function isV1RateLimited(status: number, data: Record<string, unknown>): boolean {
  if (status === 429) return true;
  // Seedr sometimes returns 403 with a rate-limit message rather than 429.
  return /rate limit|too many/i.test(describeV1Error(data));
}

/** Builds a readable message from V1's error shapes. */
export function describeV1Error(data: Record<string, unknown>): string {
  for (const key of ['reason_phrase', 'error_description', 'error', 'message']) {
    const value = data[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return 'unknown error';
}

function retryAfter(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Reads a JSON body, tolerating the HTML error pages Seedr sometimes returns. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through: a non-JSON body is reported with its status instead.
  }
  return { error: text === '' ? `HTTP ${res.status}` : text.slice(0, 200) };
}

/**
 * Asks Seedr's CDN whether the given `ff_get` URL is currently serving.
 * Returns true for a 200, false for a 404 (the broken-CDN case). Anything
 * else (5xx, network error, rate-limit) is treated as "unsure" and falls
 * back to true, so a transient Seedr hiccup never forces the HLS path.
 *
 * The probe sends a tiny Range header so we transfer at most a few KB even
 * on a 200 — players do the same to test reachability.
 */
export async function probeFfGet(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-127' },
      // Don't follow long: a streaming response would hang. We just need
      // the status line.
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 200 || res.status === 206) return true;
    if (res.status === 404) return false;
    // 429 (rate-limit), 5xx, anything else: lean on the URL.
    return true;
  } catch {
    // Network blip: keep the URL. The next request will either succeed
    // or fail the same way and the player will surface it.
    return true;
  }
}
