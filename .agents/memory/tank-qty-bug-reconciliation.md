---
name: Tank qty bug reconciliation
description: sale_line.qty stored per-tank-litres instead of SAP billing pieces for WCT/WT- codes; fix fully applied across all FYs; qty_ltr column added for volume.
---

## Decision (confirmed)
`qty` = SAP billing pieces. New derived column `qty_ltr` (numeric) = qty × per-tank-litres.
Reports needing volume (Report 4 "Ltr" unit) read `qty_ltr`; all other analytics read `qty`.

## Per-tank-litres suffix map
Extracted from last 2 digits of WCT/WT- code: 02=200, 05=500, 07=750, 10=1000, 15=1500, 20=2000, 25=2500, 30=3000, 50=5000.

**Caveats:**
- "03" suffix — map says 1500L but two WT-3LL-03/WT-3LC-03 rows have qty=1800 which divides by 300 (not 1500). Possible the real size is 300L. Needs investigation before any further "03"-suffix fix.
- "01" suffix — no mapping; 93 rows (all WT-001 code) across all FYs left with qty_ltr=NULL.

## Fix tiers applied (all verified, zero crosscheck failures)

| Tier | FY | Rows | Method |
|---|---|---|---|
| B | 2023-24, 2024-25 | 5,701 | State 2: qty in TANK_SIZES list, exact N×ltr — divide to get pieces |
| C | 2023-24, 2024-25 | 2,420 | State 1+3: qty=perTankLitres per row — qty→1, qty_ltr→perTankLitres |
| B-ext | 2023-24, 2024-25 | 4,169 | Same as B but N×ltr not in TANK_SIZES (e.g. 2250, 3500, 4000) |
| Already-pieces | 2023-24, 2024-25 | 82 | qty<perTankLitres → already pieces; set qty_ltr=qty×ltr |
| A | 2025-26, 2026-27 | 4,731 | SAP-matched: qty→SAP pieces, qty_ltr→sapQty×ltr (≤5 Rs tolerance) |
| A-tombstone | 2025-26, 2026-27 | 155 | State1_3 dups of A rows → version_status='superseded' |
| B-ext | 2025-26, 2026-27 | 2,463 | Exact-multiple rows not matched by SAP |
| Already-pieces | 2025-26, 2026-27 | 123 | qty<perTankLitres → set qty_ltr=qty×ltr |

## Final DB state (current rows, after all tiers)
| FY | Total rows | Fixed (qty_ltr set) | Null (unfixable) |
|---|---|---|---|
| 2023-24 | 5,064 | 5,033 | 31 (27×WT-001 + 4 non-multiple) |
| 2024-25 | 7,368 | 7,339 | 29 (28×WT-001 + 1 non-multiple) |
| 2025-26 | 5,013 | 4,983 | 30 (26×WT-001 + 4 non-multiple) |
| 2026-27 | 2,346 | 2,334 | 12 (12×WT-001) |

Non-multiple codes: WT-002 qty=340 (2 rows FY2023-24), WT-3LL-03/WT-3LC-03 qty=1800 (7 rows across FYs).
Excluded (Tier A): 8 rows — 5 ghost invoices (FY2026-27), 3 bad-match amtDiff>5 Rs (FY2025-26 inv 600425/700415/600438).

## Report 4 fix
`queryQty()` in `companyReports.ts`: `sum(qty)` → `CASE WHEN groupRaw='WATER TANK' THEN sum(qty_ltr) ELSE sum(qty) END`. Null-ltr rows contribute 0 via COALESCE.

## REGISTER_SYNC_PAUSE
Still "2025-26,2026-27". Pipeline not yet fixed to store pieces. Do NOT un-pause until registerSync/ingest handles tank rows correctly.

## Remaining work
- Fix register sync pipeline (registerSync.ts / ingest.ts) to write qty=pieces, qty_ltr=litres for WCT/WT- rows.
- Investigate WT-001 (suffix "01", 93 rows) — likely 100L tank not in suffix map.
- Clarify "03" suffix: 300L or 1500L? Fix WT-3LL-03/WT-3LC-03 qty=1800 accordingly.
- After pipeline fix: un-pause, run /verify to confirm no regression.
