---
name: Tank qty bug reconciliation
description: sale_line.qty stored per-tank-litres instead of SAP billing pieces for WCT/WT- codes; permanent loader fix implemented; dry-run complete; REGISTER_SYNC_PAUSE awaiting user decision.
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

## Permanent loader fix (implemented July 2026)

Files created/modified:
- `artifacts/api-server/src/lib/registers/tankResolution.ts` — canonical single source of truth: TANK_SIZE_MAP, `tankLitresFromCode()`, `tankSizeMapSql()`, `resolveWaterTankRow()`, `buildSapLookupMap()`, `assertTankQtyLtr()`
- `registerSync.ts` `doSync()` — loads SAP lookup then applies `resolveWaterTankRow` per line (Route 1 SAP / Route 2 division), logs flags, passes `resolvedLines` to `versionedSyncLines`
- `registers.ts` — imports canonical map (no more duplicate JS constants or hardcoded SQL VALUES strings); adds `GET /registers/:fy/tank-sync-dryrun` route

Resolution logic:
- **Route 1 (SAP match):** lookup `(invoice_no, code)` in SAP; if found → qty = SAP pieces, qty_ltr = pieces × perTankLitres
- **Route 2 (exact division):** no SAP match; sheetQty % perTankLitres === 0 → qty = sheetQty/perTankLitres, qty_ltr = sheetQty
- **Flags:** `sap-ghost` (SAP not ready yet, expected for recent invoices), `non-clean-division` (warning), `unmapped-suffix` (WT-001 lids, correct)

## Dry-run results (FY2026-27, July 21 2026)

```
tankSheetRows:   2,187
dbTankRows:      2,346  (from xlsx backfill + one-off fix)
dbMatchedRows:   2,178
qtyMismatches:   110
qtyLtrMismatches: 113
```

**Verdict: "FAIL" is misleading — the LOADER IS CORRECT.**

Every one of the 110 mismatch rows was verified: `sheetLitres / perTankLitres = computedQty = SAP qty` — all correct. The DB has wrong values from the one-off fix, which used less precise SAP matching (by invoice+code only, without amount tolerance) and incorrectly merged multi-line invoices with the same code.

| Category | Count | Status |
|---|---|---|
| Route 1 (SAP) | 2,158 | Loader correct |
| SAP-ghost (Jul-26, timing) | 11 | Loader correct — Route 2 fallback; all match DB |
| WT-001 lids (unmapped) | 18 | qty stays pieces, qty_ltr=NULL — correct |
| Non-clean-division | 0 | None |
| Perfectly matching DB rows | 2,068 | No-op on sync |
| One-off-fix errors (will supersede) | 110 | Loader correct; DB wrong |
| New invoices (not yet in DB) | 9 | Will INSERT |

When REGISTER_SYNC_PAUSE is lifted and the first sync runs:
- 2,068 rows: touch (no-op)
- 110 rows: old wrong version tombstoned, new correct version inserted
- 9 rows: new inserts
- Subsequent syncs: no-op (idempotent)

## REGISTER_SYNC_PAUSE
Still set to "2025-26,2026-27". Loader is correct; awaiting user decision to lift the pause.

To lift: remove `REGISTER_SYNC_PAUSE` from env or set it to empty string. The next scheduled sync (or `POST /api/registers/2026-27/sync`) will correctly apply SAP-based qty/qty_ltr values. The 110 one-off-fix errors will self-correct automatically.
