---
name: Distributor D3 SKU Spread Architecture
description: How secondary_register_line is attributed to distributors and what data limitations apply (no item_code, no distributor column, head_canon=raw name).
---

## Rule
`secondary_register_line` has **no distributor column and no item_code/Cat.No.** The finest granularity is `brand_canon` (product-line name like "CPVC DURALIFE"). Distributor attribution flows from the D1 retailer list only.

**Why:** The secondary register records distributor→retailer sales by TM (head_canon) and retailer (customer). No distributor field exists. Attribution requires matching `LOWER(TRIM(customer))` against D1 retailer names.

**How to apply:** Any D3-style query must:
1. Collect all retailer names from D1 `DistributorGroup.retailers`
2. Query `secondary_register_line WHERE LOWER(TRIM(customer)) IN (lowercase_list)`
3. Group by `customer, brand_canon, fy` then aggregate in TypeScript

## Critical: head_canon stores raw names in secondary_register_line
The `head_canon` column in `secondary_register_line` stores the raw TM name string (e.g. "Pramod Kumar", "Rakesh Kumar Sinha"), NOT the normKey (e.g. "pramodkumar"). Do NOT query by `head_canon = normKey` — it will return 0 rows. Query by retailer customer name instead.

## LOWER/TRIM matching is essential
Secondary register customer names use inconsistent capitalisation ("SHIV HARDWARE" vs "Shiv hardware" vs "Shiv Hardware"). Always normalise both sides with `LOWER(TRIM())` in SQL and `.toLowerCase().trim()` in TypeScript when building the retailer lookup.

## Broad segment mapping
- `BRAND_TO_BROAD` hardcoded table covers all 23 known brand_canons in FY2025-26
- Keyword fallback handles future brands
- 17 canonical segments from `config/group_map.json` keys = the fixed denominator
- Denominator never changes dynamically — always 17

## FY constraint
- Closed FYs available: 2021-22 through 2025-26 (all have data in DB)
- Live FY (2026-27): no secondary register ingested — return `isLiveYear: true` immediately, no DB query
- Most recent closed FY = recentFy (2025-26 as of Jul 2026); priorFy = 2024-25

## Whitespace ranking
1. `range_depth`: brands missing in broad segments distributor already sells (easiest — shelf exists)
2. `lost_brand`: brand_canons in priorFy absent in recentFy (medium — relationship existed)
3. `peer_whitespace`: brands same-state-head peers sell but this one doesn't (named by peer)
Sorted: type order first, then peerNet desc within type. Cap at 12 hints.

## Verified smoke-test anchors (FY2025-26, Anant Singh / Prasun Chatterjee)
- Jagdamba Traders: 28 matched retailers · 15 brands · 10/17 broad segs · ₹79.2L NET
- Sumit Paint: 6 retailers · 2 brands · ₹9.2L NET · 12 whitespace hints
- Manoj Enterprises: 8 retailers · 2 brands · ₹7.0L NET · CPVC lost (₹4.92L prior FY)
