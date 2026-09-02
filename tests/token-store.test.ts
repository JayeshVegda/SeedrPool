import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, parseEnv, groupAccounts, serializeAccounts } from '../src/core/token-store.ts';
import type { AccountRecord } from '../src/core/types.ts';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seedrpool-test-'));
  path = join(dir, 'accounts.env');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function account(id: string, refresh: string): AccountRecord {
  return {
    id,
    label: `label-${id}`,
    userId: '4860136',
    tokens: { accessToken: `access-${id}`, refreshToken: refresh, issuedAt: 1000, expiresIn: 3600 },
    spaceMax: 4831838208,
    needsReauth: false,
  };
}

describe('parseEnv', () => {
  it('ignores comments and blank lines', () => {
    const env = parseEnv('# comment\n\nA=1\n  B=2  \n');
    expect(env.get('A')).toBe('1');
    expect(env.get('B')).toBe('2');
    expect(env.size).toBe(2);
  });

  it('keeps = inside values, since tokens may contain them', () => {
    const env = parseEnv('T=abc=def==');
    expect(env.get('T')).toBe('abc=def==');
  });
});

describe('groupAccounts', () => {
  it('groups prefixed keys into records', () => {
    const env = parseEnv(
      'SEEDR_ACC1_USER_ID=1\nSEEDR_ACC1_REFRESH_TOKEN=r1\nSEEDR_ACC1_LABEL=first\n' +
        'SEEDR_ACC2_USER_ID=2\nSEEDR_ACC2_REFRESH_TOKEN=r2\n',
    );
    const accounts = groupAccounts(env);
    expect([...accounts.keys()].sort()).toEqual(['acc1', 'acc2']);
    expect(accounts.get('acc1')?.label).toBe('first');
    // Falls back to the id when no label is present.
    expect(accounts.get('acc2')?.label).toBe('acc2');
  });

  it('skips accounts with no refresh token, as they cannot self-recover', () => {
    const env = parseEnv('SEEDR_ACC1_USER_ID=1\nSEEDR_ACC1_ACCESS_TOKEN=only-access\n');
    expect(groupAccounts(env).size).toBe(0);
  });
});

describe('serializeAccounts', () => {
  it('round-trips through parse and group', () => {
    const original = account('acc1', 'refresh-1');
    const restored = groupAccounts(parseEnv(serializeAccounts([original]))).get('acc1');
    expect(restored).toEqual(original);
  });

  it('warns in the header that backups are useless', () => {
    expect(serializeAccounts([])).toContain('SINGLE-USE');
  });
});

describe('TokenStore', () => {
  it('treats a missing file as an empty store', async () => {
    const store = new TokenStore(path);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('persists a rotated refresh token before resolving', async () => {
    const store = new TokenStore(path);
    await store.load();
    await store.upsert(account('acc1', 'refresh-old'));

    await store.updateTokens('acc1', {
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      issuedAt: 2000,
      expiresIn: 3600,
    });

    // The critical guarantee: once updateTokens resolves, the new token is on
    // disk. A crash here must not lose the rotated value.
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('SEEDR_ACC1_REFRESH_TOKEN=refresh-new');
    expect(onDisk).not.toContain('refresh-old');
  });

  it('writes with mode 0600', async () => {
    const store = new TokenStore(path);
    await store.load();
    await store.upsert(account('acc1', 'r1'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', async () => {
    const store = new TokenStore(path);
    await store.load();
    await store.upsert(account('acc1', 'r1'));
    await expect(stat(`${path}.tmp`)).rejects.toThrow();
  });

  it('serializes concurrent writes so no token is lost', async () => {
    const store = new TokenStore(path);
    await store.load();
    await store.upsert(account('acc1', 'r0'));
    await store.upsert(account('acc2', 'r0'));

    // Two accounts refreshing at once: both writes must survive.
    await Promise.all([
      store.updateTokens('acc1', {
        accessToken: 'a1',
        refreshToken: 'r1-final',
        issuedAt: 1,
        expiresIn: 3600,
      }),
      store.updateTokens('acc2', {
        accessToken: 'a2',
        refreshToken: 'r2-final',
        issuedAt: 1,
        expiresIn: 3600,
      }),
    ]);

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('r1-final');
    expect(onDisk).toContain('r2-final');
  });

  it('clears needsReauth once fresh tokens arrive', async () => {
    const store = new TokenStore(path);
    await store.load();
    await store.upsert({ ...account('acc1', 'r1'), needsReauth: true });
    await store.updateTokens('acc1', {
      accessToken: 'a',
      refreshToken: 'r2',
      issuedAt: 1,
      expiresIn: 3600,
    });
    expect(store.get('acc1')?.needsReauth).toBe(false);
  });

  it('retains tokens when flagging needsReauth, to keep failures diagnosable', async () => {
    const store = new TokenStore(path);
    await store.load();
    await store.upsert(account('acc1', 'r-keep'));
    await store.markNeedsReauth('acc1', 'revoked');

    const reloaded = new TokenStore(path);
    await reloaded.load();
    expect(reloaded.get('acc1')?.needsReauth).toBe(true);
    expect(reloaded.get('acc1')?.tokens.refreshToken).toBe('r-keep');
  });

  it('rejects updates to unknown accounts', async () => {
    const store = new TokenStore(path);
    await store.load();
    await expect(
      store.updateTokens('nope', {
        accessToken: 'a',
        refreshToken: 'r',
        issuedAt: 1,
        expiresIn: 1,
      }),
    ).rejects.toThrow('unknown account');
  });

  it('reads back credentials written by an external process', async () => {
    // The first account was bootstrapped by hand during research; the store must
    // adopt such a file rather than requiring its own format.
    await writeFile(
      path,
      '# hand written\nSEEDR_ACC1_LABEL=acct-4gb\nSEEDR_ACC1_USER_ID=4860136\n' +
        'SEEDR_ACC1_ACCESS_TOKEN=at\nSEEDR_ACC1_REFRESH_TOKEN=rt\nSEEDR_ACC1_SPACE_MAX=4831838208\n',
      { mode: 0o600 },
    );
    const store = new TokenStore(path);
    await store.load();
    expect(store.get('acc1')?.label).toBe('acct-4gb');
    expect(store.get('acc1')?.spaceMax).toBe(4831838208);
  });
});
