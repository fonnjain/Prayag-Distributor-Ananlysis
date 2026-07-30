---
name: SKU Deep Dive K3 — Focus (recommendations engine)
description: Architecture for the K3 rule-based push list: ranked segments with top gap codes per segment.
---

## What it does
`GET /api/sku/recommendations` returns a ranked push list: segments ordered by `gapNet` descending, each with up to 8 top gap codes (codes NOT bought in the query period, ranked by historical same-period net across all loaded FYs).

## Key files
- `artifacts/api-server/src/lib/sku/skuRecommendations.ts` — `getSkuRecommendations()` function
- `artifacts/api-server/src/routes/sku.ts` — route added at bottom
- `artifacts/prayag/src/components/sku/SkuFocus.tsx` — segment card UI
- `artifacts/prayag/src/pages/SkuPage.tsx` — "Focus" tab, fetch effect, state

## SQL pattern
Two CTEs: `aggregated` groups gap codes by (segment, code) with SUM(amount) and MAX(fy); `seg_totals` computes per-segment gap_net and gap_count; `ranked` adds ROW_NUMBER() OVER (PARTITION BY segment ORDER BY prior_net DESC). Filter to rnk <= 8.

## Design decisions
- Rule-based, no AI — the sort is the recommendation.
- Priority = `gapNet` descending (territory-clean, same fiscal months).
- Same level filter / project exclusion as skuFacts.ts.
- `topGapCodes` limited to 8; overflow shown as "+ N more gap codes" link to drill.
- "Full drill →" button in each card navigates to the Drill section for that segment.
- `focusData` cleared on fy/level/period filter change (same as overviewData).
