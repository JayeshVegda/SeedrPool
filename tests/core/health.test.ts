import { describe, it, expect } from 'vitest';
import { buildHealthReport, type HealthSources } from '../../src/core/health.ts';

/**
 * /healthz used to be a hardcoded string. These tests pin the actual grading
 * logic: what is ok, what is a warning, and what flips the endpoint to 503 —
 * which is what an uptime monitor or `docker compose ps` sees.
 */

function sources(over: Partial<Parameters<typeof buildHealthReport>[0]> = {}): HealthSources {
  return {
    db: { ping: () => {} },
    pool: { statuses: () => [healthy('acc1')] },
    indexer: { lastTickAt: Date.now() },
    enricher: { enabled: true },
    store: { givenUpTitlesCount: () => 0 },
    ...over,
  };
}

function healthy(id: string) {
  return { accountId: id, healthy: true, needsReauth: false };
}
function offline(id: string, reason?: string) {
  return { accountId: id, healthy: false, needsReauth: false, reason };
}

describe('buildHealthReport', () => {
  it('grades a fully working system as ok', () => {
    const r = buildHealthReport(sources());
    expect(r.status).toBe('ok');
    expect(r.checks.map((c) => c.status)).not.toContain('warn');
    expect(r.checks.map((c) => c.status)).not.toContain('bad');
  });

  it('covers database, pool, indexer, and enricher by name', () => {
    const r = buildHealthReport(sources());
    expect(r.checks.map((c) => c.name).sort()).toEqual([
      'database',
      'enricher',
      'indexer',
      'pool',
    ]);
  });

  // --- database ------------------------------------------------------

  it('a dead database is bad, and the report says why', () => {
    const r = buildHealthReport(
      sources({ db: { ping: () => { throw new Error('SQLITE_BUSY: database is locked'); } } }),
    );
    expect(r.status).toBe('bad');
    const db = r.checks.find((c) => c.name === 'database');
    expect(db?.status).toBe('bad');
    expect(db?.detail).toContain('SQLITE_BUSY');
  });

  // --- pool ----------------------------------------------------------

  it('names the offline accounts so the report is actionable on its own', () => {
    const r = buildHealthReport(
      sources({ pool: { statuses: () => [healthy('acc1'), offline('acc3', 'Bad password'), offline('acc7')] } }),
    );
    const pool = r.checks.find((c) => c.name === 'pool')!;
    expect(pool.status).not.toBe('bad');
    expect(pool.detail).toContain('acc3');
    expect(pool.detail).toContain('Bad password');
    expect(pool.detail).toContain('acc7');
  });

  it('every account offline is bad, not warn', () => {
    const r = buildHealthReport(
      sources({ pool: { statuses: () => [offline('acc1'), offline('acc2')] } }),
    );
    expect(r.status).toBe('bad');
    expect(r.checks.find((c) => c.name === 'pool')?.status).toBe('bad');
  });

  it('a pool at a healthy minority is degraded but serving', () => {
    const statuses = () =>
      [healthy('acc1'), offline('acc2'), offline('acc3'), offline('acc4')];
    const r = buildHealthReport(sources({ pool: { statuses } }));
    expect(r.checks.find((c) => c.name === 'pool')?.status).toBe('warn');
    expect(r.status).toBe('warn');
  });

  it('no accounts configured is bad with a pointer at the credentials file', () => {
    const r = buildHealthReport(sources({ pool: { statuses: () => [] } }));
    const pool = r.checks.find((c) => c.name === 'pool')!;
    expect(pool.status).toBe('bad');
    expect(pool.detail).toMatch(/credentials file/);
  });

  // --- indexer ---------------------------------------------------------

  it('a fresh watcher poll is ok', () => {
    const r = buildHealthReport(sources({ indexer: { lastTickAt: Date.now() - 60_000 } }));
    expect(r.checks.find((c) => c.name === 'indexer')?.status).toBe('ok');
  });

  it('a recent poll is ok; quiet periods are not alarms', () => {
    const r = buildHealthReport(sources({ indexer: { lastTickAt: Date.now() - 9 * 60_000 } }));
    expect(r.checks.find((c) => c.name === 'indexer')?.status).toBe('ok');
  });

  it('a poll silent for over 10 minutes is a warning with an age', () => {
    const r = buildHealthReport(sources({ indexer: { lastTickAt: Date.now() - 15 * 60_000 } }));
    const idx = r.checks.find((c) => c.name === 'indexer')!;
    expect(idx.status).toBe('warn');
    expect(idx.detail).toMatch(/15 minutes ago/);
  });

  it('a poll silent for over an hour is bad — the watcher likely died', () => {
    const r = buildHealthReport(sources({ indexer: { lastTickAt: Date.now() - 2 * 60 * 60_000 } }));
    expect(r.checks.find((c) => c.name === 'indexer')?.status).toBe('bad');
    expect(r.status).toBe('bad');
  });

  it('a never-completed poll is a warning, not bad — first boot is normal', () => {
    const r = buildHealthReport(sources({ indexer: { lastTickAt: 0 } }));
    const idx = r.checks.find((c) => c.name === 'indexer')!;
    expect(idx.status).toBe('warn');
    expect(idx.detail).toMatch(/has not completed a poll/);
  });

  // --- enricher ---------------------------------------------------------

  it('no TMDB key is a warning that explains the Stremio consequence', () => {
    const r = buildHealthReport(sources({ enricher: { enabled: false } }));
    const en = r.checks.find((c) => c.name === 'enricher')!;
    expect(en.status).toBe('warn');
    expect(en.detail).toMatch(/invisible to Stremio/);
  });

  it('given-up titles surface as a warning with the recovery path', () => {
    const r = buildHealthReport(
      sources({ store: { givenUpTitlesCount: () => 4 } }),
    );
    const en = r.checks.find((c) => c.name === 'enricher')!;
    expect(en.status).toBe('warn');
    expect(en.detail).toMatch(/4 titles/);
    expect(en.detail).toMatch(/re-fetch/);
  });

  // --- aggregation -------------------------------------------------------

  it('one bad check makes the whole report bad', () => {
    const r = buildHealthReport(
      sources({ db: { ping: () => { throw new Error('closed'); } } }),
    );
    expect(r.status).toBe('bad');
  });

  it('warn without bad is warn, so a degrading system is visible first', () => {
    const r = buildHealthReport(
      sources({
        enricher: { enabled: false },
        indexer: { lastTickAt: 0 },
      }),
    );
    expect(r.status).toBe('warn');
  });
});
