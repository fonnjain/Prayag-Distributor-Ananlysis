---
name: Secondary Gate 3 architecture
description: Post-commit calculation verification gate for secondary register pipeline — structure, rule mapping, and operational notes.
---

## Rule → file mapping

| Rule | Pure check fn (gate3.ts) | Input shape | Queries |
|------|--------------------------|-------------|---------|
| R1 achievement_recomputed | checkR1AchievementRecomputed | HeadMonthRow[] | secondary_head_month |
| R2 ytd_closed_months_only | checkR2YtdClosedMonthsOnly | HeadMonthRow[] | secondary_head_month |
| R3 anomaly_flag_consistent | checkR3AnomalyFlagConsistent | HeadMonthRow[] | secondary_head_month |
| R4 territory_split_populated | checkR4TerritorySplitPopulated | FyTerritoryStats[] | COUNT by is_territory |
| R5 grand_total_cross_foot | checkR5CrossFootByHead | FyHeadGross[] | SUM by head_bucket + SUM total |
| R6 complete_months_yoy | checkR6CompleteMonthsYoY | FyMonthData[] | DISTINCT month_label |
| R7 no_double_count_guard | checkR7NoDoubleCount | SourceCount[] | GROUP BY source |

## File locations

- `artifacts/api-server/src/lib/secondary/gate3.ts` — pure types + check functions
- `artifacts/api-server/src/lib/secondary/gate3Runner.ts` — DB queries (SQL aggregations, never full row loads) + calls gate3.ts
- `artifacts/api-server/src/secondary-gate3.ts` — CLI entry point

## CLI usage

```
pnpm --filter @workspace/api-server run secondary-gate3
```

Exits 0 on PASS, 1 on FAIL.

## Operational notes

**R1/R2/R3 require `secondary_head_month` populated.**
These rules apply to the state head dashboard data. The table is populated by running:
```
pnpm --filter @workspace/api-server run secondary-backfill -- --source state-head-dashboard --commit
```
Until then, all three checks pass with a "no rows to verify" note.

**R4 expects 0 territory rows for FY2023-24 and FY2024-25.**
These FYs use subtotal grain (pre-aggregated rows, not individual customer lines). The territory flag cannot be determined from pre-aggregated source data — all rows are correctly classified as non-territory. The R4 check notes this explicitly in its detail string.

**R5 cross-foot uses head_bucket routing (not head_canon alone).**
Rows with `head_canon IS NULL` but non-blank `head_raw` go into "(unmapped)". Rows with both null go into "(blank)". This guarantees the cross-foot is always arithmetically closed regardless of TM mapping coverage — the unmapped_heads_empty validator separately reports which raw names need mapping.

**Why aggregated inputs, not raw rows:**
Loading all 1.36M secondary_register_line rows into Node.js memory for R4/R5/R6/R7 would be slow and wasteful. gate3Runner.ts does the aggregations in Postgres (GROUP BY, COUNT, SUM) and passes compact result sets to the pure check functions. This keeps Gate 3 fast even as the register grows.

## Verified Gate 3 result (2026-07-19)

All 7 rules PASS. Five frozen FYs (2021-22 through 2025-26), 1,356,538 rows, source='sheets' throughout.
- R5 Δ=0 for every FY (exact cross-foot)
- R6: all four adjacent FY pairs have 12 complete months
- R7: no primary-layer rows in secondary table
