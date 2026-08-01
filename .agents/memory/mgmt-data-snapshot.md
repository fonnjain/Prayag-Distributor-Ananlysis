---
name: mgmt/data cold-start DB snapshot
description: How GET /api/mgmt/data avoids the ~20s cold-start Sheets wait via a persisted payload snapshot.
---

`mgmt_data_snapshot` table stores the last successful `/api/mgmt/data` payload per (fy, month_from, month_to), upserted after every live build.

- Cold in-process cache → serve snapshot instantly with `meta.snapshotSavedAt` (unix ms) + `meta.refreshing: true`, then `buildAndCacheMgmtData` runs in background (in-flight deduped per cacheKey) and swaps the fresh payload into `_mgmtDataCache`.
- Simulated-clock requests (`_simulatedNow`) bypass snapshot/cache entirely and never persist.
- `invalidateMgmtDataCache(fy?)` also deletes the DB snapshots — otherwise a post-xlsx-upload reload would re-serve stale target columns.
- Table is created by runMigrations id `004_mgmt_data_snapshot` (CREATE TABLE IF NOT EXISTS) so production gets it without drizzle-kit push; note `drizzle-kit push` is interactive-only in this shell (TTY prompt) — use runMigrations/psql for new tables.

**Why:** autoscale prod cold-starts made the first visitor wait ~21s on the STATE HEAD DASHBOARD full-sheet read; warm cache was ~4ms.

**How to apply:** any new heavy Sheets-derived route can copy this pattern: build fn pure of caches, buildAndCache wrapper (cache + fire-and-forget snapshot upsert), snapshot-first route path with freshness metadata.

## Generalised layer (Aug 2026)
`artifacts/api-server/src/lib/payloadSnapshot.ts` exposes `serveWithSnapshot({key, ttlMs, build, log})` backed by the generic `route_payload_snapshot` table (key text PK, payload jsonb, saved_at; migration id `005_route_payload_snapshot`). It injects `meta.snapshotSavedAt` + `meta.refreshing` into whatever payload shape the route returns and dedupes in-flight builds per key. Build fns throw `SnapshotHttpError(status, body)` for non-200s so errors are never snapshotted. Adopted by `/api/company-reports` (key `company-reports|<fy>`, skipped when `asOf` param present) and `/api/warnings` (key `warnings|<fy>|<statehead lc>`). Frontend consumers (CompanyReports, WarningSystem, CombinedPerformanceDashboard's monthlyPrimary fetch) reuse SnapshotBanner + useSnapshotRefresh. Note: warnings cold background rebuild takes ~35-55s (deep-dive Sheets fan-out), well within the hook's ~2-min poll budget.
