---
name: aiGrowthReport ACTIVATE/WIDEN merge corruption
description: Recurring bad-merge pattern that pastes SQL-branch variables into the deepDive branches of the Growth Report route.
---
Task merges have twice re-corrupted the ACTIVATE/WIDEN deepDive branches of the Growth Report route by pasting the SQL-path body (`r.retailer_count`, `gap * perCodeQuarterly`) into the Sheets deepDive loops, producing undefined `r`/`gap`/`perCodeQuarterly` and even dropped loop headers.

**Why:** the two branches are near-identical textually, so 3-way merges resolve them into each other.

**How to apply:** after any merge touching aiGrowthReport.ts, run api-server typecheck; correct deepDive forms are `d.retailerCount`/`d.activeCount`, `dormant * quarterlyMedian * dormantRevival` (ACTIVATE) and a `for (const d of ...)` loop with `perCodeQuarterlyDd` (WIDEN).
