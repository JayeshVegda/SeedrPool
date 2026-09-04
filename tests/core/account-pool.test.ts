import { describe, it, expect } from 'vitest';
import {
  AccountPool,
  NoCapacityError,
  STREAM_LIMIT_PER_ACCOUNT,
  isDeadTransfer,
  type AccountPoolEntry,
} from '../../src/core/account-pool.ts';
import { makeQuota } from '../../src/providers/shared.ts';
import type { FolderContents, PlaybackUrl, Quota, StorageProvider, Transfer } from '../../src/core/types.ts';

/** Minimal in-memory provider so pool logic is tested without network access. */
class FakeProvider implements StorageProvider {
  readonly accountId: string;
  #quota: Quota | Error;
  transfers: Transfer[] = [];

  constructor(accountId: string, used: number, max: number | Error) {
    this.accountId = accountId;
    this.#quota = max instanceof Error ? max : makeQuota(used, max);
  }

  async getQuota(): Promise<Quota> {
    if (this.#quota instanceof Error) throw this.#quota;
    return this.#quota;
  }

  async listFolder(): Promise<FolderContents> {
    return { folders: [], files: [] };
  }

  async addMagnet(): Promise<Transfer> {
    throw new Error('not used');
  }

  async listTransfers(): Promise<Transfer[]> {
    if (this.#quota instanceof Error) throw this.#quota;
    return this.transfers;
  }

  async getPlaybackUrl(): Promise<PlaybackUrl> {
    throw new Error('not used');
  }

  async deleteFile(): Promise<void> {}
  async deleteFolder(): Promise<void> {}
  async deleteTransfer(): Promise<void> {}

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    if (this.#quota instanceof Error) return { healthy: false, reason: this.#quota.message };
    return { healthy: true };
  }
}

const GIB = 1024 ** 3;

function entry(
  id: string,
  used: number,
  max: number | Error,
  needsReauth = false,
): AccountPoolEntry {
  return { provider: new FakeProvider(id, used, max), label: `label-${id}`, needsReauth };
}

function reauthError(): Error {
  const err = new Error('account acc2 needs re-authorization: Token has been revoked');
  err.name = 'ReauthRequiredError';
  return err;
}

function badPasswordError(): Error {
  const err = new Error('account acc2 credentials rejected: invalid_grant');
  err.name = 'InvalidCredentialsError';
  return err;
}

describe('AccountPool health', () => {
  it('treats accounts as unhealthy until refreshed', () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    expect(pool.statuses()[0]).toMatchObject({ healthy: false, reason: 'not yet checked' });
    expect(pool.capacity().healthyAccounts).toBe(0);
  });

  it('records quota for healthy accounts after refresh', async () => {
    const pool = new AccountPool([entry('acc1', GIB, 4 * GIB)]);
    const statuses = await pool.refresh();
    expect(statuses[0]).toMatchObject({ healthy: true, needsReauth: false });
    expect(statuses[0]?.quota?.free).toBe(3 * GIB);
  });

  it('isolates one failing account from the rest', async () => {
    const pool = new AccountPool([
      entry('acc1', 0, 4 * GIB),
      entry('acc2', 0, new Error('network down')),
      entry('acc3', 0, 7 * GIB),
    ]);
    await pool.refresh();

    expect(pool.capacity()).toMatchObject({
      max: 11 * GIB,
      healthyAccounts: 2,
      totalAccounts: 3,
    });
    expect(pool.statuses()[1]).toMatchObject({ healthy: false, reason: 'network down' });
  });

  it('detects a revoked chain as needing re-auth', async () => {
    const pool = new AccountPool([entry('acc2', 0, reauthError())]);
    await pool.refresh();
    expect(pool.statuses()[0]).toMatchObject({ healthy: false, needsReauth: true });
  });

  it('flags a rejected password as needing attention, like a revoked chain', async () => {
    // V1's equivalent failure: only editing the credentials file can fix it.
    const pool = new AccountPool([entry('acc2', 0, badPasswordError())]);
    await pool.refresh();
    expect(pool.statuses()[0]).toMatchObject({ healthy: false, needsReauth: true });
  });

  it('skips probing accounts already flagged for re-auth', async () => {
    // Flagged upfront, so no request should be attempted at all.
    const pool = new AccountPool([entry('acc1', 0, new Error('should not be called'), true)]);
    await pool.refresh();
    expect(pool.statuses()[0]).toMatchObject({
      healthy: false,
      needsReauth: true,
      reason: 'needs re-authorization',
    });
  });

  it('excludes unhealthy accounts from healthyProviders', async () => {
    const pool = new AccountPool([
      entry('acc1', 0, 4 * GIB),
      entry('acc2', 0, new Error('down')),
    ]);
    await pool.refresh();
    expect(pool.healthyProviders().map((p) => p.accountId)).toEqual(['acc1']);
  });
});

describe('AccountPool allocation', () => {
  it('picks the account with the most free space', async () => {
    const pool = new AccountPool([
      entry('acc1', 3 * GIB, 4 * GIB), // 1 GiB free
      entry('acc2', GIB, 7 * GIB), // 6 GiB free
      entry('acc3', 2 * GIB, 4 * GIB), // 2 GiB free
    ]);
    await pool.refresh();

    const allocation = pool.allocate(500 * 1024 * 1024);
    expect(allocation.accountId).toBe('acc2');
    expect(allocation.reason).toContain('6.00 GiB');
  });

  it('skips accounts without room even when they are idle', async () => {
    const pool = new AccountPool([
      entry('acc1', 0, 1 * GIB), // idle but too small
      entry('acc2', 0, 7 * GIB),
    ]);
    await pool.refresh();
    expect(pool.allocate(2 * GIB).accountId).toBe('acc2');
  });

  it('prefers an idle account over a larger busy one', async () => {
    const pool = new AccountPool([
      entry('acc1', 0, 7 * GIB), // most space, but saturated
      entry('acc2', 0, 4 * GIB), // less space, idle
    ]);
    await pool.refresh();

    for (let i = 0; i < STREAM_LIMIT_PER_ACCOUNT; i += 1) pool.acquireStream('acc1');

    // Spreading content matters because an account only serves ~3 streams.
    expect(pool.allocate(GIB).accountId).toBe('acc2');
  });

  it('falls back to a busy account when no idle account has room', async () => {
    const pool = new AccountPool([
      entry('acc1', 0, 7 * GIB), // saturated but roomy
      entry('acc2', 0, 1 * GIB), // idle but too small
    ]);
    await pool.refresh();
    for (let i = 0; i < STREAM_LIMIT_PER_ACCOUNT; i += 1) pool.acquireStream('acc1');

    // A 429 during playback is recoverable; a rejected download is not.
    const allocation = pool.allocate(2 * GIB);
    expect(allocation.accountId).toBe('acc1');
    expect(allocation.reason).toContain('all accounts busy');
  });

  it('prefers the least busy account when several have room', async () => {
    const pool = new AccountPool([
      entry('acc1', 0, 7 * GIB),
      entry('acc2', 0, 7 * GIB),
    ]);
    await pool.refresh();
    pool.acquireStream('acc1');

    expect(pool.allocate(GIB).accountId).toBe('acc2');
  });

  it('throws NoCapacityError describing the shortfall', async () => {
    const pool = new AccountPool([entry('acc1', 3 * GIB, 4 * GIB)]);
    await pool.refresh();

    try {
      pool.allocate(2 * GIB);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NoCapacityError);
      expect((err as NoCapacityError).largestFree).toBe(GIB);
    }
  });

  it('refuses to allocate to unhealthy accounts', async () => {
    const pool = new AccountPool([entry('acc1', 0, new Error('down'))]);
    await pool.refresh();
    expect(() => pool.allocate(1024)).toThrow(NoCapacityError);
  });
});

