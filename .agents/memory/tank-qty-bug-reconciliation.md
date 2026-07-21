---
name: Tank qty bug reconciliation
description: sale_line.qty stored per-tank-litres instead of SAP billing pieces for WCT/WT- codes; fix fully applied across all FYs; qty_ltr column added for volume.
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

## Fix tiers applied (all verified)

| Tier | FY | Rows | Method |
|---|---|---|---|
| B | 2023-24, 2024-25 | 5,701 | State 2: qty in TANK_SIZES list, exact N×ltr — divide to pieces |
| C | 2023-24, 2024-25 | 2,420 | State 1+3: qty=perTankLitres per row — qty→1, qty_ltr→perTankLitres |
| B-ext | 2023-24, 2024-25 | 4,169 | Same as B but N×ltr not in TANK_SIZES (e.g. 2250, 3500, 4000) |
| Already-pieces | 2023-24, 2024-25 | 82 | qty<perTankLitres → already pieces; set qty_ltr=qty×ltr |
| A | 2025-26, 2026-27 | 4,731 | SAP-matched: qty→SAP pieces, qty_ltr→sapQty×ltr (≤5 Rs tolerance) |
| A-tombstone | 2025-26, 2026-27 | 155 | State1_3 dups of A rows → version_status='superseded' |
| B-ext | 2025-26, 2026-27 | 2,463 | Exact-multiple rows not matched by SAP |
| Already-pieces | 2025-26, 2026-27 | 123 | qty<perTankLitres → set qty_ltr=qty×ltr |
| "03"-suffix recorrection | all FYs | 198 | Map had 1500→corrected to 300; re-ran fix |

## Crosscheck definitions (per tier)

**Tier A (FY2025-26/2026-27):**
- External SAP anchor: dry-run matched each DB row to SAP row by invoice_no + closest amount (≤5 Rs). This proves row correspondence from source.
- qty set to SAP pieces → independent external check that qty = SAP billing pieces.
- DB amount unchanged → SAP amount = DB amount remains true after fix.
- Internal post-fix: qty × perTankLitres = qty_ltr (trivially true by construction).

**Tier B/C/B-ext/already-pieces (FY2023-24/2024-25):**
- Internal only: qty × perTankLitres = qty_ltr.
- No external SAP anchor available (no invoice_no in DB for these years, no SAP export).
- "Crosscheck OK" counts in fix reports = internal consistency only.

## Tombstoned rows
- 521 FY2026-27 + 2 FY2025-26 = 523 total superseded tank rows.
- 155 of 521 FY2026-27 were tombstoned by Tier A (State1_3 duplicates).
- 366 FY2026-27 + 2 FY2025-26 = 368 pre-existing from normal sync versioning.
- All 523 superseded rows have qty_ltr=NULL; Report 4 (filters version_status='current') counts each real invoice line exactly once.

## Final null qty_ltr rows (correctly null)
- WT-001 across all FYs (~93 rows): SAP description = "PLASTIC LIDS HEAVY". Lid accessory, no litre capacity. qty is already pieces (confirmed by SAP qty match for all FY2026-27 invoices). qty_ltr correctly NULL — not a bug.
- WT-002 qty=340 (2 rows FY2023-24): 340/200=1.7, source data anomaly. Left null per user guidance.

## End-to-end trace (verified)
Invoice 22600245, code WT-ISI-10, FY2026-27:
- SAP: qty=40 pieces, description "WATER TANK 2 LAYER ISI 1000 LTR", amount ₹240,062.4
- Suffix "10" → perTankLitres = 1,000L
- qty_ltr = 40 × 1,000 = 40,000L stored in DB ✓
- DB amount = ₹240,062.4 (unchanged) ✓
- Report 4 reads sum(qty_ltr) for WATER TANK group → row contributes 40,000L ✓

## SAP Combined tab column layout (FY2026-27)
POSTINGDATE | DOCUMENTNUMBER | BRANCH | CUSTOMERNAME | SEGMENT | OLDITEMCODE | DSCRIPTION | COLOR | QUANTITY | PRICEBEFDI | PRICEAFTERDISCOUNT | TAXABLEAMOUNT | TOTAL | GROUP | MONTH

Important: "DSCRIPTION" is a typo in the sheet (not "DESCRIPTION"). "OLDITEMCODE" is the item code column. "DOCUMENTNUMBER" is the invoice number column. All aliases added to readSapSourceTab and sap-check route.

## Report 4 fix
`queryQty()` in `companyReports.ts`: `sum(qty)` → `CASE WHEN groupRaw='WATER TANK' THEN sum(qty_ltr) ELSE sum(qty) END`. Null-ltr rows (WT-001 lids, WT-002 anomaly) contribute 0 via COALESCE.

## REGISTER_SYNC_PAUSE
Still "2025-26,2026-27". Register sync pipeline not yet updated to write qty=pieces, qty_ltr=litres for WCT/WT- rows. Must stay paused until pipeline fix.

## Remaining work
- Fix registerSync/ingest pipeline for tank rows (write qty=pieces, qty_ltr=litres at ingest time).
- After pipeline fix: un-pause, run /verify to confirm no regression.
