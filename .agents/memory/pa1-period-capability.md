---
name: PA1 period capability + YTD split
description: isFyClosed guard for closed-FY YTD + primary vs secondary period upper bound
---

## Rule
`effectivePeriodTo` (secondary) ≠ `effectivePrimaryPeriodTo` (primary) on open-FY YTD.

- **Open FY YTD** → secondary `to = lastCompleteIdx + 1`; primary `to = currentIdx + 1`
- **Closed FY YTD** → both `to = 12` (full year; `isFyClosed()` returns true when today ≥ 1 Apr of fyStart+1)
- **All other modes** → `effectivePrimaryPeriodTo === effectivePeriodTo`

**Why:** sale_line and Order Sheet accumulate continuously through the current month. Secondary records actuals at month-end only. Using one shared `effectivePeriodTo` (last complete month) silently truncates live primary data. Closed FYs must not use calendar-day helpers (`isFyClosed`) or the YTD/last7/today modes return partial ranges on historical data.

## How to apply
- `isFyClosed(fy)` + `effectivePrimaryPeriodTo` are exported from `global-filter-context.tsx`
- Components reading primary data (sale_line, Order Sheet): use `effectivePrimaryPeriodTo`
- Components reading secondary data: use `effectivePeriodTo`
- `GlobalFilterBar`: hide "Last 7 days" and "Today" pills when `isFyClosed(fy)` is true

## Which components consume which
| Component | Period upper bound |
|---|---|
| `StateHeadDashboard` (primary section) | `effectivePrimaryPeriodTo` (via `primaryMonthTo = effectivePrimaryPeriodTo`) |
| `PrimaryPerformanceDashboard` | `effectivePrimaryPeriodTo` |
| `StateHeadDashboard` (secondary section) | `effectivePeriodTo` |
| `SecondaryPerformanceDashboard` | `effectivePeriodTo` |
