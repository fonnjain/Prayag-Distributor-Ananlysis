---
name: Secondary data layer schema + Gate 1 findings
description: Table names, column map, sheet IDs, and Gate 1 dry-run results for the secondary (retailer-level) order booking pipeline.
---

## Tables (created, migration applied)
- `secondary_register_line` — individual retailer-level order booking transaction rows (FY2021-22 through FY2024-25, source=register_sheets)
- `secondary_head_month` — pre-aggregated head/month pivot from State Head Dashboard (FY2025-26 / FY2026-27, source=state_head_dashboard)
- `secondary_ingest_run` — audit log for every dry-run and real ingest

## Sheet IDs (from mgmt_sources.json secondary_order_booking.files_by_year)
- FY2021-22: `1RtRByRmNQorYOEeHsZuOy1GIkB7dVu7MNv9P_pg97Bs`
- FY2022-23: `1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c`
- FY2023-24: `1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY`
- FY2024-25: `1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g`
- FY2025-26 dashboard: `1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY`
- FY2026-27 dashboard: `1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM`

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
