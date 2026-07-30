---
name: versionedSyncLines revive fix
description: INSERT blocked by superseded line_uid — once a row is tombstoned its line_uid stays in the table, silently blocking re-insertion. Fixed with pre-flight revive pass. Also covers: dedupeBySerialNo 7-field key; persisted last-good-read baseline (ingest_run.rows_per_month); null/undefined semantics for Guard 2.5; 9 persistent structural gap rows.
---

## The problem
`versionedSyncLines` used `INSERT … ON CONFLICT DO NOTHING` on `line_uid`.
A tombstoned row's `line_uid` stays in `sale_line_all` as `version_status='superseded'`.
When the sheet brings the row back, `toInsert` puts it through INSERT → conflict → silently skipped.
No error, 0 rows inserted, gap persists indefinitely.

**Why:** `line_uid` is a SHA1 hash of `fy|code|qty|amount|monthLabel|serialNo` — it is a content hash
that does not include `invoiceNo` or `color`. After tombstone the row's hash still occupies the table.

## The fix (deployed)
Before the INSERT batch, a pre-flight SELECT checks which `line_uid`s already exist.
- Found as `superseded` → UPDATE back to `current`
- Found as `current` → silently ignored (another row with same hash is already active — see structural gap)
- Not found → INSERT as usual

New `VersionedSyncResult` field: `revived: number`.

## Baseline persistence: ingest_run.rows_per_month (deployed)
Migration `002_ingest_run_rows_per_month` adds `rows_per_month jsonb` to `ingest_run`.
After each successful register sync the per-month post-dedup row counts are written there:
`{"Apr-26": 5542, "Jul-26": 8025, "Jun-26": 12868, "May-26": 11812}`.

On boot, `loadBaselineFromDb()` in `registerSync.ts` queries:
```sql
SELECT DISTINCT ON (fy) fy, rows_per_month
FROM ingest_run
WHERE source = 'register_sheets_sync'
  AND status IN ('ok', 'warn')
  AND rows_per_month IS NOT NULL
ORDER BY fy, started_at DESC NULLS LAST
```
Populates `lastGoodRowCountByMonth` (`Map<"fy|month", number>`) before the first sync runs.
If the DB load fails it is non-fatal: map stays empty → guards halt one cycle → baseline established.

## Revive guard + Guard 2.5 semantics (deployed)
Both guards compare against the last known-good read, not the current DB row count.
DB-count comparison fires whenever the DB drifts above the sheet (e.g. accumulated revivals) —
that is exactly when tombstone needs to run, so it is the wrong signal.

**Three-way `lastGoodRowCount` on `tombstoneOrphans` opts:**
- `number`    — baseline known; incoming must be >= this or tombstone halts.
- `null`      — sync pipeline, no baseline yet; halt as unknown. Zero baseline = unknown = halt.
                A missed cycle costs nothing; tombstoning an unvalidated read loses the month.
- `undefined` — manual/ad-hoc POST call; fall back to current DB count (original Guard 2.5).

`null` vs `undefined` distinction matters: `undefined` is reserved for callers that
intentionally have no baseline context (manual admin routes). The sync pipeline always passes
`null` when the map has no entry (`?? null`).

**Revive guard:** `lastGood === undefined` (map has no entry) → not safe to revive. Revive only
proceeds when baseline is known (`lastGood !== undefined`) AND `incoming >= lastGood`.

## First boot after deploy (verified Jul 30 2026)
- `loaded: 0` (no prior run had `rows_per_month`).
- All 4 months: "no baseline established — halting tombstone." `revived: 0, tombstoned: 0`.
- Run 39 written: `rows_per_month = {"Apr-26":5542,"Jul-26":8025,"Jun-26":12868,"May-26":11812}`.
- Next boot: baseline loads → July tombstone proceeds (incoming 8,025 >= lastGood 8,025) → clears 3,651 excess rows.

## dedupeBySerialNo key (deployed)
Old: `fy|monthLabel|serialNo` — collapsed rows with same serial but different natural key.
New: `fy|monthLabel|serialNo|invoiceNo|code|color|qty` — only collapses true 7-field duplicates.

## Remaining 9 gap rows (3 May-26 + 6 Jun-26) — structural
`lineUidKey` hashes `fy|code|qty|amount|monthLabel|serialNo` (no `invoiceNo`, no `color`).
Two rows with different identities can share a `line_uid`. If the "other" row is already `current`,
pre-flight finds it as `current` → skipped from both revive and insert → silent drop.
Fix: add `invoiceNo` + `color` to `lineUidKey` in `normalize.ts` + full FY2026-27 re-ingestion.
Not yet done — breaking migration, separate task.
