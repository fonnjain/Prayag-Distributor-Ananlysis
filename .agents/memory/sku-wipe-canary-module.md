---
name: SKU wipe canary shared module
description: Architecture of skuCanary.ts — the shared module for secondary_sku_line ratio checks and frozen-but-empty detection, consumed by the audit engine, detection scheduler, and CI tests.
---

## The problem that prompted extraction
July-26 secondary data was never loaded into `secondary_sku_line`. `register_month_state` showed July-26 as frozen (primary data locked). Guard 3 in `context.ts` was using primary freeze state as a proxy for secondary completeness — a category error. Three false-positive S1 destocking alerts reached the live page before the next detection cycle cleared them.

## Module location
`artifacts/api-server/src/lib/redAlert/skuCanary.ts`

## What it exports
- `WIPE_CANARY_STATS_SQL` — per-(fy, month_label) row+distributor counts from `public.secondary_sku_line`
- `completedMonthLabels(fy, now)` — calendar-derived (NOT from register_month_state)
- `priorLikeMonth(label)` — "Apr-26" → "Apr-25"
- `priorFyOf` — re-export of `priorFy` from fyAnchors.ts
- `evalPerMonthRule` / `evalTotalRule` — pure rule evaluators (R1/R3, R2)
- `RULE1_ROWS_RATIO=0.6`, `RULE2_TOTAL_RATIO=0.7`, `RULE3_DIST_RATIO=0.7`
- `runFrozenButEmptyCheck(pool, fy)` — months frozen in register_month_state but absent from secondary_sku_line
- `runSkuWipeCanary(pool, openFy, priorFy, now)` — full ratio canary, structured result

## Consumers
1. **Audit engine Group 12** (`extraGroups.ts`) — runs server-side, checks production DB when deployed
2. **Alert detection scheduler** (`alertPersistence.ts`, `runAlertDetection`) — non-blocking try/catch after `persistAlerts`; logs WARN if frozen-but-empty months found
3. **CI integration test** (`aiGrowthReport.activation.test.ts`) — imports everything from here; logs `[wipe canary] environment: dev (CI)` in beforeAll

## Key design decisions
- **`CanaryPool` is non-generic** (`query(sql, params?) => Promise<{ rows: Record<string, unknown>[] }>`). Generic return type prevents test mocks from satisfying the interface without `as any`. Callers in skuCanary.ts cast rows with `as unknown as ConcreteType[]`.
- **`completedMonthLabels` is calendar-only**, never derived from register_month_state. The two tables are independent loading pipelines.
- **Frozen-but-empty check always runs** in Group 12 regardless of whether any months are completed. The ratio rules (R1-R3) skip gracefully when completedLabels is empty.
- **Non-blocking in the scheduler** — the frozen-but-empty check in `runAlertDetection` is wrapped in try/catch; errors log as WARN and do not abort detection.

**Why:** Canary logic previously lived only in the CI test file. Schedulers run only in production; detection was running on data the canary never checked. Dev had July-26 secondary rows; production had zero. A green CI canary implied coverage it didn't have.
