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

## Verified Gate 3 result (2026-07-19, with secondary_head_month populated)

All 7 rules PASS after loading all four state head dashboard FYs.
- R1: 4,223 rows verified — achievement_pct = received/plan (not ordered/plan)
- R2: 1,440 not_yet_recorded rows — all have null received_amount
- R3: 9,780 rows — is_anomaly consistent with isAnomalous() rule
- R4: is_territory not null in all 1,356,538 rows (2023-24/2024-25: 0 territory expected)
- R5: Δ=0 for every FY (exact cross-foot by head)
- R6: all four adjacent FY pairs have 12 complete months
- R7: no primary-layer rows in secondary table

## Key design decisions

**assertSecNoAnomalousAchievement is informational (passed=true).**
Secondary sales received can exceed orders booked in a month due to delivery lag
(pipeline from prior month). Unlike primary (where >1.5× is a parsing error),
secondary anomalies are expected and must not block ingest. The is_anomaly flag
marks these rows; R3 verifies the flag is consistent with the rule definition.

**ytdSum does NOT filter on isAnomaly (removed 2026-07-19).**
Anomalous months are INCLUDED in the YTD gross total — the received amount is
real money collected. Excluding them understated secondary YTD by 9–24% per FY
(FY2025-26: ₹20.4 Cr, 9.2%; FY2023-24: ₹33.9 Cr, 24.3%).
The anomaly flag only suppresses rankings and per-member achievement display.

**notYetRecorded rows must store null amounts (not zero).**
The source sheet pre-fills explicit zeros for future months. cellNum returns 0
for those cells. dashboardToHeadMonthRows nulls out plan/ordered/received/
achievement when notYetRecorded=true so the DB never shows a false "confirmed ₹0"
for months not yet closed. Re-upsert updates these to real values when months close.
