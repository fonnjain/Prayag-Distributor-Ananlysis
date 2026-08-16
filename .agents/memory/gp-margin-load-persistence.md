---
name: GP Margin load persistence
description: Why margin_fact is always empty in production and the fix applied.
---

## Root cause

The GP Margin load (POST /api/admin/margin/load) runs fire-and-forget in the Node.js process. The load takes ~15 minutes and is wrapped in a single Postgres transaction (BEGIN → DELETE → chunked INSERT → COMMIT). Any server restart (publish) kills the in-flight process, Postgres rolls back the transaction, and margin_fact stays empty. The in-memory `loadJob` variable also resets to `{ status: "idle" }` on restart, silently hiding the kill.

This repeated for every publish — users saw "GP Margin data not loaded yet" persistently.

## Fix (commit 64fc968)

- **migration 040**: `margin_load_job` singleton table (id=1 always) with status/started_at/finished_at/report/error_msg/segments columns.
- **gpMargin.ts**: `dbSetJob()` writes state to DB at every transition (running → done, running → error). `restoreMarginLoadJob()` export reads DB on startup — if status='running' the previous process was killed, so it marks it as 'error' with a clear message (the Postgres transaction was rolled back, margin_fact is intact but empty).
- **index.ts**: calls `restoreMarginLoadJob()` at startup alongside `cleanupOrphanedJobs()`.

**After this deploy**: status endpoint shows 'killed by restart (started TIMESTAMP)' instead of silently reverting to idle. User knows to retrigger.

## Load sequence (after fix deployed)

1. Publish with 64fc968 → migration 040 runs → margin_load_job row seeded
2. POST /api/admin/margin/load (full load, ~15 min) OR per-segment:
   `POST body { segments: ["CP"] }` → one segment at a time (~1-3 min each), far less kill risk.
3. Segments: CP, Garden Pipe, Hardware, PTMT, Plumbing, Sanitaryware, Sink (7 total)
4. **Do NOT publish during the load** — restart kills the in-flight transaction.

## Dev state

dev margin_fact: 32,179 rows, 7 segments, Apr-25 to Sep-25 only (partial load — FY24-25 and FY25-26 H2 missing; full load against production Drive will cover all available months).

## Relevant files

- `artifacts/api-server/src/routes/gpMargin.ts` — load route, dbSetJob, restoreMarginLoadJob
- `artifacts/api-server/src/index.ts` — startup call
- `lib/db/src/runMigrations.ts` — migration 040
