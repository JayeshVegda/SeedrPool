/**
 * Centralized health: one place that answers "is SeedrPool actually OK".
 *
 * `/healthz` used to be a hardcoded `'ok'`. That is a liveness probe — it
 * proves the process has an event loop, and nothing else. A dead database, a
 * pool where every account is offline, an indexer that has been failing for
 * a day: all of those served `200 ok`, because nothing was checked.
 *
 * This module is the readiness layer. It gathers one snapshot from every
 * subsystem that can silently degrade, and grades each one so the response
 * can say *what* is wrong rather than just that something is:
 *
 *   ok       working as expected
 *   warn     degraded but serving; the operator should look soon
 *   bad      not serving; the operator should look now
 *
 * Designed for two consumers: `/healthz` (the container healthcheck and any
 * uptime monitor — bad → non-200 so the alert fires) and the admin overview
 * (which renders the same checks as human-readable cards, so there is one
 * definition of "healthy" rather than two that drift).
 */

export type HealthStatus = 'ok' | 'warn' | 'bad';

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  /** Human-readable explanation when status is not ok. */
  detail: string | null;
}

export interface HealthReport {
  /** Worst status across all checks. */
  status: HealthStatus;
  checks: HealthCheck[];
}

/** Subsystems the health report can see, all optional so tests can pass fakes. */
export interface HealthSources {
  /** SQLite: a trivial query proves the handle is alive and not locked. */
  db: { ping(): void };
  pool: {
    /** All account statuses, from the pool's cache. */
    statuses(): Array<{ accountId: string; healthy: boolean; needsReauth: boolean; reason?: string }>;
  };
  indexer: {
    /**
     * Unix ms of the watcher's last completed poll — the heartbeat. Not the
     * indexer's last scan: a scan only runs when a transfer completes, so a
     * quiet-but-healthy pool would trip a staleness warning within minutes
     * of doing nothing wrong.
     */
    lastTickAt: number;
  };
  enricher: {
    /** Whether a TMDB key is configured at all. */
    readonly enabled: boolean;
  };
  store: {
    /** Titles the enricher has permanently failed to match. */
    givenUpTitlesCount(): number;
  };
}

/**
 * How stale a completed index may be before it counts as degraded.
 *
 * The scan itself runs every ~30 s via the transfer-watcher plus on demand,
 * so anything under 10 minutes is routine quiet. Past an hour, either the
 * watcher is dead or every account has been failing for an hour — both are
 * worth surfacing, neither is worth paging.
 */
const INDEX_STALE_WARN_MS = 10 * 60_000;
const INDEX_STALE_BAD_MS = 60 * 60_000;

/** Healthy accounts at or below this fraction of the pool is a warning. */
const POOL_MIN_HEALTHY_FRACTION = 0.25;

export function buildHealthReport(
  sources: HealthSources,
  now = Date.now(),
): HealthReport {
  const checks: HealthCheck[] = [];

  // --- Database ------------------------------------------------------
  try {
    sources.db.ping();
    checks.push({ name: 'database', status: 'ok', detail: null });
  } catch (err) {
    checks.push({
      name: 'database',
      status: 'bad',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Account pool ---------------------------------------------------
  const statuses = sources.pool.statuses();
  if (statuses.length === 0) {
    checks.push({
      name: 'pool',
      status: 'bad',
      detail: 'no accounts configured — the credentials file is empty or unreadable',
    });
  } else {
    const healthy = statuses.filter((s) => s.healthy);
    const offline = statuses.filter((s) => !s.healthy);
    if (offline.length === 0) {
      checks.push({ name: 'pool', status: 'ok', detail: null });
    } else {
      // A pool with no healthy account cannot stream anything, and a magnet
      // added in that state parks on nobody. Below the warning threshold it
      // is degraded-but-some-sources; at zero it is fully bad.
      const fraction = healthy.length / statuses.length;
      const status: HealthStatus = healthy.length === 0 ? 'bad' : fraction <= POOL_MIN_HEALTHY_FRACTION ? 'warn' : 'ok';
      // Name the offenders so the report is actionable on its own.
      const named = offline
        .map((s) => `${s.accountId}${s.reason !== undefined ? ` (${s.reason})` : ''}`)
        .join(', ');
      checks.push({
        name: 'pool',
        status,
        detail: `${healthy.length}/${statuses.length} healthy — offline: ${named}`,
      });
    }
  }

  // --- Indexer freshness -----------------------------------------------
  // The watcher polls every 30 s; the thresholds account for one slow poll
  // (8 accounts × the rate-limiter gap) plus slack.
  const lastTickAt = sources.indexer.lastTickAt;
  if (lastTickAt === 0) {
    checks.push({
      name: 'indexer',
      status: 'warn',
      detail: 'the transfer watcher has not completed a poll yet — first pass runs within 30 s of boot',
    });
  } else {
    const age = now - lastTickAt;
    if (age > INDEX_STALE_BAD_MS) {
      checks.push({
        name: 'indexer',
        status: 'bad',
        detail: `last completed poll was ${formatDuration(age)} ago — the watcher has died or every account is failing`,
      });
    } else if (age > INDEX_STALE_WARN_MS) {
      checks.push({
        name: 'indexer',
        status: 'warn',
        detail: `last completed poll was ${formatDuration(age)} ago`,
      });
    } else {
      checks.push({ name: 'indexer', status: 'ok', detail: null });
    }
  }

  // --- Metadata enricher ------------------------------------------------
  if (!sources.enricher.enabled) {
    checks.push({
      name: 'enricher',
      status: 'warn',
      detail: 'no TMDB key configured — new titles will not get IMDb ids and stay invisible to Stremio',
    });
  } else {
    const givenUp = sources.store.givenUpTitlesCount();
    checks.push({
      name: 'enricher',
      status: givenUp > 0 ? 'warn' : 'ok',
      detail:
        givenUp > 0
          ? `${givenUp} title${givenUp === 1 ? '' : 's'} failed metadata lookup ${givenUp === 1 ? '' : 's'}and will not be retried — use "re-fetch" on the library row`
          : null,
    });
  }

  const worst = checks.some((c) => c.status === 'bad')
    ? 'bad'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';

  return { status: worst, checks };
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
