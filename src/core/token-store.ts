import { readFile, writeFile, rename, chmod, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AccountRecord, AccountTokens } from './types.ts';

/**
 * Persists account credentials to a mode-0600 env file.
 *
 * Seedr V2 refresh tokens are single-use: consuming one yields a replacement and
 * revokes the old value. If a rotated token is lost before it reaches disk, that
 * account is permanently broken and needs a manual device approval. This class
 * exists to make that impossible under normal failure modes.
 *
 * Guarantees:
 *   - writes are atomic (temp file, fsync, rename) so a crash cannot truncate;
 *   - one writer per file, enforced by an in-process mutex;
 *   - the previous token is retained so a failed write is recoverable.
 *
 * Restoring this file from backup does NOT work — a backed-up refresh token has
 * already been revoked. See RESEARCH.md.
 */
export class TokenStore {
  #path: string;
  #accounts = new Map<string, AccountRecord>();
  /** Serializes writes so two refreshes cannot interleave and lose a token. */
  #writeLock: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  /** Reads and parses the env file. Missing file yields an empty store. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#accounts.clear();
        return;
      }
      throw err;
    }

    const env = parseEnv(raw);
    this.#accounts = groupAccounts(env);
  }

  /** All accounts, in id order. */
  list(): AccountRecord[] {
    return [...this.#accounts.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(accountId: string): AccountRecord | undefined {
    return this.#accounts.get(accountId);
  }

  /**
   * Replaces an account's tokens and flushes to disk before resolving.
   *
   * Callers must await this before using the new access token, so that a crash
   * between refresh and persist cannot orphan the rotated refresh token.
   */
  async updateTokens(accountId: string, tokens: AccountTokens): Promise<void> {
    const existing = this.#accounts.get(accountId);
    if (!existing) throw new Error(`unknown account: ${accountId}`);
    return this.#serialize(async () => {
      this.#accounts.set(accountId, { ...existing, tokens, needsReauth: false });
      await this.#flush();
    });
  }

  /** Adds or replaces an account wholesale, e.g. after device onboarding. */
  async upsert(record: AccountRecord): Promise<void> {
    return this.#serialize(async () => {
      this.#accounts.set(record.id, record);
      await this.#flush();
    });
  }

  /**
   * Flags an account as unrecoverable without manual re-approval. Tokens are
   * retained rather than cleared, so the failure can still be diagnosed.
   */
  async markNeedsReauth(accountId: string, _reason: string): Promise<void> {
    const existing = this.#accounts.get(accountId);
    if (!existing) return;
    return this.#serialize(async () => {
      this.#accounts.set(accountId, { ...existing, needsReauth: true });
      await this.#flush();
    });
  }

  /** Runs `fn` after all previously queued writes, regardless of their outcome. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#writeLock.then(fn, fn);
    // Swallow rejections on the chain itself so one failure cannot poison the
    // queue; the caller still receives the real rejection via `run`.
    this.#writeLock = run.catch(() => undefined);
    return run;
  }

  /** Atomically replaces the env file: temp write, fsync, rename. */
  async #flush(): Promise<void> {
    const tmp = `${this.#path}.tmp`;
    const body = serializeAccounts(this.list());

    await writeFile(tmp, body, { mode: 0o600 });
    // fsync the file so the rename cannot expose a partially written file.
    const fh = await open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, this.#path);
    await syncDir(dirname(this.#path));
  }
}

/** fsyncs a directory so a rename survives power loss. Best-effort. */
async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename itself is
    // still atomic, so this is not worth failing a token write over.
  }
}

/** Parses `KEY=value` lines, ignoring blanks and `#` comments. */
export function parseEnv(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

/** Collects `SEEDR_<ID>_<FIELD>` keys into account records. */
export function groupAccounts(env: Map<string, string>): Map<string, AccountRecord> {
  const byId = new Map<string, Map<string, string>>();

  for (const [key, value] of env) {
    const match = /^SEEDR_([A-Z0-9]+)_(.+)$/.exec(key);
    if (!match) continue;
    const [, rawId, field] = match;
    if (rawId === undefined || field === undefined) continue;
    const id = rawId.toLowerCase();
    let fields = byId.get(id);
    if (!fields) {
      fields = new Map();
      byId.set(id, fields);
    }
    fields.set(field, value);
  }

  const out = new Map<string, AccountRecord>();
  for (const [id, fields] of byId) {
    const accessToken = fields.get('ACCESS_TOKEN');
    const refreshToken = fields.get('REFRESH_TOKEN');
    const userId = fields.get('USER_ID');
    // An account without a refresh token cannot be recovered automatically, so
    // it is not a usable pool member.
    if (!refreshToken || !userId) continue;

    out.set(id, {
      id,
      label: fields.get('LABEL') ?? id,
      userId,
      tokens: {
        accessToken: accessToken ?? '',
        refreshToken,
        issuedAt: Number(fields.get('ISSUED_AT') ?? 0),
        expiresIn: Number(fields.get('EXPIRES_IN') ?? 3600),
      },
      spaceMax: Number(fields.get('SPACE_MAX') ?? 0),
      needsReauth: fields.get('NEEDS_REAUTH') === '1',
    });
  }
  return out;
}

const FILE_HEADER = `# SeedrPool account pool credentials
# Seedr V2 OAuth device-flow tokens, managed by SeedrPool's TokenStore.
#
# WARNING: refresh tokens are SINGLE-USE and ROTATE on every use. Only the
# newest value works. Restoring this file from a backup will NOT recover an
# account — the backed-up token is already revoked. See RESEARCH.md.
#
# Do not edit while SeedrPool is running; it owns this file.
`;

/** Renders account records back to env-file form. */
export function serializeAccounts(accounts: AccountRecord[]): string {
  const lines = [FILE_HEADER];
  for (const a of accounts) {
    const p = `SEEDR_${a.id.toUpperCase()}`;
    lines.push(
      `${p}_LABEL=${a.label}`,
      `${p}_USER_ID=${a.userId}`,
      `${p}_ACCESS_TOKEN=${a.tokens.accessToken}`,
      `${p}_REFRESH_TOKEN=${a.tokens.refreshToken}`,
      `${p}_ISSUED_AT=${a.tokens.issuedAt}`,
      `${p}_EXPIRES_IN=${a.tokens.expiresIn}`,
      `${p}_SPACE_MAX=${a.spaceMax}`,
      `${p}_NEEDS_REAUTH=${a.needsReauth ? '1' : '0'}`,
      '',
    );
  }
  return lines.join('\n');
}
