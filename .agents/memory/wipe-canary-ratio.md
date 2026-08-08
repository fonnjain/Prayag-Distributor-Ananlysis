---
name: Ratio-based open-FY wipe canary
description: Design of the secondary_sku_line wipe canary in the activation guard test — live prior-FY denominators, three rules, no static floors.
---

The activation guard test (aiGrowthReport.activation.test.ts) contains an open-FY wipe canary with three rules, all against LIVE prior-FY like-month denominators (never hardcoded counts):
- Rule 1: per completed month, open-FY rows ≥ 0.60 × prior like-month rows
- Rule 2: sum over completed months ≥ 0.70 × prior like-month total
- Rule 3: per completed month, distinct distributors ≥ 0.70 × prior like-month

**Why:** static floors (10k rows / 40 distributors) once let a partial wipe pass; ratio floors track real seasonality and scale automatically each FY. A negative simulation test (zero one month in a copy, no DB mutation) proves the Rule 1+3 fail / Rule 2 pass asymmetry — single-month wipes hide inside totals, so per-month rules are the real defense.

**How to apply:** evaluators are exported pure functions; denominator query is WIPE_CANARY_STATS_SQL. Zero prior denominator → rule skipped with a console.warn, never a silent pass. Granularity limit: secondary_sku_line has no order-date column, so within-month partial wipes are invisible to the test — the ingest replace path is the place for a stricter pre-delete guard. MIN_FULL_INGEST_ROWS is derived (half the largest FY), not a constant.
