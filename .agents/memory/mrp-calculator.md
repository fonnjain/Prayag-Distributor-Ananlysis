---
name: MRP Back-Calculator
description: Architecture and key decisions for the MRP back-calculator (GET /api/mrp/calculator).
---

## Route placement
Calculator routes (`/mrp/calculator` and `/mrp/calculator/verify`) must be declared **before** `GET /api/mrp/:code/history` in mrp.ts or Express treats "calculator" as the `:code` param.

## Distributor margin default derivation
`secondary_sku_line.discount_pct` is the **retailer trade discount off MRP**, not the distributor margin.
Using it raw as the distributor margin in `targetRetailerPrice / (1 − distMargin)` produces distBuyingPrice > retailerPrice (inverted).

**Correct default** (when both primary and secondary data are available):
```
distMargin = 1 − (1 − primaryDiscFrac) / (1 − secDiscFrac)
```
For code 144: primaryDisc=53.6%, secDisc=44% → distMargin=17.1%. Source label = "derived".
Fall back to raw secDisc (source="secondary") when no primary data; null (source="assumed") when neither.

## Identity check: MRP × (1−disc_frac) ≠ avg_sale for many rows
`avg_sale` in margin_fact is a **per-item constant** (same value across all months for a given code+segment),
not a month-specific figure. So `MRP × (1−discount_frac) = avg_sale` only holds for the reference month.
Gaps up to ~₹2.50 are normal data quality — not a calculator bug.

## Trailing 12 months
- `sale_line_current`: month_labels use calendar-year format (Oct-25, Nov-25 etc.) — generate list from `new Date()` and filter.
- `margin_fact`: FY2025-26 Oct/Nov/Dec rows are labeled "Oct-26"/"Nov-26"/"Dec-26" (FY-end-year suffix). With only 15 months total, just aggregate ALL rows for the code/segment — no trailing-12 filter needed.

## Verification endpoint
`GET /api/mrp/calculator/verify` — returns all 8 spec checks as JSON. The check3 count query must NOT reference `sale_line_current` (sl alias) — that's a separate query.

## Key verified figures (Aug 2026)
- Code 144: currentMrp=₹216.40, weightedDisc=53.61%, bomCost=₹17.59, distMarginDefault=17.1% (derived)
- Code 144 example (target ₹90, distMargin 15%): distBuying=₹105.88, backCalcMrp=₹228.24
- CNS-15: ambiguous (CP=₹1,020 / PTMT=₹860); refuses without segment (409)
- 3,305 codes have no margin_fact data (CP segment entirely absent + Pipe & Fitting + QUAA & FERN + unmapped)
- mrp_history row count: 8,949 (immutable — calculator never writes)
- sale_line_all row count: 468,881 (≥ 468,867 spec baseline)
