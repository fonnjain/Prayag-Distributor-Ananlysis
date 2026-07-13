---
name: Customer Performance page
description: Architecture, data sources, column-name quirks, tab-detection rules, auto-sync architecture, and verification anchors for the /customers page.
---

## Architecture

- Route: `/customers` + `/customers/:section` → `CustomersPage.tsx`
- Dashboard sidebar nav: "Customers" link added (Store icon) alongside "Sales"
- Four sections: Rankings, Price Shrinkers, Churn & New, Schemes

## Rule Zero — units before value

Every query and display leads with QTY (pcs). Value is shown alongside.
Price effect (pp) = value growth% − qty growth% — separates price rises from real demand.
"Revenue up, volume down" = `qtyCy < qtyLy && valCy > valLy` — hidden shrinkers flag.

## Data sources

- Distributor + Direct Dealer: `sale_line` table (typeRaw field distinguishes: contains "direct" → direct_dealer, else distributor)
- Retailer: secondary order booking xlsx (not yet in sale_line — future work)
- Month labels: "Apr-26", "Jan-27". LY conversion: subtract 1 from the 2-digit year suffix ("Apr-26" → "Apr-25")

## Realized price rule

`price = amount / qty` from `sale_line`. NEVER from `item_master.mrp` (unreliable, often 0).

## Order-register column-name quirks (CRITICAL — don't regress)

The order-register sheets (in `config/register_sheets.json`) use **different column names** from the state-head registers:

| Sheet column  | normHeader()  | normalize.ts alias needed |
|---------------|---------------|---------------------------|
| Taxable Value | TAXABLEVALUE  | `find("AMOUNT","TAXABLEVALUE")` |
| Customer.Name | CUSTOMERNAME  | `find("CUSTOMER","CUSTOMERNAME")` |
| STATE HEAD    | STATEHEAD     | `find("STATEHEADA","STATEHEAD")` |

`isHeaderRow()` must also accept `TAXABLEVALUE` as the amount column — failing to do so silently returns 0 rows with no error.

## No FY column on order-register sheets

These sheets have no "FY YEAR" column (`cols.fy = -1`). `parseRegisterRow` has an optional `fyOverride` param; callers must pass the FY from `register_sheets.json` so rows get a valid `fy` and stable `line_uid`.

## Monthly tabs, not "Sheet1"

Order-register workbooks use monthly tabs (`Apr-26`, `May-26`, … `Mar-27`). `sheetsRegister.ts` now detects monthly tabs via `/^[A-Za-z]{3}-\d{2}$/`, reads each with independent header detection, and falls back to `"Sheet1"` for single-tab layouts.

## register_sheets.json — correct IDs (do not change)

Were accidentally set to State Head Sale IDs before. Correct order-register IDs:
- 2024-25: `1cT6lWRPJ3oSeYhab-cqeVjJidGitFQsr0DOq-vNn6cI`
- 2025-26: `1Xzq-gmB6K7iuMcE6gb-O7OpvGgSDU33DzEVyK60LK6E`
- 2026-27: `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A`

## Auto-sync architecture (no manual backfill required)

`lib/customers/registerSync.ts`:
- `ensureRegisterSynced(fy)`: checks for existing rows, fires a background Sheets read → `insertSaleLineBatches` if empty; idempotent.
- `getRegisterSyncState(fy)`: returns `{phase, rows, error}` (idle/syncing/done/error).
- Called on server startup (`index.ts`) for every key in `register_sheets.json`.
- Called again from `GET /api/customers/months` when months returns empty.
- Months endpoint returns `{syncing:true}` while in progress; frontend polls every 15 s.

## Laspeyres multiplier

`multiplier = Σ(qty_LY × price_CY) / Σ(qty_LY × price_LY)` — holds LY basket, reprices at CY realized prices.
Do NOT use naive value÷qty (mix contamination). Verified: company FY25-26→26-27 Laspeyres ≈ 1.1072 vs naive 1.1563.

Resolution order per customer:
1. Customer-specific (≥10 shared items AND ≥₹2L of LY value covered)
2. Category multiplier
3. Company multiplier (fallback)

Multiplier guardrails: cap [0.8, 1.5]. If prices FELL (< 1.0), target falls too — never floor at 1.0.

## DB schema (newer tables)

`price_multiplier` — stores frozen Laspeyres multipliers per (fy_ly, fy_cy, scope, scope_value)
`scheme_def` — configurable scheme definitions (basis: value|qty, period, appliesTo, scopeType, slabs)
`scheme_slab` — ordered tiers, FK→scheme_def with ON DELETE CASCADE

## Verification anchors (Apr-Jul FY26-27 vs FY25-26, company-wide)

- VALUE: −27.6%
- UNITS: −37.3%
- Price effect: +9.8pp
- SHRI GANESH PIPE: qty −69%, value +110%
- WT-3LL-10: qty −10%, value +12%, realised price +25%

## What NOT to do

- Never floor multiplier at 1.0 when prices fell (Hardware 0.98, WT Lid 0.99 are real)
- Never sum primary + secondary figures in one total
- Never take price from rate list / item_master.mrp
- Never compare consecutive months; only same-month-prior-year
- Never read register sheets from "Sheet1" — they use monthly tabs
- Never omit TAXABLEVALUE alias from isHeaderRow/mapRegisterColumns
