---
name: SKU head scope across levels (SD5)
description: How state-head scoping works per SKU level; retailer level needs head→member resolution; seasonality/push-list caveats.
---

# SKU Deep Dive head scoping (learned during Rizvi SD5)

- `secondary_sku_line.head_canon` holds MEMBER (salesperson) names lowercased with collapsed whitespace — never state heads. A retailer-level `scope=head` query must expand the head to their roster members first.
  - Implemented: `resolveHeadForSecondary(fy, head)` in `skuFacts.ts` — roster from `loadDeepDiveData(fy, head, undefined, {skipExtras:true})`, matched exact then parenthetical-stripped against the register's distinct head_canon vocabulary. `/api/sku/facts` returns `memberResolution` (membersTotal / membersMatched / unmatchedMembers).
  - PS-code vocabulary mismatch is expected and surfaced, never silent (Rizvi 28/32, Sandeep 56/74, Anant 13/13 in FY2026-27 Q1).
- Roster load can fail transiently on Sheets 429 right after a server restart (warm-up exhausts quota; 60s negative cache). Resolution then degrades to null → retailer facts return empty. Retry after ~60s.
- `sale_line` head/state attribution exists ONLY for FY2023-24 and FY2026-27; FY2024-25/25-26 rows have NULL head_canon AND state_canon.
  - **Consequence 1:** push-list COHORT_FY (2025-26) grouping by headCanon lumps everyone into one head-less "state" cohort (~286 peers, quintile ±1) — pre-existing for all heads, left unchanged; `peerNames` now returned so the cohort is at least inspectable.
  - **Consequence 2:** head-scoped seasonality (`/api/sku/seasonality?channel=territory&head=…`) draws on FY2023-24 only, so `yearsConsistent` maxes at 1 — single-year evidence, label it as such.
- `secondary_sku_line.segment_canon` is NULL for ~96% of rows in every FY (segment_raw vocabulary like "P.T.M.T. SYMET" unmapped in group_map.json) — retailer-level segment views are dominated by "Unmapped"; pre-existing, all FYs, all heads.
- Direct-dealer level: `type_raw ILIKE '%direct%'` matches ZERO rows in every FY of sale_line — the level is structurally NOT_AVAILABLE with a reason; not a per-head bug.
