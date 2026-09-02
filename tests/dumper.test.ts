import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Dumper } from '../src/core/dumper.ts';
import { LibraryStore } from '../src/library/store.ts';
import { AccountPool } from '../src/core/account-pool.ts';
import { SeedrV1Provider } from '../src/providers/seedr-v1.ts';

class FakeProvider {
  readonly accountId: string;
  async getQuota() { return { used: 0, max: 6 * 1024 * 1024 * 1024, get free() { return 6 * 1024 * 1024 * 1024; } }; }
  async getPlaybackUrl() { return { url: 'x', filename: '', expiresAt: null, kind: 'direct' as const }; }
  async listFolder() { return { folders: [], files: [] }; }
  async addMagnet() { return { id: 'x', name: null, state: 'pending' as const, progress: 0, size: 0, folderId: null, seeders: 0, leechers: 0, error: null }; }
  async listTransfers() { return []; }
  async deleteFile() {}
  async deleteFolder() {}
  async deleteTransfer() {}
  async healthCheck() { return { healthy: true }; }
  async dumpAccount() {
    return {
      accountId: this.accountId,
      email: `${this.accountId}@x`,
      capturedAt: 2000,
      token: { issuedAt: 1000, expiresIn: 100, prefix: 'abcdef', suffix: '6789' },
      quota: { used: 0, max: 1, free: 1 },
      root: { folders: [], files: [] },
      transfers: [],
    };
  }
  constructor(accountId: string) { this.accountId = accountId; }
}

describe('Dumper', () => {
  let dir: string;
  let store: LibraryStore;
  let pool: AccountPool;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-dump-'));
    store = new LibraryStore(':memory:');
    pool = new AccountPool([
      { provider: new FakeProvider('acc1') as unknown as SeedrV1Provider, label: 'acc1', needsReauth: false },
      { provider: new FakeProvider('acc2') as unknown as SeedrV1Provider, label: 'acc2', needsReauth: false },
    ]);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes one file per account with masked token', async () => {
    const dumper = new Dumper({ directory: dir });
    const { written, errors } = await dumper.dump(pool as unknown as AccountPool);
    expect(errors).toEqual([]);
    expect(written.length).toBe(2);
    expect(written.every((p) => p.startsWith(dir))).toBe(true);
    for (const p of written) {
      const body = JSON.parse(readFileSync(p, 'utf8')) as {
        accountId: string;
        token: { prefix: string; suffix: string } | null;
      };
      expect(['acc1', 'acc2']).toContain(body.accountId);
      expect(body.token).not.toBeNull();
      // The full token is never in the file
      expect(JSON.stringify(body)).not.toContain('abcdef0123456789');
      expect(body.token?.prefix).toBe('abcdef');
      expect(body.token?.suffix).toBe('6789');
    }
  });

  it('keeps the last N files per account and prunes the rest', async () => {
    const dumper = new Dumper({ directory: dir, keepPerAccount: 2 });
    const r1 = await dumper.dump(pool as unknown as AccountPool);
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await dumper.dump(pool as unknown as AccountPool);
    await new Promise((res) => setTimeout(res, 5));
    const r3 = await dumper.dump(pool as unknown as AccountPool);
    expect(r1.written.length).toBe(2);
    expect(r2.written.length).toBe(2);
    expect(r3.written.length).toBe(2);
    const files = readdirSync(dir).filter((f) => f.startsWith('acc1.')).sort();
    expect(files.length).toBe(2);
  });

  it('latest() returns the most-recent dump per account', async () => {
    const dumper = new Dumper({ directory: dir });
    await dumper.dump(pool as unknown as AccountPool);
    await new Promise((res) => setTimeout(res, 5));
    await dumper.dump(pool as unknown as AccountPool);
    const list = await dumper.latest();
    expect(list.length).toBe(2);
    for (const entry of list) {
      expect(existsSync(entry.path)).toBe(true);
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it('handles a single-account pool', async () => {
    const single = new AccountPool([
      { provider: new FakeProvider('acc1') as unknown as SeedrV1Provider, label: 'acc1', needsReauth: false },
    ]);
    const dumper = new Dumper({ directory: dir });
    const { written, errors } = await dumper.dump(single as unknown as AccountPool);
    expect(errors).toEqual([]);
    expect(written.length).toBe(1);
  });
});
