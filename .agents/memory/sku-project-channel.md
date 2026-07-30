---
name: SKU Deep Dive — project channel separation
description: Architecture for separating Non-territory / Project / Govt from territory channels in all SKU breadth and gap computations.
---

## Rule
`Non-territory / Project / Govt` head_canon is the project channel identifier. It must be excluded from every territory-channel gap, breadth denominator, and recommendation computation.

**Why:** All five FY2023-24 Q1 HDPE buyers had party_type='HDPE PIPE' and head_canon='Non-territory / Project / Govt'. They were infrastructure companies executing civil projects — not territory distributors. Their ₹25 Cr Q1 contributed 100% of HDPE's gap codes' net, making HDPE falsely appear as the top territory opportunity. The cliff was confirmed as project project churn, not market loss.

## Implementation
- `PROJECT_HEAD_CANON` constant exported from `catalogue.ts`
- Three ever-sold maps: `getEverSoldPerSegment()` (global/retailer), `getEverSoldPerSegmentTerritory()` (excludes project), `getEverSoldPerSegmentProject()` (only project)
- `SkuLevel` now includes `"project"` as a first-class channel
- `levelFilter` in `getPrimarySkuFacts` and `getSkuTrend`: territory levels append `AND (sl.head_canon IS NULL OR sl.head_canon != PROJECT_HEAD_CANON)`; project level uses `AND sl.head_canon = PROJECT_HEAD_CANON`
- `buildFactsFromRows` accepts optional `everSoldOverride` map; callers pass the level-appropriate map
- Route `VALID_LEVELS` includes `"project"`

## How to apply
Any new analytics query in the SKU Deep Dive that touches `sale_line_current` must apply this same exclusion for territory channels. The pattern is consistent across `skuFacts.ts`, `skuRecommendations.ts`, and the trend queries — always use the `projectHeadFilter` fragment for territory, and `PROJECT_HEAD_CANON` directly for project level.

## Segment contamination (Q1, distributor channel)
Segments with >10% project-attributed gap codes' net (before fix):
- HDPE: 100% — now correctly shows ₹0.01 Cr territory gap (vs ₹32.65 Cr before)
- PTMT / Faucets: 83.7%
- Hardware: 57.7%
- CP (Chrome-Plated): 45.3%
- CPVC: 44.6%
- Sanitaryware: 26.3%
AGRI and SWR were clean (< 5%).
