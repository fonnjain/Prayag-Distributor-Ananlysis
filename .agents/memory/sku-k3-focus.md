---
name: SKU Deep Dive K3 — Review + Push (recommendations engine)
description: Architecture for K3 (company-wide gap review) and K3b (per-distributor peer push list).
---

## Review tab (company-wide, renamed from "Focus")
Section key: `"focus"`. Tab label: "Review". Answers: "what has the whole territory stopped buying?"

`GET /api/sku/recommendations` — company-wide codes no distributor bought this period, ranked by historical same-period net. Source: `skuRecommendations.ts` → `getSkuRecommendations()`.

UI: `SkuFocus.tsx` (component name unchanged; tab label changed to "Review").

## Push tab (per-distributor peer cohort)
Section key: `"push"`. Tab label: "Push". Hidden for `level=retailer` or `level=project`.

### Two endpoints
- `GET /api/sku/distributors?fy=&level=` — returns 483 distributors with cohort quintile info (from `skuPushList.ts → getDistributorList`). Fetched eagerly on level/fy change.
- `GET /api/sku/push-list?fy=&level=&monthFrom=&monthTo=&distributorKey=` — per-distributor gap codes (from `getSkuPushList`).

### Cohort rules (non-negotiable, per user spec)
- `COHORT_FY = "2025-26"` — always last complete FY; open FY would be circular.
- `MIN_STATE_DISTRIBUTORS = 8` — if state has fewer, use national quintile instead.
- Quintile computed in JS (`quintileOf()`): quintile 1 (smallest 20%) to 5 (largest 20%). Peers = same quintile ±1.
- Project entities (`Non-territory / Project / Govt`) excluded from cohort.

### Recommendation rules
- `MIN_PEERS_PER_CODE = 3` — a code only shows if ≥3 segment-active peers buy it.
- "Segment-active" peer = peer with ≥1 purchase in that segment in the query period. Denominator per card is `segmentPeerCount`, not total cohort size.
- This prevents sanitaryware codes appearing on a pipe distributor's push list just because 3 peers of similar size happened to buy a single SW code.
- Suppressed (not recommended on thin evidence) when cohort size < 3 or target not in COHORT_FY.

### Card sentence
"X of Y peers in [state] buy this code and you do not."
For national fallback: "X of Y peers nationally buy this code..."

### Sorting
Segments sorted by `segmentPeerCount × totalGapCodes` descending — prioritises segments where most peers are active AND there are many gap codes.

### Verified output (Q1 FY2026-27, WAHID MARKETING WADI)
- State: Syed Aqil Rizvi, Q5/5, cohort 36, basis: state
- 13 segments with qualifying gap codes
- CP: 55 codes, 27 active peers; CPVC: 69 codes, 17 peers; PTMT: 40 codes, 28 peers

## Four-tier code ranking (Block 1)
Each gap code is classified before assembly; within each segment codes sort T1→T4 then peerCount DESC, capped at 10 (TOP_CODES_PER_SEGMENT).

| Tier | Label | Signal | Condition |
|---|---|---|---|
| 1 | Range | Fill sub-family range | code's `item_group` ∈ distributor's bought item_groups this period. Fires only when item_master covers the code (~49% coverage). |
| 2 | Lapsed | Reactivate dropped line | code in COHORT_FY purchase history but not current period |
| 3 | Active | Cross-sell within segment | distributor has any purchase in this `group_canon` this period |
| 4 | New | New category entry | none of the above |

`rankCode()` pure function in skuPushList.ts. `PushCode.tier` (1|2|3|4) + `PushCode.tierLabel` on every code. Frontend `TierBadge` uses emerald/amber/blue/slate colour scheme.

WAHID Q1 FY26-27 result: T1=72 (67%), T2=25 (23%), T3=4, T4=7 across 14 segments, 108 top codes (down from 234 raw).

item_master coverage note: only 1,716 of 3,509 codes in FY2026-27 have item_group. Tier 1 is sparse but correct; uncovered codes fall to T3/T4 based on segment activity.

## Key files
- `artifacts/api-server/src/lib/sku/skuPushList.ts`
- `artifacts/api-server/src/routes/sku.ts` (distributors + push-list routes)
- `artifacts/prayag/src/components/sku/SkuPushList.tsx`
- `artifacts/prayag/src/pages/SkuPage.tsx` (section="push", distributorList state, eager fetch)