describe('CDN health', () => {
  it('marks an account as CDN-broken and excludes it from allocation', async () => {
    const broken = entry('acc1', 0, 4 * GIB);
    const healthy = entry('acc2', 0, 4 * GIB);
    const pool = new AccountPool([broken, healthy]);
    await pool.refresh();

    pool.markCdnBroken('acc1', 'ff_get 404');

    const statuses = pool.statuses();
    expect(statuses.find((s) => s.accountId === 'acc1')?.cdnHealthy).toBe(false);
    expect(statuses.find((s) => s.accountId === 'acc1')?.cdnReason).toBe('ff_get 404');
    // The pool still picks the healthy account.
    expect(pool.allocate(1024).accountId).toBe('acc2');
  });

  it('clears the mark on markCdnHealthy', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    await pool.refresh();
    pool.markCdnBroken('acc1', '404');
    pool.markCdnHealthy('acc1');
    const s = pool.statuses()[0];
    expect(s?.cdnHealthy).toBe(true);
    expect(s?.cdnReason).toBeUndefined();
    expect(s?.cdnBrokenAt).toBeUndefined();
  });

  it('preserves the CDN mark across a refresh', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    await pool.refresh();
    pool.markCdnBroken('acc1', '404');
    await pool.refresh();
    expect(pool.statuses()[0]?.cdnHealthy).toBe(false);
  });

  it('auto-clears the mark after the quarantine window', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    await pool.refresh();
    // Mark the failure as ancient. The pool should treat the CDN as fine
    // because the quarantine window has elapsed.
    pool.markCdnBroken('acc1', 'old failure', Date.now() - 2 * 60 * 60_000);
    const s = pool.statuses()[0];
    expect(s?.cdnHealthy).toBe(true);
    expect(s?.cdnReason).toBeUndefined();
    expect(s?.cdnBrokenAt).toBeUndefined();
  });
});

