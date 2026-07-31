---
name: Register three-schema gap
description: Three distinct Sheets register schemas across FYs; all three closed FYs now loaded + frozen; per-head data for Schema B/C FYs must come from the State Head Sale pipeline, not sale_line.
---

## The three schemas

Schema A — FY2026-27, 18-col SALE SHEET (live sync target):
`Serial, InvoiceNo, Date, BillFrom, CustomerName, City, Destination, ItemCode, Color, Quantity, MRP, SaleRate, TaxableValue, GROUP, STATION, STATE, STATE HEAD, MONTH`

Schema B — FY2024-25 and FY2025-26, 11-col per-monthly-tab (SAP format, Combined tab ignored):
`INVOICENO, DATE, BILLFROM, CUSTOMER, GROUP, CODE, COLOR, QTY, MRP, SALERATE, AMOUNT` — no MONTH column (month from tab name); **NO STATE HEAD column** — head_canon NULL on every row by construction, not a parser bug (STATEHEADNAME/ITEMCOLOR aliases exist in normalize.ts).

Schema C — FY2023-24, 10-col single Sheet1 tab:
`Customer, Item Code, MONTH, Quantity, Rate, Amount, GROUP, station, STATE, STATE HEAD A` — no invoiceNo/color; post-resolution synthetic serials (step 2c in doSync) make identity keys unique. HAS a head column — head_canon populated (old vocab maps via aliases: SANDEEP JI → Sandeep Dadheech etc.).

All three closed FYs loaded exactly and frozen (see frozen-registers-freeze.md).

## Per-head data rule (Jul 31 2026)

**Rule:** per-head sale for Schema B FYs (2024-25, 2025-26) must come from the Sheets "State Head Sale" loader, never sale_line. `saleFromDb.ts` returns an error when >90% of the total is "unmapped", so `primaryPeriod` falls through to the Sheets loader.
**Why:** the DB path short-circuiting with byHead={unmapped: total} silently broke the per-head view after the straight-copy reload.
**How to apply:** any per-head consumer for FY2024-25/25-26 uses the State Head Sale pipeline. FY2025-26 verified: per-head total ₹361.14 Cr = State Head Sale anchor. FY2024-25 has NO entry in SALE_SHEETS (stateHeadSale.ts) — per-head unavailable until a sheet is configured.

## Guardrail gap (still open)

When `head = -1` (column absent), every row's `headRaw = null`. `canonHead(null, ...)` returns early without bumping `unmapped_heads` — the "zero unmapped heads" guardrail passes silently on an absent column. Structural to Schema B; the saleFromDb >90%-unmapped guard is the downstream mitigation.
