---
name: stateDashboard closed-FY cache freeze
description: How closed-FY cache permanence works in stateDashboard.ts and why the FY2025-26 register Sheets gap cannot be closed via the backfill route.
---

## Closed-FY cache freeze (stateDashboard.ts)

`currentFy()` derives today's FY (Apr boundary). `isClosedFy(fy)` returns true when `fyStartYear(fy) < fyStartYear(currentFy())`.

Both `getCachedStateDashboard` and `loadStateDashboard` skip the 15-min TTL for closed FYs — the first Sheets read is cached for the process lifetime. This prevents FY2025-26 figures from drifting on every 15-min expiry.

**Why:** Without this, the STATE HEAD DASHBOARD for FY2025-26 (a closed year whose sheet may still be edited) was re-read every 15 minutes, producing a fluctuating total that differed from the DB anchor.

**How to apply:** Any FY whose start year < current FY start year gets permanent cache. If a closed FY figure must be force-refreshed, call `invalidateStateDashboardCache(fy)` and trigger a fresh load — the new value will then be held permanently again.

## YTD achievement numerator/denominator symmetry

`ytdSalesSum` must accumulate for ALL members (including `isLeft`). The denominator (`ytdPlanSum`) already covers all members. Any guard like `if (!m.isLeft) ytdSalesSum += ...` produces an asymmetric ratio that over-states achievement.

**Why:** Left-section members spent part of the FY contributing real sales. Their plan was in the denominator; excluding their sales from the numerator deflated the denominator share of the achievement ratio.

## FY2025-26 sale_line register gap (1,290 rows) — root cause confirmed

All 144,367 FY2025-26 rows in `sale_line` have `source = 'xlsx_backfill'`. The Sheets register at `1Xzq-gmB6K7iuMcE6gb-O7OpvGgSDU33DzEVyK60LK6E` scans 148,022 rows (all 12 monthly tabs) but rejects every one: `skippedNotRow=148022`, `skippedWrongFy=0`.

**Root cause: spreadsheet header/data column-layout mismatch.**

The Sheets register's header row was updated to insert two columns (ITEMCODE at index 6, OLDERPCODE at index 7) that are **empty in every data row**. The actual item code sits at index 8 (labeled "ITEMNAME" in the new header). The xlsx backfill pre-dated this restructuring — in the xlsx the code was at index 6 under the original header.

Diagnostic: `invalidSample[0] = "[missing item code] 1, 45748, "400001", "DELHI", "KAKKAR TRADERS", "", "", "341", "CORRUGATED PIPE INLET..."`.

`mapRegisterColumns` returns `code:6` from ITEMCODE header, but `values[6] = ""` → `parseRegisterRow` → `kind:"invalid", reason:"missing item code"` for all 148,022 rows.

**Recovery:** Requires the original FY2025-26 register xlsx file:
```
pnpm --filter @workspace/api-server run backfill --file <register-2025-26.xlsx> --fy 2025-26
```
The Sheets backfill path for FY2025-26 is permanently broken unless the spreadsheet owner populates the ITEMCODE column with the correct data.

## secondary_dashboard_snapshot DB table

DB snapshots verified working: FY2026-27 snaps (~52 KB) saved after each `loadStateDashboardUncached` call. Future cold-start loads for closed FYs read from `secondary_dashboard_snapshot` (latest row by `saved_at`) instead of re-hitting the STATE HEAD DASHBOARD Sheets file.

FY2025-26 secondary snapshot confirmed in DB as of Jul 20 2026: 216 members, plan ₹379.75 Cr, salesReceived ₹240.14 Cr, ytdAchievement 68.1%. This FY is now frozen — restarts use DB, never Sheets.

## Simulation isolation (skipPersist=true)

`loadStateDashboardUncached(fy, nowMs, skipPersist=false)` has a third param. When called via `loadStateDashboard(fy, nowMs)` with an explicit `nowMs` (simulation/testing path), `skipPersist=true` is passed so the simulated result never writes to `_cache` or `secondary_dashboard_snapshots`. Without this, a `?_simulatedNow=2026-08-01` request would overwrite the live cache with an arrears-guarded result and poison all subsequent browser views until the TTL expired.

**How to apply:** Always pass `skipPersist=true` from any caller that supplies a non-default `nowMs`. Production code paths (no `nowMs`) use the default `skipPersist=false`.
