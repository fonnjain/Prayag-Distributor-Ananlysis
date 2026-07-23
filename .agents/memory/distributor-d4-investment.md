---
name: Distributor D4 Investment, ROI, Tiering
description: >
  Architecture decisions and known quirks for Phase D4 of the Distributor Deep Dive:
  effective discount, cost to serve, credit/scheme sources, ROI, and A/B/C tiering.
---

## SQL IN-clause pattern (critical)
`= ANY(${jsArray})` does NOT work with drizzle-orm + node-postgres.
Drizzle cannot serialize a plain JS array as a pg array for ANY().
Always use `sql.join(arr.map(v => sql\`${v}\`), sql\`, \`)` inside an IN clause.
D3 (distributorSkuSpread.ts) and D4 (distributorInvestment.ts) both use this pattern.

**Why:** The = ANY(pgArray) approach silently returns 0 rows — the query executes
without error but matches nothing. Very hard to debug.

## D4 module wiring
Step 12 in distributorDeepDive.ts calls `loadDistributorInvestment(fy, distGroups, d4MemberCostPerVisit)`.
`d4MemberCostPerVisit` is computed AFTER allRows is built (post Step 2), using:
  1. `sheet.spread` captured from loadMemberSheet "ok" results (memberSpreads map)
  2. `loadDeepDiveData(fy, stateHead, normKey)` — TTL-cached, cheap on repeat calls
  3. `computeRoiCost(kpis.ctcMonthly, kpis.taBillStCost, fy, spread)` — same formula as Phase 4

## Live FY
`isLiveFy = fy === "2026-27"`. When true, effectiveDiscount = null (no secondary register).
Tier still computes from NET/growth/active — discount input scores 12pt (no-data default).

## Discount anomalous lines
FY2023-24 and FY2022-23 have lines where discount_pct > 100 (credit-note artefacts).
These are excluded from the weighted average (use gross_amount in net_clean instead)
and flagged via hasAnomalousLines. See secondary-negative-credit-notes.md.

## Credit / Scheme
Always { status: "no_source" }. Never estimate, never zero, never a placeholder number.
These are reserved for future AR and scheme data sources.

## Tier scoring anchors (FY2025-26 Anant Singh verified)
- Jagdamba: Tier A 72pt — 51.2% discount (above peer 45.9%), 18.71x ROI
- Sumit: Tier A 79pt — 45.1% discount (below peer), 11.95x ROI
- Manoj: Tier B 57pt — lowest NET (8pt) + moderate discount (12pt) = 57
