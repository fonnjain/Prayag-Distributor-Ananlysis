---
name: versionedSyncLines revive fix + lineUidKey convergence
description: lineUidKey must include invoiceNo+color; historical key change + re-ingest contract
---

## Rule — lineUidKey must include invoiceNo and color

`lineUidKey` (normalize.ts) hashes `(fy, invoiceNo, code, color, qty, amount, monthLabel, serialNo)`.

Without invoiceNo and color, two rows on different invoices with the same SKU/qty/amount collide at occurrence=0. The revive pre-flight resurrects them (lineUid matches), but tombstoneOrphans correctly finds no identity match and re-tombstones. The cycle repeats every sync tick indefinitely.

**Why invoiceNo was excluded (historical):** FY2023-24 through 2025-26 were ingested from workbooks where one file had INVOICENO and another did not. Including invoiceNo in the key would have prevented cross-file dedup (the spec required those blocks to collapse). Those FYs were ingested with the old key and remain unchanged in the DB.

**How to apply:**
- FY2026-27 onwards: new key is active, sync converges cleanly.
- Any future re-ingest of FY ≤ 2025-26 MUST be a full clear-and-reload (old line_uids are invalidated by the key change).
- The DB delete guard (`allowDelete`) must be used: `SET LOCAL app.allow_delete = 'confirmed'` in the same transaction, or call `allowDelete()` from application code.

## Boot / baseline persistence

After clearing and re-ingesting a FY:
1. First sync inserts all rows; tombstoneOrphans halts (no baseline yet).
2. `recordIngestRun` writes `rows_per_month` JSON to `ingest_run` table.
3. Second sync: baseline loaded → tombstoneOrphans armed → zero churn if sheet unchanged.
4. `loadBaselineFromDb()` in registerSync.ts runs once on cold start and populates in-memory map.

## Verified convergence (FY2026-27 after re-ingest with new key)

| Month | Rows | Dispatch |
|---|---|---|
| Apr-26 | 5,542 | Rs 13.11 Cr |
| May-26 | 11,812 | Rs 28.28 Cr |
| Jun-26 | 12,868 | Rs 31.43 Cr |
| Jul-26 | 9,387 | Rs 21.16 Cr |
| **Total** | **39,609** | **Rs 93.98 Cr** |

Tick 2: `touched: 39,609 · superseded: 0 · inserted: 0 · revived: 0 · tombstoned: 0`
SAP ghost rows: 0 (was 31 before — collision rows are now uniquely keyed).
