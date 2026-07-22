---
name: Sales Deep Dive — Data tab column aliases
description: Actual column names found in the STATE HEAD DASHBOARD 'Data' tab; needed because they differ from the logical names.
---

## Context
The STATE HEAD DASHBOARD spreadsheet (`1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM`)
has a 'Data' tab with per-member KPI rows. Column headers use non-obvious names.

## Critical column aliases (normHeader → logical field)

| normHeader key | Logical field | Verified value (Prasun Chatterjee, Anant Singh, FY2026-27) |
|---|---|---|
| `OLDPARTYBUSINESSORDERBOOKING` | orderBooking (retailer/party NET OB) | 1,834,503.57 (≈ ₹18,34,504) |
| `SALEREPORT2627` / `SALEREPORT` | sale (secondary YTD sales received) | 2,613,934 (₹26,13,934) |
| `VISITEDINAMONTH` | visitedRetailers | 54 |
| `BUSINESSPLAN` | secondaryTarget (annual) | 5,100,000 (₹51L) |
| `MONTHLYCTTC` or `MONTHLYCTC` | ctcMonthly | 46,390 |
| `COSTRATIO` | costRatio (stored as decimal, ×100 = %) | 0.0593... = 5.94% |
| `TOTALOLDRETAILERS` | totalOldRetailers | 61 |
| `NONVISITED` | nonVisitedRetailers | 8 |
| `NEWPARTYORDERBOOKING` | newPartyOrderBooking | 0 |

## Watch-outs
- The `SALE` normHeader matches a DIFFERENT column (value ~₹92L for Prasun) —
  NOT the secondary sale received. Always prefer `SALEREPORT2627`/`SALEREPORT`.
- `CTC` maps to annual CTC (₹1,39,170); monthly CTC is in `MONTHLYCTC` (₹46,390).
- `ACHIEVEMENT` normHeader maps to a rupee amount (same as `OLDPARTYBUSINESSORDERBOOKING`),
  not a percentage — do not use it as achievementPct.
- `TOTALORDER` / `TOTALORDER2526` are full-year totals, not Q1 secondary sale.

## Implementation
- Library: `artifacts/api-server/src/lib/mgmt/deepDiveData.ts`
- Route: `GET /api/mgmt/deep-dive?fy=&stateHead=&member=`
- Frontend: `artifacts/prayag/src/components/dashboard/SalesDeepDive.tsx`

**Why:** The column names in the Data tab are different from those in the
SECONDARY ORDER BOOKING REPORT tab. A future agent adding columns or fixing
mismatches must check against these verified mappings first.

**How to apply:** When extending the Data tab reader, add new synonym variants
to `detectCols()` in `deepDiveData.ts`. Always run the acceptance criteria curl
against Prasun Chatterjee / Anant Singh / FY2026-27 after any column change.