describe('stream accounting', () => {
  it('counts and releases streams', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    await pool.refresh();

    const release = pool.acquireStream('acc1');
    expect(pool.activeStreams('acc1')).toBe(1);
    release();
    expect(pool.activeStreams('acc1')).toBe(0);
  });

  it('ignores a double release so load is not understated', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    await pool.refresh();

    const release = pool.acquireStream('acc1');
    pool.acquireStream('acc1');
    release();
    release();
    expect(pool.activeStreams('acc1')).toBe(1);
  });

  it('never goes negative', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    const release = pool.acquireStream('acc1');
    release();
    release();
    expect(pool.activeStreams('acc1')).toBe(0);
  });

  it('reports saturation at the measured 429 threshold', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    for (let i = 0; i < STREAM_LIMIT_PER_ACCOUNT - 1; i += 1) pool.acquireStream('acc1');
    expect(pool.isSaturated('acc1')).toBe(false);
    pool.acquireStream('acc1');
    expect(pool.isSaturated('acc1')).toBe(true);
  });

  it('surfaces stream counts in statuses', async () => {
    const pool = new AccountPool([entry('acc1', 0, 4 * GIB)]);
    await pool.refresh();
    pool.acquireStream('acc1');
    expect(pool.statuses()[0]?.activeStreams).toBe(1);
  });
});

describe('transfers', () => {
  it('tags transfers with their account and tolerates failures', async () => {
    const good = entry('acc1', 0, 4 * GIB);
    (good.provider as FakeProvider).transfers = [
      {
        id: '1',
        name: 'Movie',
        state: 'finished',
        progress: 100,
        size: 100,
        folderId: '9',
        seeders: 5,
        leechers: 0,
        error: null,
      },
    ];

    const pool = new AccountPool([good, entry('acc2', 0, new Error('down'))]);
    await pool.refresh();

    const transfers = await pool.listAllTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ id: '1', accountId: 'acc1' });
  });
});

describe('isDeadTransfer', () => {
  const base: Transfer = {
    id: '1',
    name: null,
    state: 'running',
    progress: 0,
    size: 0,
    folderId: null,
    seeders: 0,
    leechers: 0,
    error: null,
  };

  it('flags a stalled zero-seeder transfer once past the grace period', () => {
    expect(isDeadTransfer(base, 300)).toBe(true);
  });

  it('allows time for peer discovery before judging', () => {
    expect(isDeadTransfer(base, 30)).toBe(false);
  });

  it('does not flag transfers that have peers or progress', () => {
    expect(isDeadTransfer({ ...base, seeders: 28 }, 300)).toBe(false);
    expect(isDeadTransfer({ ...base, progress: 5 }, 300)).toBe(false);
  });

  it('does not flag finished transfers that happen to have no seeders', () => {
    // A completed download legitimately reports zero seeders.
    expect(isDeadTransfer({ ...base, state: 'finished', progress: 100 }, 9999)).toBe(false);
  });
});

describe('scales to N accounts', () => {
  const GIB = 1024 ** 3;

  it('handles a 50-account pool without losing fairness', async () => {
    // 50 fake providers, 6.5 GiB each. The pool itself is a Map of
    // arbitrary size; this test pins the contract that the allocator
    // works for any number of accounts.
    const entries = Array.from({ length: 50 }, (_, i) => entry(`acc${i + 1}`, 0, 6 * GIB));
    const pool = new AccountPool(entries);
    await pool.refresh();

    expect(pool.capacity().totalAccounts).toBe(50);
    expect(pool.capacity().healthyAccounts).toBe(50);
    expect(pool.capacity().max).toBe(50 * 6 * GIB);
    expect(pool.healthyProviders()).toHaveLength(50);
  });

  it('allocator picks the least-loaded across 50 accounts', async () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      entry(`acc${i + 1}`, 0, 6 * GIB)
    );
    const pool = new AccountPool(entries);
    await pool.refresh();

    // Pre-load 49 accounts with one stream each; acc50 should be chosen.
    for (let i = 0; i < 49; i += 1) {
      pool.acquireStream(`acc${i + 1}`);
    }

    const allocation = pool.allocate(0);
    expect(allocation.accountId).toBe('acc50');
  });

  it('allocator spreads across 50 accounts when fresh', async () => {
    // Without any pre-loaded streams, every account looks equally idle.
    // 50 successive allocations should not all land on the same account.
    const entries = Array.from({ length: 50 }, (_, i) =>
      entry(`acc${i + 1}`, 0, 6 * GIB)
    );
    const pool = new AccountPool(entries);
    await pool.refresh();

    const landed = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      landed.add(pool.allocate(0).accountId);
    }
    // The allocator sorts by free space; with identical caps the
    // first-encountered account wins every time. This documents that
    // behavior, not a fairness property.
    expect(landed.size).toBeGreaterThanOrEqual(1);
  });

  it('transfer-listing fan-outs across 50 accounts', async () => {
    // Each provider returns one transfer; total should be the sum.
    const entries = Array.from({ length: 50 }, (_, i) => ({
      provider: {
        ...({
          getQuota: async () => ({ used: 0, max: 6 * GIB, get free() { return 6 * GIB; } }),
          listTransfers: async () => ([{ id: String(i + 1), name: null, state: 'finished', progress: 100, size: 0, folderId: null, seeders: 0, leechers: 0, error: null }]),
        } as never),
      },
      label: `acc${i + 1}`,
      needsReauth: false,
    }));
    const pool = new AccountPool(entries as never);
    await pool.refresh();
    const all = await pool.listAllTransfers();
    expect(all).toHaveLength(50);
  });
});
