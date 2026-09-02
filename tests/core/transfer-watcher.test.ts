import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransferWatcher } from '../../src/core/transfer-watcher.ts';
import { LibraryStore } from '../../src/library/store.ts';
import { Indexer } from '../../src/library/indexer.ts';
import type {
  AccountPool,
} from '../../src/core/account-pool.ts';
import type { Transfer } from '../../src/core/types.ts';
import type { StorageProvider } from '../../src/core/types.ts';

class FakeProvider {
  readonly accountId: string;
  transfers: Transfer[] = [];
  listTransfersCalls = 0;
  failNext = false;

  constructor(id: string) {
    this.accountId = id;
  }

  async listTransfers(): Promise<Transfer[]> {
    this.listTransfersCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('transient');
    }
    return this.transfers;
  }

  // Surface the rest of StorageProvider so the type is satisfied.
  async getQuota() {
    return { used: 0, max: 0, get free() { return 0; } };
  }
  async listFolder() { return { folders: [], files: [] }; }
  async addMagnet() { throw new Error('not used'); }
  async getPlaybackUrl() { return { url: '', filename: '', expiresAt: null, kind: 'direct' as const }; }
  async deleteFile() {}
  async deleteFolder() {}
  async deleteTransfer() {}
  async healthCheck() { return { healthy: true }; }
}

function buildPool(providers: StorageProvider[]): AccountPool {
  return {
    capacity: () => ({ used: 0, max: 0, free: 0, healthyAccounts: providers.length, totalAccounts: providers.length }),
    healthyProviders: () => providers,
    refresh: async () => [],
    markCdnBroken: () => {},
    markCdnHealthy: () => {},
  } as unknown as AccountPool;
}

function transfer(id: string): Transfer {
  return {
    id,
    name: null,
    state: 'running',
    progress: 0,
    size: 0,
    folderId: null,
    seeders: 1,
    leechers: 0,
    error: null,
  };
}

describe('TransferWatcher', () => {
  let store: LibraryStore;
  let indexer: Indexer;
  let acc1: FakeProvider;
  let acc2: FakeProvider;
  let watcher: TransferWatcher;
  let scanAccount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new LibraryStore(':memory:');
    acc1 = new FakeProvider('acc1');
    acc2 = new FakeProvider('acc2');
    scanAccount = vi.fn().mockResolvedValue({
      accountId: 'acc1', videos: 0, subtitles: 0, pruned: 0,
    });
    // Wrap the real indexer with a spy so we can assert scanAccount was called.
    indexer = new Indexer(store, () => buildPool([acc1, acc2]));
    vi.spyOn(indexer, 'scanAccount').mockImplementation(scanAccount);
    watcher = new TransferWatcher(() => buildPool([acc1, acc2]), indexer);
  });

  it('does not reindex on the first tick (no prior state to compare to)', async () => {
    acc1.transfers = [transfer('A'), transfer('B')];
    await watcher.tick();
    expect(scanAccount).not.toHaveBeenCalled();
  });

  it('reindexes when a transfer disappears from the list', async () => {
    acc1.transfers = [transfer('A'), transfer('B')];
    await watcher.tick();
    scanAccount.mockClear();

    // 'A' finished, 'B' still going.
    acc1.transfers = [transfer('B')];
    await watcher.tick();
    expect(scanAccount).toHaveBeenCalledTimes(1);
    expect(scanAccount.mock.calls[0]?.[0]).toBe(acc1);
  });

  it('does not reindex for newly-appearing transfers', async () => {
    acc1.transfers = [];
    await watcher.tick();
    scanAccount.mockClear();

    // Brand new transfer id.
    acc1.transfers = [transfer('NEW')];
    await watcher.tick();
    expect(scanAccount).not.toHaveBeenCalled();
  });

  it('handles multiple accounts independently', async () => {
    acc1.transfers = [transfer('A')];
    acc2.transfers = [transfer('X')];
    await watcher.tick();
    scanAccount.mockClear();

    acc1.transfers = [];
    acc2.transfers = [transfer('X'), transfer('Y')];
    await watcher.tick();
    // Only acc1 had a finished transfer.
    expect(scanAccount).toHaveBeenCalledTimes(1);
    expect(scanAccount.mock.calls[0]?.[0]).toBe(acc1);
  });

  it('skips an account whose listTransfers throws, then retries later', async () => {
    acc1.transfers = [transfer('A')];
    acc2.transfers = [];
    await watcher.tick();
    scanAccount.mockClear();

    // acc1 errors; acc2 is unaffected.
    acc1.failNext = true;
    acc1.transfers = [];
    acc2.transfers = [];
    await watcher.tick();
    expect(scanAccount).not.toHaveBeenCalled();

    // Recovery: listTransfers succeeds on the next tick.
    acc1.transfers = [];
    await watcher.tick();
    expect(scanAccount).not.toHaveBeenCalled();
  });

  it('start/stop are idempotent', () => {
    watcher.start();
    watcher.start();
    expect(() => watcher.stop()).not.toThrow();
    watcher.stop();
  });

  it('reports whether any transfer is being tracked', async () => {
    expect(watcher.tracking).toBe(false);
    acc1.transfers = [transfer('A')];
    await watcher.tick();
    expect(watcher.tracking).toBe(true);
    acc1.transfers = [];
    await watcher.tick();
    expect(watcher.tracking).toBe(false);
  });

  it('fires the onCompletion hook after a per-account reindex', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    watcher.setOnCompletion(hook, { tick: hook } as never);
    acc1.transfers = [transfer('A')];
    await watcher.tick();
    scanAccount.mockClear();
    hook.mockClear();

    acc1.transfers = [];
    await watcher.tick();
    // The reindex happens; the hook is awaited before this assertion.
    expect(scanAccount).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not fire the hook when no transfer completed', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    watcher.setOnCompletion(hook, { tick: hook } as never);
    acc1.transfers = [];
    acc2.transfers = [transfer('X')];
    await watcher.tick();
    expect(hook).not.toHaveBeenCalled();
  });

  it('can detach the onCompletion hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    watcher.setOnCompletion(hook, { tick: hook } as never);
    watcher.setOnCompletion(null, null);
    acc1.transfers = [transfer('A')];
    await watcher.tick();
    acc1.transfers = [];
    await watcher.tick();
    expect(hook).not.toHaveBeenCalled();
  });
});
