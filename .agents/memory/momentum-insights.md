---
name: Momentum insights page
description: M1 momentum page — rate/direction rules, territory basis for historical FYs, period-scope rule
---

# Momentum insights (GET /api/momentum/insights)

Composes existing services only (Laspeyres, seasonal curve, skuK4, getAtRisk, deepDive Data tab, registers). No new computation engines.

- **One period for every panel.** A selected month filter scopes headline, acceleration, pipeline AND run-rate identically. Never let one panel run on YTD while another runs on the filtered slice — the page then mixes bases silently. A selection with no complete month is a 400, never a silent YTD fallback.
- **Territory basis on `sale_line` must use the project-customer bridge** (`territoryFilterSql(getProjectCustomerSet())` from skuK4, now exported). A bare `head_canon != PROJECT` predicate blanket-includes historical NULL-head rows and mislabels project business as territory.
- **Why:** historical FYs carry no head attribution on many rows; the SKU services already solved this — reuse, don't re-derive.
- **Seasonal run-rate:** `monthlyShare(i)` in lib/seasonal is a 0-based FRACTION (periodShare too). Projection = period actual ÷ Σ shares of the selected months.
- **Failed optional loads surface as unavailable, never zero** (at-risk returns null → "not available, this is NOT a zero"), per the no-data guard.
- **Falling-from-high flag:** members with achievement ≥ 50% whose like-months register OB drops ≥ 20% YoY; rows with cur register OB = 0 but achievement ≥ 50% are register-name mismatches, not collapses — filter them out.
- Like-month YoY comparison cancels seasonal shape by construction — that is the stated seasonal adjustment for monthly rates.
