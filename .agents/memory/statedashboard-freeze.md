---
name: stateDashboard closed-FY cache freeze
description: How closed-FY cache permanence works in stateDashboard.ts and why the FY2025-26 register Sheets gap cannot be closed via the backfill route.
---

## Closed-FY cache freeze (stateDashboard.ts)

`currentFy()` derives today's FY (Apr boundary). `isClosedFy(fy)` returns true when `fyStartYear(fy) < fyStartYear(currentFy())`.

Both `getCachedStateDashboard` and `loadStateDashboard` skip the 15-min TTL for closed FYs — the first Sheets read is cached for the process lifetime. This prevents FY2025-26 figures from drifting on every 15-min expiry.

**Why:** Without this, the STATE HEAD DASHBOARD for FY2025-26 (a closed year whose sheet may still be edited) was re-read every 15 minutes, producing a fluctuating total that differed from the DB anchor.

**How to apply:** Any FY whose start year < current FY start year gets permanent cache. If a closed FY figure must be force-refreshed, call `invalidateStateDashboardCache(fy)` and trigger a fresh load — the new value will then be held permanently again.

## YTD achievement numerator/denominator symmetry

`ytdSalesSum` must accumulate for ALL members (including `isLeft`). The denominator (`ytdPlanSum`) already covers all members. Any guard like `if (!m.isLeft) ytdSalesSum += ...` produces an asymmetric ratio that over-states achievement.

**Why:** Left-section members spent part of the FY contributing real sales. Their plan was in the denominator; excluding their sales from the numerator deflated the denominator share of the achievement ratio.

## FY2025-26 sale_line register gap (1,290 rows)

All 144,367 FY2025-26 rows in `sale_line` have `source = 'xlsx_backfill'`. The Sheets register at `1Xzq-gmB6K7iuMcE6gb-O7OpvGgSDU33DzEVyK60LK6E` returns 0 usable rows via `POST /api/verify/backfill?fy=2025-26` (rowsRead=0, inserted=0).

FY2024-25 Sheets path is healthy (145,781 rows read), so the infrastructure works. The FY2025-26 register Sheets file is either empty or its rows fail the `line.fy !== fy` filter (FY column in sheet may contain "2024-25").

**Recovery:** Requires the original FY2025-26 register xlsx file re-run through `pnpm --filter @workspace/api-server run backfill -- --file <register.xlsx> --fy 2025-26`.
