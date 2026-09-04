/**
 * Runtime configuration, read from the environment with sensible defaults.
 *
 * Secrets are never hard-coded. The addon path segment is generated on first run
 * and persisted, because Stremio's protocol has no authentication and an
 * unguessable URL is the only practical protection (RESEARCH.md).
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Config {
  /** Port the HTTP server listens on. */
  port: number;
  /** Interface to bind. Defaults to loopback; Caddy fronts it in production. */
  host: string;
  /**
   * Path to the `email:password` account file, one line per Seedr account.
   * This is the live source of the pool's membership.
   */
  credentialsPath: string;
  /** SQLite database path. */
  databasePath: string;
  /**
   * Where periodic per-account JSON dumps land. One file per account per
   * dump, named `<accountId>.<unixMs>.json`. Old dumps are pruned; see
   * `Dumper` for the retention policy.
   */
  dumpsDir: string;
  /**
   * Unguessable URL segment protecting the addon routes. Anyone holding it can
   * browse and stream the library.
   */
  addonSecret: string;
  /** Public origin used to build absolute URLs in the manifest. */
  publicUrl: string;
  /** Admin username for basic auth. */
  adminUser: string;
  /** Admin password. Empty disables auth, which is only safe on loopback. */
  adminPassword: string;
  /**
   * TMDB v3 API key (Bearer token). Optional: when missing, the addon falls
   * back to plain Cinemeta-driven metadata without our own poster/background
   * enrichment. The free tier is plenty for this library's size.
   */
  tmdbApiKey: string;
}

const DEFAULT_SECRETS_DIR = '/opt/stacks/.secrets';

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const secretsDir = env['SEEDRPOOL_SECRETS_DIR'] ?? DEFAULT_SECRETS_DIR;
  const credentialsPath =
    env['SEEDRPOOL_CREDENTIALS_PATH'] ?? join(secretsDir, 'seedrpool-credentials.txt');
  const databasePath = env['SEEDRPOOL_DB_PATH'] ?? '/opt/stacks/sites/seedrpool/data/library.sqlite';
  const dumpsDir = env['SEEDRPOOL_DUMPS_DIR'] ?? '/app/data/dumps';
  const secretPath =
    env['SEEDRPOOL_ADDON_SECRET_PATH'] ?? join(secretsDir, 'seedrpool-addon-secret');

  const addonSecret = env['SEEDRPOOL_ADDON_SECRET'] ?? (await loadOrCreateSecret(secretPath));

  return {
    port: Number(env['SEEDRPOOL_PORT'] ?? 7010),
    host: env['SEEDRPOOL_HOST'] ?? '127.0.0.1',
    credentialsPath,
    databasePath,
    dumpsDir,
    addonSecret,
    publicUrl: (env['SEEDRPOOL_PUBLIC_URL'] ?? 'https://seedr.zayu.dev').replace(/\/$/, ''),
    adminUser: env['SEEDRPOOL_ADMIN_USER'] ?? 'jay',
    adminPassword: env['SEEDRPOOL_ADMIN_PASSWORD'] ?? '',
    tmdbApiKey: env['SEEDRPOOL_TMDB_API_KEY'] ?? '',
  };
}

/**
 * Reads a persisted secret, generating one on first run.
 *
 * The value must survive restarts: changing it invalidates every installed
 * addon URL and friends would have to reinstall.
 */
export async function loadOrCreateSecret(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing !== '') return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const secret = randomBytes(24).toString('base64url');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}
