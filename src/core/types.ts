/**
 * Domain types for SeedrPool.
 *
 * `StorageProvider` is the seam that keeps Seedr specifics out of the core, per
 * rule 3 in agents.md. Nothing outside `src/providers/` may reference Seedr
 * endpoints, token shapes, or response formats.
 */

/** Credentials for one storage account. Rotates on every refresh. */
export interface AccountTokens {
  /** Short-lived bearer token. Seedr V2: 3600s. */
  accessToken: string;
  /**
   * Single-use refresh token. Using it invalidates it and yields a replacement.
   * The newest value is the only one that works — see RESEARCH.md.
   */
  refreshToken: string;
  /** Unix seconds when the access token was issued. */
  issuedAt: number;
  /** Access-token lifetime in seconds, as reported by the provider. */
  expiresIn: number;
}

/** Persisted state for one account in the pool. */
export interface AccountRecord {
  /** Stable local identifier, e.g. `acc1`. Used as the env-var prefix. */
  id: string;
  /** Human-readable label for the admin page. */
  label: string;
  /** Provider-side user identifier. */
  userId: string;
  tokens: AccountTokens;
  /** Last known capacity in bytes, refreshed on each quota check. */
  spaceMax: number;
  /**
   * Set when the refresh chain is broken and only a manual re-approval can
   * recover the account. Surfaced on the admin page.
   */
  needsReauth: boolean;
}

/** Live capacity for one account. */
export interface Quota {
  used: number;
  max: number;
  get free(): number;
}

/** A stored file as the library sees it, independent of provider specifics. */
export interface RemoteFile {
  /** Provider-side file identifier. */
  id: string;
  name: string;
  size: number;
  /** Provider-supplied content hash, used for cross-account dedup. SHA-1 on Seedr. */
  hash: string | null;
  /** Provider's own media classification. Preferred over extension matching. */
  isVideo: boolean;
  isAudio: boolean;
  /** Identifier of the containing folder. */
  folderId: string;
}

/** A folder listing. */
export interface RemoteFolder {
  id: string;
  /** Display path or name, whichever the provider supplies. */
  path: string;
  /**
   * Last path segment (e.g. `Movie.Name.2024` from `Movie.Name.2024/Subs`).
   * Used to match a folder back to the magnet that produced it. Optional
   * for providers that only return a flat path; we fall back to `path`
   * when `name` is absent.
   */
  name?: string;
  size: number;
}

export interface FolderContents {
  folders: RemoteFolder[];
  files: RemoteFile[];
}

/** Lifecycle of a download task. */
export type TransferState = 'pending' | 'running' | 'finished' | 'paused' | 'failed';

/** An in-progress or completed download. */
export interface Transfer {
  id: string;
  /** Null until the provider resolves the torrent's metadata. */
  name: string | null;
  state: TransferState;
  /** 0-100. */
  progress: number;
  /** Total bytes, 0 until metadata resolves. */
  size: number;
  /** Folder created for the completed download, if any. */
  folderId: string | null;
  /**
   * Peer counts. Zero seeders with zero progress means a dead magnet, which
   * providers report as an indefinitely running task rather than an error.
   */
  seeders: number;
  leechers: number;
  error: string | null;
}

/** A time-limited direct link to an original file. */
export interface PlaybackUrl {
  url: string;
  filename: string;
  /** Unix seconds after which the URL stops working, if known. */
  expiresAt: number | null;
  /**
   * `direct` for the original file (works with players that read a
   * range-byte stream). `hls` for the HLS manifest, used when the
   * direct CDN endpoint is broken or unavailable for this account.
   * Lets the Stremio client pick a compatible player.
   */
  kind: 'direct' | 'hls';
}

/**
 * Storage backend abstraction. One instance represents one account.
 *
 * Implementations must refresh their own credentials transparently and must
 * persist rotated tokens before returning, so a crash cannot lose a chain.
 */
export interface StorageProvider {
  /** Local account identifier this provider serves. */
  readonly accountId: string;

  /** Current capacity. */
  getQuota(): Promise<Quota>;

  /** List a folder, or the account root when `folderId` is null. */
  listFolder(folderId: string | null): Promise<FolderContents>;

  /** Queue a magnet for download. Resolves once accepted, not once complete. */
  addMagnet(magnet: string): Promise<Transfer>;

  /** All known transfers for this account. */
  listTransfers(): Promise<Transfer[]>;

  /** Mint a fresh direct URL for a file. Must be called per playback. */
  getPlaybackUrl(fileId: string): Promise<PlaybackUrl>;

  deleteFile(fileId: string): Promise<void>;
  deleteFolder(folderId: string): Promise<void>;
  deleteTransfer(transferId: string): Promise<void>;

  /**
   * Verify credentials and refresh if needed. Called at startup so a broken
   * chain surfaces immediately rather than at playback time.
   */
  healthCheck(): Promise<{ healthy: boolean; reason?: string }>;
}
