---
name: stateDashboard ytdSales null-gate pattern
description: ytdSalesReceived must never be gated on ytdHasData/plan; gross total and achievement ratio are separate computations.
---

## The rule

In `stateDashboard.ts`, **gross total** and **achievement ratio** are separate:

- **Gross total** (`totalSalesReceived`) = `allMonthsSalesReceived` — every member, every month, no filters.
- **Achievement ratio** (`ytdAchievement`) = `ytdSalesSum / ytdPlanSum`:
  - `ytdSalesSum` = SUM of `ytdSalesReceived` for all **non-left** members (`ytdSalesReceived ?? 0`)
  - `ytdPlanSum` = SUM of `ytdPlan` for non-left members **who have a plan** (`if (m.ytdPlan != null)`)

Never gate `ytdSalesReceived` on `ytdHasData` (plan presence) — that silently removes real sales from members who have received amounts but no plan. The correct expression:

```typescript
ytdSalesReceived: ytdSales > 0 ? ytdSales : (ytdHasData ? 0 : null),
```

And at the company accumulation:
```typescript
ytdSalesSum += m.ytdSalesReceived ?? 0;  // NOT: if (m.ytdSalesReceived != null) ...
```

**Why:** Members with `plan_amount = 0` (departed/unplanned) still have real closed-month sales. Gating the accumulation on plan presence was the same structural error as the `!isAnomaly` filter bug — a flag meant for display/ranking silently suppressed values from company totals.

**How to apply:** Any time a per-member field is accumulated into a company-level sum, ask: "Does a null here represent 'no data' (correct to skip) or 'hidden data' (wrong to skip)?" For `ytdSalesReceived`, null means truly inactive (no plan AND no sales) — contribute 0.

## FY2025-26 data context

- 844 rows with `plan_amount = 0` (10+ members with all 12 months at zero plan), 60 with `plan_amount IS NULL`.
- These 904 closed rows hold ₹15.54 Cr received that was excluded from `ytdSalesSum` before the fix.
- `isLeft` members (81 in FY2025-26) are correctly excluded from `ytdAchievement` by the `if (!m.isLeft)` guard — this is separate from the plan-null gate bug.

## FY2024-25 row count

- DB: 2,724 rows = 227 members × 12 months.
- Loader `rowsRead` = 2,748 (229 sheet rows). Two members had name variants that normalized to the same `head_canon`; the upsert merged each pair. No data lost.
