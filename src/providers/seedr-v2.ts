/**
 * Seedr V2 API client and `StorageProvider` implementation.
 *
 * This is the only file permitted to know Seedr's endpoints and payload shapes.
 * Everything above it works through `StorageProvider` (agents.md rule 3).
 *
 * Verified behaviour this depends on (RESEARCH.md):
 *   - access tokens live 3600s; refresh tokens are single-use and rotate;
 *   - `download/file/{id}/url` returns the untranscoded original, range-capable,
 *     valid for roughly 24h, so it must be minted per playback;
 *   - a dead magnet reports `state: running, progress: 0, seeders: 0` forever
 *     rather than failing.
 */

import type {
  FolderContents,
  PlaybackUrl,
  Quota,
  RemoteFile,
  RemoteFolder,
  StorageProvider,
  Transfer,
  TransferState,
} from '../core/types.ts';
import type { TokenStore } from '../core/token-store.ts';
import { seedrRateLimiter } from '../core/rate-limiter.ts';
import {
  RateLimitError,
  SeedrApiError,
  describeError,
  makeQuota,
  parseExpiry,
  retryAfterSeconds,
} from './shared.ts';

// Re-exported for callers that already import these from here.
export {
  RateLimitError,
  SeedrApiError,
  describeError,
  makeQuota,
  parseExpiry,
  retryAfterSeconds,
};

const API_BASE = 'https://v2.seedr.cc/api/v0.1/p';

/**
 * Public OAuth client used by Seedr's own integrations.
 *
 * Seedr now refuses NEW authorizations for this client id ("This application is
 * not available for authorization"), which is why the V1 password provider is the
 * default. Kept because already-authorized tokens still work. See RESEARCH.md.
 */
const CLIENT_ID = 'tn7B667iqQajxkyMKtiVitHvfnxsS1Tj';

const SCOPES = 'files.read files.write tasks.read tasks.write profile';

/**
 * Refresh this many seconds before expiry.
 *
 * Kept small on purpose. A large margin means every request inside the window
 * attempts a refresh, which trips Seedr's per-client throttle and can push a
 * healthy account into a failing state (RESEARCH.md).
 */
const REFRESH_MARGIN_SECONDS = 120;

const REQUEST_TIMEOUT_MS = 30_000;

/** Raised when a token chain is broken and only manual re-approval recovers it. */
export class ReauthRequiredError extends Error {
  readonly accountId: string;

  constructor(accountId: string, reason: string) {
    super(`account ${accountId} needs re-authorization: ${reason}`);
    this.name = 'ReauthRequiredError';
    this.accountId = accountId;
  }
}

/** True when an error response indicates throttling rather than a real failure. */
export function isRateLimited(status: number, data: Record<string, unknown>): boolean {
  if (status === 429) return true;
  return /rate limit/i.test(describeError(data));
}

/** Device-flow handshake data, shown to the user during onboarding. */
export interface DeviceCodeRequest {
  deviceCode: string;
  userCode: string;
  /** Absolute URL with the code embedded, so the user need not type it. */
  verificationUrl: string;
  expiresIn: number;
  /** Seconds to wait between polls, per the device-flow spec. */
  interval: number;
}

/** Tokens plus identity, as returned by a successful grant. */
export interface GrantResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}

/** Starts the device flow. The user must approve in a logged-in browser. */
export async function requestDeviceCode(): Promise<DeviceCodeRequest> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES });
  const data = await postForm<{
    device_code: string;
    user_code: string;
    verification_uri_complete?: string;
    verification_uri?: string;
    expires_in: number;
    interval: number;
  }>(`${API_BASE}/oauth/device/code`, body);

  // The API returns a site-relative path; make it absolute for the admin page.
  const relative = data.verification_uri_complete ?? data.verification_uri ?? '';
  const verificationUrl = relative.startsWith('http')
    ? relative
    : `https://v2.seedr.cc${relative}`;

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

/**
 * Exchanges an approved device code for tokens.
 *
 * Returns null while the user has not yet approved, so callers can poll.
 * Throws `RateLimitError` when Seedr is throttling, which is transient: the
 * device code stays valid and polling should simply back off.
 */
export async function pollDeviceCode(deviceCode: string): Promise<GrantResult | null> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: CLIENT_ID,
  });

  const res = await fetchWithTimeout(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof data['access_token'] === 'string' && data['access_token'] !== '') {
    return toGrantResult(data);
  }

  // Throttling must not be mistaken for a dead code; several flows polling at
  // once will trip this.
  if (isRateLimited(res.status, data)) {
    throw new RateLimitError(describeError(data));
  }

  // Still waiting on the user. Anything else is a real failure.
  if (data['error'] === 'authorization_pending' || res.status === 400) return null;

  throw new SeedrApiError(
    `device code exchange failed: ${describeError(data)}`,
    res.status,
  );
}

