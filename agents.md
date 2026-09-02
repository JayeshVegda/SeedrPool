# SeedrPool Agent Instructions

## Goal

Build a private self-hosted media platform that combines 8 Seedr accounts (52 GiB total) into one library and exposes it through Stremio.

Users:

* Jay = admin
* 2 friends = trusted users

End users should simply use:

> Stremio → Search/Browse → Play

They should never need to know which Seedr account contains a file.

## Rules

1. **Research before implementing external integrations.**
   Phase 0 research is complete and recorded in `RESEARCH.md`. Read it first —
   several findings contradict older assumptions, including which API to use. Use
   the Seedr **V1 password grant**; V2 refuses new authorizations.

2. **Use current technology.**
   Prefer modern TypeScript + Node LTS + pnpm. Verify versions first.

3. **Keep Seedr behind an abstraction.**
   Core code must use `StorageProvider`, not raw Seedr API calls.

4. **Keep the project simple.**
   Start as a modular monolith. No Kubernetes, Redis, Kafka, microservices, etc. unless research proves necessary.

5. **Never expose Seedr credentials.**
   Account passwords and tokens stay server-side and must never appear in logs,
   frontend code, Stremio manifests, error messages, or user responses. The
   credentials file lives outside the repo at mode 0600.

6. **The credentials file is append-only.**
   Account ids are positional — line 1 is `acc1`. Deleting or reordering a line
   renumbers every account below it, and the library index stores account ids.
   Append new accounts at the end.

   V1 tokens are a cache, not a fragile secret: the password grant is idempotent,
   tokens last ~30 days, and re-login is free. `TokenStore`'s atomic-write and
   single-writer machinery exists for the V2 provider, which is no longer used.

7. **Stremio is the primary frontend.**
   Do not build a custom media player. The admin page is for Jay only.

8. **All accounts behave as one pool.**
   Automatically select the best account for downloads and playback. Allocation
   optimizes for capacity; streaming concurrency is per signed URL, not per
   account, so it is not a placement constraint.

9. **Automatic storage management is required.**
   When space is insufficient, automatically remove low-value content according to the eviction policy.

10. **Friends can watch; Jay adds content.**
    Magnets are added manually through the admin page. There is no torrent
    discovery or indexer.

11. **Only movies and TV matter.**
    Use Seedr's `is_video` flag rather than matching file extensions.

12. **Duplicates should eventually be removed.**
    Prefer the best copy/release and reclaim unnecessary space. Seedr's SHA-1
    `hash` field identifies duplicates across accounts.

13. **Everything currently in every account must be indexed initially.**

14. **If research contradicts the current plan, stop and document the finding instead of blindly following the plan.**

15. Before completing work:

    * test
    * typecheck
    * review diff
    * update documentation
    * update `plan.md`

16. Do not claim something works without actually testing it.

## Working Style

At the beginning of a task:

1. Read `agents.md`
2. Read `plan.md`
3. Read `RESEARCH.md` — it records what is measured versus merely documented
4. Read relevant `ARCHITECTURE.md` sections
5. Check git status
6. Inspect existing code
7. Make the smallest correct change

Keep commits focused and conventional.

Do not rewrite working code unnecessarily.

