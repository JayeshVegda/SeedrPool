# Contributing

Thanks for taking a look. SeedrPool is a single-operator tool that does
one thing (N Seedr accounts behind one Stremio addon) and the bug surface
is small enough that the project isn't actively soliciting feature
contributions. The seedr.zayu.dev deploy runs 8 accounts; the
architecture itself supports any N.

## Ground rules

* **No torrent search, no indexing of public trackers, no scraping.**
  The operator who built this deliberately does not want a torrent
  search engine. Issues and PRs along those lines will be closed.
* **Match the existing style.** The project has a deliberate "one
  process, one library" architecture. PRs that introduce a microservice
  boundary, a queue, or a database other than sqlite will need a much
  stronger justification than usual.
* **No new runtime dependencies.** `package.json` has zero `dependencies`
  today. Everything uses `node:` built-ins. If your change needs a
  package, prefer an existing devDep, and be prepared to explain why
  the standard library is not enough.

## Pull request flow

1. Open an issue first if the change is non-trivial. Bug fixes and
   small ergonomic tweaks are fine without an issue.
2. Branch from `main`. Keep the diff focused.
3. Run `npm run typecheck && npm test` before pushing. CI runs the same
   on PR open.
4. Update `CHANGELOG.md` under a "Unreleased" section.
5. Update `docs/` if the change affects the operator-visible surface or
   the Stremio addon contract.

## Code style

* TypeScript strict mode is on. `noUncheckedIndexedAccess` is on; the
  codebase uses explicit `?? '—'` defaults rather than `!` non-null
  assertions in template literals.
* The admin console uses an internal `html` tagged template (in
  `src/admin/html.ts`) that escapes every interpolated value by default.
  Use `raw(...)` only for pre-built HTML. Read the comments at the top
  of that file before touching it.
* The `Layout` is intentionally coarse. CSS is in one block in
  `html.ts`. The operator console is one screen; do not introduce a
  build step to split it.

## Testing

The 246 tests across 15 files are organized by `src/` subdir:

```text
tests/addon/        Stremio addon behavior
tests/admin/        operator console behavior
tests/core/         pool, watcher, router, credentials
tests/library/      indexer, store, enricher, parser, tmdb
tests/providers/    Seedr V1 / V2 API contracts
```

Coverage is not enforced as a hard gate. Add a test for any new
behavioral change.

## What the operator is willing to maintain

* Multi-account aggregation (the whole point).
* IMDb id resolution via TMDB.
* HLS fallback when Seedr's CDN 404s.
* A small operator UI for triage.

The operator is **not** looking for: a web frontend rewrite, a
multi-tenant SaaS, real-time chat, ML-based recommendation, a mobile
app, or anything that adds a server-side runtime dependency.
