---
name: Register three-schema gap
description: Three distinct Sheets register schemas across FYs; Schema C (FY2023-24) blocks production load due to missing invoiceNo/color; Schema B aliases now fixed and live.
---

## The three schemas

Schema A — FY2026-27, 18-col SALE SHEET (live sync target):
`Serial, InvoiceNo, Date, BillFrom, CustomerName, City, Destination, ItemCode, Color, Quantity, MRP, SaleRate, TaxableValue, GROUP, STATION, STATE, STATE HEAD, MONTH`

Schema B — FY2024-25 and FY2025-26, 11-col per-monthly-tab (SAP format, Sheet1=Combined ignored):
`INVOICENO, DATE, BILLFROM, CUSTOMER, GROUP, CODE, COLOR, QTY, MRP, SALERATE, AMOUNT` — no MONTH column; month derived from tab name via `tabMonthLabelDerived` in `sheetsRegister.ts`.

Schema C — FY2023-24, 10-col single Sheet1 tab:
`Customer, Item Code, MONTH, Quantity, Rate, Amount, GROUP, station, STATE, STATE HEAD A` — **NO INVOICE NO, NO COLOR**.

## Schema B — status: FIXED (Jul 31 2026)

Two aliases added to `normalize.ts` `mapRegisterColumns()`:
```
color: find("COLOR", "COLOUR", "ITEMCOLOR"),
head: find("STATEHEADA", "STATEHEAD", "STATEHEADNAME"),
```
`tabMonthLabel` fallback (4th arg to `parseRegisterRow`) resolves null month_label for 11-col tabs.
Production FY2024-25 (141,193 rows) and FY2025-26 (145,547 rows) successfully loaded from Sheets.

## Schema C — status: BLOCKED (Task #68)

Sheet ID: `1R-jNPuy6ofJgIOqykulT0FDkuYVvh_FTAR59H4c5FkI` ("Sale 2023-24")
Dry-run verified: 137,619 rows · Rs 349.02 Cr — matches dev xlsx exactly.

**Why it can't load now:** `identityKey(invoiceNo, code, color, qty, monthLabel, serialNo)` requires invoiceNo + color. Schema C has neither. Rows sharing the same (code, qty, monthLabel) collapse to a single identity key → versionedSyncLines keeps only one current row per key → data loss.

**Fix needed:** For Schema C, replace null invoiceNo/color with a per-row occurrence counter (grouped within each (code, qty, monthLabel) bucket per month), injected at parse time before the identity key is constructed. The occurrence counter must be stable across re-ingests (same sheet ordering → same counter).

`REGISTER_SYNC_PAUSE` includes "2023-24" to prevent accidental loads until the fix is in place.

## Guardrail gap (still open)

When `head = -1` (column absent), every row's `headRaw = null`. `canonHead(null, ...)` returns early without bumping `unmapped_heads`. Ingestion guardrail "zero unmapped heads" does NOT fire — it catches values that appear but don't match, not absent columns. Un-aliased head column passes silently with null headCanon. This was the root cause of FY2024-25/2025-26 loading with null head_canon before the Schema B fix.