function toGrantResult(data: Record<string, unknown>): GrantResult {
  const accessToken = data['access_token'];
  const refreshToken = data['refresh_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new SeedrApiError('grant response contained no access token');
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // Without a refresh token the account cannot survive an hour, so refuse it
    // rather than storing a credential that will silently expire.
    throw new SeedrApiError('grant response contained no refresh token');
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600,
    userId: String(data['user_id'] ?? ''),
  };
}

export class SeedrV2Provider implements StorageProvider {
  readonly accountId: string;
  #store: TokenStore;
  /** Guards against two concurrent refreshes racing to consume one token. */
  #refreshInFlight: Promise<string> | null = null;

  constructor(accountId: string, store: TokenStore) {
    this.accountId = accountId;
    this.#store = store;
  }

  async getQuota(): Promise<Quota> {
    const data = await this.#get<{ space_used: number; space_max: number }>(
      '/fs/root/contents',
    );
    return makeQuota(data.space_used, data.space_max);
  }

  async listFolder(folderId: string | null): Promise<FolderContents> {
    const path =
      folderId === null ? '/fs/root/contents' : `/fs/folder/${encodeURIComponent(folderId)}/contents`;
    const data = await this.#get<SeedrFolderResponse>(path);
    return {
      folders: (data.folders ?? []).map(toRemoteFolder),
      files: (data.files ?? []).map(toRemoteFile),
    };
  }

  async addMagnet(magnet: string): Promise<Transfer> {
    const data = await this.#request<{
      user_torrent_id?: number;
      title?: string | null;
      success?: boolean;
      torrent_hash?: string;
    }>('POST', '/tasks', { json: { torrent_magnet: magnet } });

    if (data.success === false || data.user_torrent_id === undefined) {
      throw new SeedrApiError(`magnet rejected: ${describeError(data)}`);
    }

    // Seedr accepts immediately and resolves metadata asynchronously, so size
    // and peer counts are not known yet.
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

  async listTransfers(): Promise<Transfer[]> {
    const data = await this.#get<{ tasks?: SeedrTask[] }>('/tasks');
    return (data.tasks ?? []).map(toTransfer);
  }

  async getPlaybackUrl(fileId: string): Promise<PlaybackUrl> {
    const data = await this.#get<{ url?: string; name?: string; success?: boolean }>(
      `/download/file/${encodeURIComponent(fileId)}/url`,
    );
    if (!data.url) {
      throw new SeedrApiError(`no playback url for file ${fileId}: ${describeError(data)}`);
    }
    return {
      url: data.url,
      filename: data.name ?? '',
      expiresAt: parseExpiry(data.url),
      kind: 'direct',
    };
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.#request('DELETE', `/fs/file/${encodeURIComponent(fileId)}`);
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.#request('DELETE', `/fs/folder/${encodeURIComponent(folderId)}`);
  }

  async deleteTransfer(transferId: string): Promise<void> {
    await this.#request('DELETE', `/tasks/${encodeURIComponent(transferId)}`);
  }

  /**
   * Forces a token check so a broken chain is reported at startup rather than
   * when someone presses play.
   */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.getQuota();
      return { healthy: true };
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        return { healthy: false, reason: 'needs re-authorization' };
      }
      return { healthy: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Returns a valid access token, refreshing proactively when near expiry. */
  async #accessToken(): Promise<string> {
    const record = this.#store.get(this.accountId);
    if (!record) throw new Error(`unknown account: ${this.accountId}`);
    if (record.needsReauth) {
      throw new ReauthRequiredError(this.accountId, 'flagged in token store');
    }

    const { accessToken, issuedAt, expiresIn } = record.tokens;
    const age = Math.floor(Date.now() / 1000) - issuedAt;
    const stale = accessToken === '' || age >= expiresIn - REFRESH_MARGIN_SECONDS;
    if (!stale) return accessToken;

    return this.#refresh();
  }

  /**
   * Consumes the refresh token and persists its replacement.
   *
   * Concurrent callers share one in-flight refresh: two simultaneous refreshes
   * would each try to consume the same single-use token, and the loser would
   * break the chain.
   */
  #refresh(): Promise<string> {
    this.#refreshInFlight ??= this.#doRefresh().finally(() => {
      this.#refreshInFlight = null;
    });
    return this.#refreshInFlight;
  }

  async #doRefresh(): Promise<string> {
    const record = this.#store.get(this.accountId);
    if (!record) throw new Error(`unknown account: ${this.accountId}`);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: record.tokens.refreshToken,
      client_id: CLIENT_ID,
    });

    const res = await fetchWithTimeout(`${API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    // Throttling must never be mistaken for a broken chain: the refresh token
    // has not been consumed, so retrying later works. Marking the account as
    // needing re-auth here would send the user to re-approve for no reason.
    if (isRateLimited(res.status, data)) {
      seedrRateLimiter.penalize(retryAfterSeconds(res));
      throw new RateLimitError(describeError(data));
    }

    if (!res.ok || typeof data['access_token'] !== 'string' || data['access_token'] === '') {
      const reason = describeError(data);
      // 401 means the chain is gone for good; nothing but manual approval helps.
      if (res.status === 401) {
        await this.#store.markNeedsReauth(this.accountId, reason);
        throw new ReauthRequiredError(this.accountId, reason);
      }
      throw new SeedrApiError(`token refresh failed: ${reason}`, res.status);
    }

    seedrRateLimiter.succeed();
    const grant = toGrantResult(data);

    // Persist before returning. If this throws, the caller sees the failure and
    // the rotated token is not silently lost.
    await this.#store.updateTokens(this.accountId, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: grant.expiresIn,
    });

    return grant.accessToken;
  }

  #get<T>(path: string): Promise<T> {
    return this.#request<T>('GET', path);
  }

  /** Authenticated request with one retry on 401 to absorb early expiry. */
  async #request<T>(
    method: string,
    path: string,
    opts: { json?: unknown } = {},
  ): Promise<T> {
    let token = await this.#accessToken();
    let res = await this.#send(method, path, token, opts);

    if (res.status === 401) {
      // Observed: access tokens can stop working before their nominal expiry.
      token = await this.#refresh();
      res = await this.#send(method, path, token, opts);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    // Checked before the 401 branch: a throttled response says nothing about
    // whether credentials are valid, and must not flag the account.
    if (isRateLimited(res.status, data)) {
      seedrRateLimiter.penalize(retryAfterSeconds(res));
      throw new RateLimitError(describeError(data));
    }

    if (!res.ok) {
      if (res.status === 401) {
        const reason = describeError(data);
        await this.#store.markNeedsReauth(this.accountId, reason);
        throw new ReauthRequiredError(this.accountId, reason);
      }
      throw new SeedrApiError(`${method} ${path} failed: ${describeError(data)}`, res.status);
    }

    seedrRateLimiter.succeed();
    return data as T;
  }

  #send(
    method: string,
    path: string,
    token: string,
    opts: { json?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    }
    return fetchWithTimeout(`${API_BASE}${path}`, init);
  }
}

interface SeedrFolderResponse {
  space_used?: number;
  space_max?: number;
  folders?: SeedrFolder[];
  files?: SeedrFile[];
}

/** Root listings expose `path`; nested folders may also carry `name`. */
interface SeedrFolder {
  id: number;
  path?: string;
  name?: string;
  size?: number;
}

interface SeedrFile {
  id: number;
  name: string;
  size?: number;
  hash?: string;
  folder_id?: number;
  is_video?: boolean;
  is_audio?: boolean;
}

interface SeedrTask {
  id: number;
  name?: string | null;
  state?: string;
  progress?: number;
  size?: number;
  folder_created_id?: number | null;
  error?: string | null;
  torrent_payload?: { seeders?: number; leechers?: number; download_rate?: number };
}

function toRemoteFolder(f: SeedrFolder): RemoteFolder {
  const folder: RemoteFolder = {
    id: String(f.id),
    path: f.path ?? f.name ?? '',
    size: f.size ?? 0,
  };
  if (f.name !== undefined) folder.name = f.name;
  return folder;
}

function toRemoteFile(f: SeedrFile): RemoteFile {
  return {
    id: String(f.id),
    name: f.name,
    size: f.size ?? 0,
    hash: f.hash ?? null,
    isVideo: f.is_video === true,
    isAudio: f.is_audio === true,
    folderId: String(f.folder_id ?? ''),
  };
}

export function toTransfer(t: SeedrTask): Transfer {
  return {
    id: String(t.id),
    name: t.name ?? null,
    state: normalizeState(t.state, t.error),
    progress: t.progress ?? 0,
    size: t.size ?? 0,
    folderId: t.folder_created_id != null ? String(t.folder_created_id) : null,
    seeders: t.torrent_payload?.seeders ?? 0,
    leechers: t.torrent_payload?.leechers ?? 0,
    error: t.error ?? null,
  };
}

function normalizeState(state: string | undefined, error: string | null | undefined): TransferState {
  if (error) return 'failed';
  switch (state) {
    case 'finished':
      return 'finished';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'pending':
      return 'pending';
    default:
      // Unknown states are treated as running rather than failed; the stall
      // detector will catch anything that never progresses.
      return state ? 'running' : 'pending';
  }
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (isRateLimited(res.status, data)) {
    seedrRateLimiter.penalize(retryAfterSeconds(res));
    throw new RateLimitError(describeError(data));
  }
  if (!res.ok) {
    throw new SeedrApiError(`POST ${url} failed: ${describeError(data)}`, res.status);
  }
  seedrRateLimiter.succeed();
  return data as T;
}

/**
 * Every outbound Seedr request passes through the shared limiter, so bursts are
 * smoothed and one throttle response pauses all callers.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  await seedrRateLimiter.acquire();
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
