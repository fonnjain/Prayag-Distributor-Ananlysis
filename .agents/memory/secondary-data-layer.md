---
name: Secondary data layer schema + Gate 1 findings
description: Table names, column map, sheet IDs, and Gate 1 dry-run results for the secondary (retailer-level) order booking pipeline.
---

## Tables (created, migration applied)
- `secondary_register_line` — individual retailer-level order booking transaction rows (FY2021-22 through FY2025-26, source=register_sheets)
- `secondary_head_month` — per-individual-member monthly aggregates (FY2023-24 through FY2026-27, source=state_head_dashboard). Key: (fy, head_canon, month_label). head_canon is the person's normKey, NOT a geographic state. stateHead is the senior head they roll up to.
- `secondary_ingest_run` — audit log for every dry-run and real ingest

## Sheet IDs
Registers (secondary_order_booking.files_by_year):
- FY2021-22: `1RtRByRmNQorYOEeHsZuOy1GIkB7dVu7MNv9P_pg97Bs`
- FY2022-23: `1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c`
- FY2023-24: `1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY`
- FY2024-25: `1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g`
- FY2025-26: `1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80` (added)

State head dashboards (state_head_dashboard.files_by_year):
- FY2023-24: `1ESjgk5FthsvYc_Bk9zuJVnJ1XtwKQxv0XG2onuspnhg` — tab prefix "ORDER BOOKING REPORT"
- FY2024-25: `1MwNMVzWE3QBVOyJjKr3eFX-Sq1Ng0Q1sghWJbgbE_8g` — tab prefix "ORDER BOOKING REPORT"
- FY2025-26: `1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY` — tab prefix "ORDER BOOKING REPORT"
- FY2026-27: `1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM` — tab prefix "SECONDARY ORDER BOOKING REPORT"

IMPORTANT: Dashboard IDs must be consistent in THREE places: secondary_sheets.json,
mgmt_sources.json state_head_dashboard.files_by_year, AND stateDashboard.ts SHEET_IDS.
All three were updated together. If you add a new FY, update all three.

Also note: a historical multi-year workbook exists (`1F69Qv2qaO_ah1domYyhe_Y7qGPZk7Uyfw0oAMovt7bU`
"STATE HEAD DASHBOARD" no year suffix) containing tabs for FY2020-21 through FY2022-23.
Not currently wired — can be added later if needed.

## Column map (v1) — actual register header
```
S.No | Date | Retailers | ID | Segment | Cat.No | Qty | MRP | Order Value | Distributor | Discount | Sub Total
```
(FY2024-25 has a grand-total row at row 0; real header at row 1 — 20-row scan covers both.)

**Why the v1 map was updated:** original anchor tokens (AMOUNT/SECONDARYAMOUNT/NETAMOUNT) don't appear in these sheets. Real amount column is `Sub Total` (FY2021-22 through FY2023-24) or `Order Value` (FY2024-25). Head proxy is `Distributor` — no State Head column exists in register files.

**Key token additions:**
- `header_anchor_tokens`: + SUBTOTAL, ORDERVALUE
- `amount`: + SUBTOTAL, ORDERVALUE
- `head`: + DISTRIBUTOR
- `customer`: + RETAILERS (plural, as spelled in FY2021-24 sheets)
- `brand`: + SEGMENT
- `month`: + DATE (derive month from transaction date)

**Note:** SUBTOTAL appears as both a column header name AND a sub_total_skip_token. No false positives because isSubTotalRow() runs on data rows whose first 5 cells are: serial#, date, retailer name, retailer ID, segment — never the string "SUBTOTAL".

## Gate 1 dry-run results (no data committed)
| FY | source | data rows | grand total | all months | notes |
|---|---|---|---|---|---|
| 2021-22 | register | 42,792 | ₹12.11 Cr | ✅ | unmapped heads (distributors) |
| 2022-23 | register | 61,966 | ₹15.60 Cr | ✅ | unmapped heads; 1 negative (-₹66k) |
| 2023-24 | register | 4,638 | ₹1.05 Cr | ❌ Apr only | sheet may be partial |
| 2024-25 | register | 76,352 | ₹4.46 Cr | ✅ | unmapped heads |
| 2025-26 | dashboard | 2,592 hm | Plan 379.75 Cr / OB 234.42 Cr / Sales 240.14 Cr | ✅ | 136 anomalies (sales>OB×1.5) |
| 2026-27 | dashboard | 1,932 hm | Plan 360.10 Cr / OB 57.37 Cr / Sales 60.27 Cr | ✅ (3 closed) | 29 anomalies |

## Structural validator failures (expected at Gate 1, not bugs)
- `unmapped_heads_empty`: Register files use Distributor as head proxy. Distributors ≠ state heads → all unmapped. Needs distributor → state head mapping table.
- `sum_by_head_consistent`: Consequence of 100% unmapped heads (all fold into null bucket).
- `row_count_fy`: Expected counts are null; set after first verified ingest.
- `all_months_present` (FY2023-24): Only April present — likely an incomplete export of that sheet.

## stateHeadLoader.ts rowsRead fix
For state_head_dashboard source: 1 sheet row expands to 12 head-month rows. rowsRead is set to headMonthRows.length (not dashboard.rowsRead) so the row-accounting identity (data+subtotal+blank=read) holds without negative blankRowsSkipped.

## "Tarun Giri" note
No member with key matching "tarun" exists in FY2025-26 or FY2026-27 dashboard data. "girishb" (Girish B) is anomalous in both FYs.

## FY2026-27 register (PSCode_3 xlsx drop, Aug 2026)
- FY2026-27 secondary register came as ~179 per-salesperson `PSCode_3_New_Report <NAME>.xlsx` files, NOT a Google Sheet; loaded into `secondary_sku_line` only (source='pscode3_xlsx') via `artifacts/api-server/scripts/pscode3-load.ts` (dry-run default, `--write` to load; full-FY delete+insert in one transaction; Prasun + row-count safety gates).
- Parsing rules: NET = Sub Total (col M) line-level; Order Total (col N) repeats on EVERY line — never sum it. Trailing `Total:` footer row must be excluded. Order ID (E) and Segment (F) are merged cells — ExcelJS resolves merges automatically; merge-unaware parsers (openpyxl) see blanks and produce wrong per-month subsets.
- 16 duplicate-total file groups were byte-identical duplicate exports (same Order ID sets) — one file loaded per group (~₹5.47 Cr would double otherwise). PSCode_3 salesperson names do NOT join to the SOBR member roster (different vocabulary); head_raw is cosmetic for these analytics.
- brand-level `secondary_register_line` stays EMPTY for FY2026-27: D3 segment spread, win-back, effective-discount-in-investment remain live-year blocked; item-code features (K4 secondary discount, retailer capability) gate on `secondarySkuFyHasData()` (data presence, not SKU_SHEET_IDS).
- Coverage Apr–Jun 2026 only; anchors post-dedupe: Apr 21,613/₹13.11 Cr, May 31,266/₹21.01 Cr, Jun 36,300/₹24.90 Cr, total ₹59.02 Cr NET, eff. discount ≈49%; Prasun Chatterjee ₹18,34,506.
