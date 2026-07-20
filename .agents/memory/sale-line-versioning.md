---
name: sale_line versioning pipeline
description: How duplicate sale_line rows (from rate edits in SALE SHEET) are prevented and cleaned up via version_status column + versionedSyncLines.
---

## The problem
When rates are edited in the SALE SHEET, the rate cell value changes. The old `line_uid` hash included amount (which is rate×qty). Hash change → new line_uid → new row inserted on next sync. Old row stays (ON CONFLICT DO NOTHING). Result: 2-3 current rows per identity.

## Schema additions (added Jul 2026)
- `color` TEXT — product colour from sheet (part of identity for dedupe)
- `version_status` TEXT DEFAULT 'current' — 'current' or 'superseded'
- `superseded_at` TIMESTAMPTZ — when this row was superseded
- `superseded_by` TEXT — line_uid of the row that replaced this one
- View `sale_line_current` = `SELECT * FROM sale_line WHERE version_status = 'current'`
- Index `sale_line_version_idx` on (fy, version_status)
- Index `sale_line_identity_idx` on (fy, invoice_no, code, COALESCE(color,''), qty, month_label)

## Identity key (stable across rate edits)
`invoice_no | code | COALESCE(color,'') | qty | month_label`
Rate, amount, and serial_no are MUTABLE fields — not in identity key.

## Analytics filter rule
ALL Drizzle queries use `eq(saleLines.versionStatus, "current")`.
ALL raw SQL queries use `FROM sale_line_current` (the view) instead of `FROM sale_line`.
Exception: `hasRows()` in registerSync.ts intentionally queries all rows to check if any sync has been done.

## Sync functions
- `versionedSyncLines(lines, confirmedAt)` — for OPEN FY (live Sheets sync). Loads current rows, builds identity map, compares incoming: touch / supersede+insert / new insert. Called from `doSync` in registerSync.ts.
- `insertSaleLineBatches(lines)` — for HISTORICAL FYs (xlsx backfill only). Uses ON CONFLICT DO NOTHING. NOT used for open FY sync.

## Tombstone pass (orphan rows — deleted from sheet)

versionedSyncLines now runs a tombstone pass after the main loop. For each month in the batch, any current DB row whose identity is NOT in the incoming sheet batch gets superseded. The 10% blast-radius guard prevents accidental mass-supersession.

All five guards (scope, zero-row abort, blast-radius halt, dry-run, logging) live in `tombstoneOrphans()` in ingest.ts. The blast-radius guard ALWAYS reports candidates (for dry-run review) but only BLOCKS application.

One-off endpoint: `POST /api/registers/:fy/tombstone-orphans?month=X&dryRun=true` — reads the live sheet, finds orphans, returns count/amount/20 samples. Pass `blastRadiusLimitPct=30&dryRun=false` to apply after review and approval.

## One-time remediation endpoints
- `POST /api/registers/:fy/backfill-color?dryRun=true` — stamps color column from live sheet using (invoice_no, serial_no) as match key. Run first.
- `POST /api/registers/:fy/reconcile-versions?dryRun=true` — marks duplicate current rows as superseded. Winner = latest ingested_at within each identity group. Run after backfill-color.
- `GET /api/registers/:fy/version-stats` — returns currentRows, supersededRows, currentAmount, reconciled flag.

## Deployment sequence (done once per affected FY)
1. POST /registers/2026-27/backfill-color?dryRun=true (review counts)
2. POST /registers/2026-27/backfill-color (apply)
3. POST /registers/2026-27/reconcile-versions?dryRun=true (verify amountBefore ≈ amountAfter)
4. POST /registers/2026-27/reconcile-versions (apply)

**Why:** If amountBefore !== amountAfter in the dry run, the superseded rows had different amounts from their winners. This is expected and correct when rates were actually corrected in the sheet — the winner (latest ingested_at) carries the correct current rate.

## FY2026-27 reconcile result (Jul 2026)
- 1,036 rows superseded by reconcile-versions
- Jul-26: 1,008 superseded (most), amountAfter dropped ₹1.38 Cr (rate corrections)
- Q1 total after: ₹73.06 Cr (baseline ₹73.09 Cr, 0.03% variance — within 1% tolerance)
- Subsequent startup sync using versionedSyncLines superseded another 899 rows from latest sheet rate updates — working as designed.
