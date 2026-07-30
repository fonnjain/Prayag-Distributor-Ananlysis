---
name: versionedSyncLines revive fix
description: INSERT blocked by superseded line_uid — once a row is tombstoned its line_uid stays in the table, silently blocking re-insertion. Fixed with pre-flight revive pass. Also: dedupeBySerialNo now uses 7-field key; lineUidKey structural gap causes 9 persistent gap rows.
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

## Revive guard (symmetric with Guard 2.5)
If a month's incoming row count < its current DB count, that month is excluded from the revive pass
(same logic as the tombstone Guard 2.5 "suspected-read-failure" halt).
Implemented via `safeToReviveMonths` set built from `currentCountByMonth` vs `incomingCountByMonth`.

**Why this matters:** Without the guard, the July revive tick incorrectly revived 1,345 rows from
previous tombstone cycles before the guard was in place. July went 10,331→11,676 current rows.
The guard now blocks July (incoming 8,025 < current 11,675). Manual cleanup of July still needed
(run tombstone-orphans with raised blast-radius once the July sheet read stabilises).

## dedupeBySerialNo key change (deployed alongside)
Old key: `fy|monthLabel|serialNo` — collapsed rows with same serial but different natural key.
New key: `fy|monthLabel|serialNo|invoiceNo|code|color|qty` — only collapses true 7-field duplicates.
**Effect on gap:** zero — the 16+12 natural-key duplicates the user measured share the same serial AND
natural key (true 7-field duplicates), so the fix had no visible impact on insertion count.

## Remaining 9 gap rows (3 May-26 + 6 Jun-26) — structural issue
These rows have a `line_uid` that is already held by a DIFFERENT CURRENT row (different `invoiceNo`
or `color`, same `fy|code|qty|amount|monthLabel|serialNo` hash).
Pre-flight finds the line_uid as `current` → row goes to neither revive nor trulyNew → silent drop.
The anchor check counts it in `sheetRows` but it never reaches `current`.

**Fix required:** include `invoiceNo` and `color` in `lineUidKey` in `normalize.ts`.
This is a breaking migration (all existing line_uids would change) — do it as a separate task with
a full re-ingestion of FY2026-27 data.

## Results after fixes
| Month | Gap before | Gap after (stable) |
|-------|------------|-------------------|
| May-26 | 34 | 3 |
| Jun-26 | 29 | 6 |
| Jul-26 | +2,306 excess (guard halted) | +3,650 excess (needs cleanup) |
