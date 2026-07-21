---
name: Tank qty bug reconciliation
description: sale_line.qty stored per-tank-litres instead of SAP billing pieces for WCT/WT- codes; permanent loader fix implemented and verified complete July 21 2026. One-current-row-per-identity invariant also fully closed July 21 2026. No further action needed.
---

## Decision (confirmed)
`qty` = SAP billing pieces. Derived column `qty_ltr` (numeric) = qty × per-tank-litres.
Reports needing volume (Report 4 "Ltr" unit) read `qty_ltr`; all other analytics read `qty`.

## Per-tank-litres suffix map (confirmed)
| suffix | litres |
|--------|--------|
| 02 | 200 |
| 03 | 300 (was wrongly 1500 in map; confirmed: 1800/300=6, 1800/1500 not integer) |
| 05 | 500 |
| 07 | 750 |
| 10 | 1000 |
| 15 | 1500 |
| 20 | 2000 |
| 25 | 2500 |
| 30 | 3000 |
| 50 | 5000 |

"01" is intentionally absent: WT-001 = "PLASTIC LIDS HEAVY" (lid accessory, no volume).
WT-001 qty is already in pieces; qty_ltr stays NULL — this is correct, not a bug.

## Permanent loader fix (implemented and verified July 21 2026)

### Critical fix: lineUid recompute after tank resolution
`toSaleLine()` hashes `lineUid = SHA1(fy|code|qty|amount|monthLabel|serialNo|occ)` using the ORIGINAL sheet qty (litres). After `resolveWaterTankRow()` changes `qty` to pieces, the lineUid still points to the old litres-based row. When versionedSyncLines tombstones that old row then tries to insert the resolved row, `ON CONFLICT DO NOTHING` fires (the litres-based lineUid already exists as superseded) — insert silently blocked.

**Fix in `registerSync.ts` doSync():** After building `resolvedLines`, a second pass with a fresh `OccurrenceCounter` (tankUidOcc) recomputes `lineUid` for every WATER TANK row using the resolved qty (pieces). Non-tank rows are unchanged. This gives each correctly-resolved row a distinct lineUid that does not collide with the superseded litres-based row.

### Files created/modified
- `artifacts/api-server/src/lib/registers/tankResolution.ts` — canonical single source of truth: TANK_SIZE_MAP, `tankLitresFromCode()`, `tankSizeMapSql()`, `resolveWaterTankRow()`, `buildSapLookupMap()`, `assertTankQtyLtr()`
- `registerSync.ts` `doSync()` — SAP lookup → `resolveWaterTankRow` per line → lineUid recompute pass → `versionedSyncLines`
- `registers.ts` — imports canonical map; dry-run route

### Resolution logic
- **Route 1 (SAP match):** lookup `(invoice_no, code)` in SAP; qty = SAP pieces, qty_ltr = pieces × perTankLitres
- **Route 2 (exact division):** no SAP match; sheetQty % perTankLitres === 0 → qty = sheetQty/perTankLitres, qty_ltr = sheetQty
- **Flags:** `sap-ghost` (SAP not ready yet), `non-clean-division` (warning), `unmapped-suffix` (WT-001 lids)

## versionedSyncLines currentMap fix (July 21 2026)

`currentMap` was `Map<string, DbRow>` — last-write-wins. When 2+ current rows existed for the
same identity key (from prior accumulation), only the last-loaded DB row was kept in the map.
The earlier row was invisible to both the supersession check and the orphan tombstone (its identity
was in `seenForMonth`), so it persisted as current indefinitely.

**Root symptom:** 344 duplicate identities across FY2026-27 (287 with distinct amounts = ₹46.8 lakh
double-counted), caused by rate-rounding changes between sync runs accumulating silently.

**Fix in `ingest.ts` `versionedSyncLines()`:**
- `currentMap: Map<string, DbRow[]>` — collects ALL current DB rows per identity key.
- For each incoming line: find exact match (amtMatch + rateMatch + serialMatch) across all buckets.
  - Match found → touch the matched row; supersede all other bucket members (stale duplicates).
  - No match → supersede all bucket members; insert new version.

**Cleanup applied:** 344 rows superseded via SQL (keep newest `ingested_at`, supersede older);
45 additional stale rows superseded by the fixed code on first run. Total: 389 stale rows retired.

**Verified clean:** `duplicate_identities = 0` across all 33,753 FY2026-27 identities after fix.

## Verified final state (FY2026-27, July 21 2026)

| Check | Result |
|---|---|
| `tank-tier-a-dryrun` mismatches | **0** (was 46 before lineUid fix) |
| `non_integer_ratio` DB rows | **0** — every tank row exact integer ratio |
| All 40 codes `min_ratio = max_ratio` | **confirmed** |
| Startup sync `inserted` | **168** (unblocked by lineUid fix) |
| Startup sync `tombstoned` | **0** |
| `assertFail` | **0** |
| Current tank rows | 2,248 with pieces in `qty` |
| Superseded rows (archived litres history) | 822 |
| Duplicate identities after invariant fix | **0** |

## REGISTER_SYNC_PAUSE
Now set to `"2025-26"` only. FY2026-27 syncs live on every 6-hour tick.
FY2025-26 stays paused: live Sheets register returns 0 rows (original xlsx required for backfill); DB data is correct from xlsx backfill.

## End-to-end trace (verified)
Invoice 22600245, code WT-ISI-10, FY2026-27:
- SAP: qty=40 pieces, description "WATER TANK 2 LAYER ISI 1000 LTR", amount ₹240,062.4
- Suffix "10" → perTankLitres = 1,000L
- qty_ltr = 40 × 1,000 = 40,000L stored in DB ✓

## Null qty_ltr rows (correctly null)
- WT-001 across all FYs (~12 current FY2026-27 rows): "PLASTIC LIDS HEAVY". No litre capacity. qty already pieces. qty_ltr = NULL — correct.
- WT-002 qty=340 anomaly (FY2023-24): 340/200=1.7, source data. Left null.

## SAP Combined tab column layout (FY2026-27)
POSTINGDATE | DOCUMENTNUMBER | BRANCH | CUSTOMERNAME | SEGMENT | OLDITEMCODE | DSCRIPTION | COLOR | QUANTITY | PRICEBEFDI | PRICEAFTERDISCOUNT | TAXABLEAMOUNT | TOTAL | GROUP | MONTH

"DSCRIPTION" is a typo in the sheet. "OLDITEMCODE" is the item code. "DOCUMENTNUMBER" is the invoice number.

## Report 4 fix
`queryQty()` in `companyReports.ts`: `sum(qty)` → `CASE WHEN groupRaw='WATER TANK' THEN sum(qty_ltr) ELSE sum(qty) END`. Null-ltr rows (WT-001, WT-002 anomaly) contribute 0 via COALESCE.
