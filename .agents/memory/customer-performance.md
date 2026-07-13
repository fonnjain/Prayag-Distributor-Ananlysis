---
name: Customer Performance page
description: Architecture, data sources, and key rules for the /customers page — units-first analytics, Laspeyres price multiplier, configurable scheme engine.
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

## Laspeyres multiplier

`multiplier = Σ(qty_LY × price_CY) / Σ(qty_LY × price_LY)` — holds LY basket, reprices at CY realized prices.
Do NOT use naive value÷qty (mix contamination). Verified: company FY25-26→26-27 Laspeyres ≈ 1.1072 vs naive 1.1563.

Resolution order per customer:
1. Customer-specific (≥10 shared items AND ≥₹2L of LY value covered)
2. Category multiplier
3. Company multiplier (fallback)

Multiplier guardrails: cap [0.8, 1.5]. If prices FELL (< 1.0), target falls too — never floor at 1.0.

## DB schema (new tables)

`price_multiplier` — stores frozen Laspeyres multipliers per (fy_ly, fy_cy, scope, scope_value)
`scheme_def` — configurable scheme definitions (basis: value|qty, period, appliesTo, scopeType, slabs)
`scheme_slab` — ordered tiers, FK→scheme_def with ON DELETE CASCADE

## Backend files

- `lib/customers/analytics.ts` — listCustomers, getCustomerCategories, getCustomerProducts, getChurned, getNewCustomers, getPriceShrinkers, getCustomerHistory, getAvailableMonths, toLyMonths
- `lib/customers/laspeyres.ts` — computeCompanyMultiplier, computeCategoryMultipliers, resolveCustomerMultiplier, computeAllMultipliers
- `lib/customers/schemes.ts` — CRUD for schemes/slabs, computeSchemeTracking, getPushList

## API routes (all under /api/customers/)

GET months, performance, detail, history, churn, shrinkers, multiplier
GET/POST/PUT/DELETE schemes/:id, GET schemes/:id/tracking, schemes/:id/push-list

## Push list rule

Entities within 20% of the next slab threshold (or within reach at run-rate).
Sort by effort-to-reward: smallest gap relative to benefit value = highest-ROI call list.

## Scheme period FY derivation

When scheme.fy = "2026-27", fyLy = "2025-26" is computed as:
`${parseInt(fy.split("-")[0]) - 1}-${fy.split("-")[0].slice(-2)}`

## What NOT to do

- Never floor multiplier at 1.0 when prices fell (Hardware 0.98, WT Lid 0.99 are real)
- Never sum primary + secondary figures in one total
- Never take price from rate list / item_master.mrp
- Never compare consecutive months; only same-month-prior-year
