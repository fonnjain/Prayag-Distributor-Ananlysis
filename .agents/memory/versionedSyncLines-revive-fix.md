---
name: versionedSyncLines revive fix
description: INSERT blocked by superseded line_uid — once a row is tombstoned its line_uid stays in the table, silently blocking re-insertion. Fixed with pre-flight revive pass. Also: dedupeBySerialNo now uses 7-field key; lastGoodRowCountByMonth replaces DB-count comparison in both the revive guard and Guard 2.5; lineUidKey structural gap causes 9 persistent gap rows.
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
- Found as `superseded` → UPDATE back to `current` (`version_status`, `superseded_at=NULL`, `superseded_by=NULL`)
- Found as `current` → silently ignored (another row with same hash is already active — see structural gap below)
- Not found → INSERT as usual

New `VersionedSyncResult` field: `revived: number`.

## Revive guard + Guard 2.5 — last-good-read baseline (deployed)
Both the revive guard and tombstone Guard 2.5 compare against the LAST KNOWN-GOOD read for
that month, not the current DB row count.

- DB count comparison fires whenever the DB drifts above the sheet (e.g. accumulated revivals),
  which is exactly when tombstone needs to run — wrong signal.
- Last-good-read comparison fires only when the sheet actually returned fewer rows than last time —
  correct signal for a truncated read.

**Implementation:**
- `lastGoodRowCountByMonth: Map<string, number>` (key: `fy|monthLabel`) owned by `registerSync.ts`.
- Updated after each successful sync for months where incoming >= previous baseline.
- Passed to `versionedSyncLines` as 3rd param; threaded through to `tombstoneOrphans` as `lastGoodRowCount`.
- `versionedSyncLines` returns `incomingCountByFyMonth` (post-dedup) so the caller updates cleanly.
- First run: `lastGood = 0` for each month → revive always safe; Guard 2.5 falls back to `currentInScope`.

**July cleanup:** After the first new-code sync, baseline for Jul-26 = 8,025.
Next tick: incoming (8,025) >= lastGood (8,025) → tombstone proceeds → removes 3,651 excess rows
automatically. A genuine short read (incoming < 8,025) still halts.

## dedupeBySerialNo key change (deployed alongside)
Old key: `fy|monthLabel|serialNo` — collapsed rows with same serial but different natural key.
New key: `fy|monthLabel|serialNo|invoiceNo|code|color|qty` — only collapses true 7-field duplicates.

## Remaining 9 gap rows (3 May-26 + 6 Jun-26) — structural issue
These rows have a `line_uid` that is already held by a DIFFERENT CURRENT row (different `invoiceNo`
or `color`, same `fy|code|qty|amount|monthLabel|serialNo` hash).
Pre-flight finds the line_uid as `current` → row goes to neither revive nor trulyNew → silent drop.
The anchor check counts it in `sheetRows` but it never reaches `current`.

**Fix required:** include `invoiceNo` and `color` in `lineUidKey` in `normalize.ts`.
This is a breaking migration (all existing line_uids would change) — do it as a separate task with
a full re-ingestion of FY2026-27 data.

## Results after all fixes
| Month | Gap before | Gap after (stable) |
|-------|------------|-------------------|
| May-26 | 34 | 3 |
| Jun-26 | 29 | 6 |
| Jul-26 | +2,306 excess (guard halted) | will self-correct on next tick |
