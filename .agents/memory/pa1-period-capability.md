---
name: PA1 period capability system
description: Architecture of the period-capability indicator that prevents FY_ONLY pages from silently accepting month/quarter selections.
---

# PA1 Period Capability System

## The rule
All pages declare their capability in `artifacts/prayag/src/data/period-capability.ts`. Undeclared pages default to NONE. When promoting a page from FY_ONLY → FULL, edit that file only.

## Capability levels
- `FULL` — state-head, primary-performance, secondary-performance, combined
- `FY_ONLY` — overview, regional, resources, products, momentum, growth, pending, sources, reports, analyst, ai-reports, company-reports, salespeople, deep-dive, distributor-deep-dive
- `NONE` — warnings, targets, data-health

## Architecture
- `period-capability.ts` — single source of truth; exports `PeriodCapability` type, `PAGE_CAPABILITIES` map, `getCapabilityForPath(pathname)`
- `global-filter-context.tsx` — calls `useLocation()` to derive `periodCapability`; exposes it on the context value. **Requires GlobalFilterProvider to be inside WouterRouter** (App.tsx changed to move it inward).
- `GlobalFilterBar.tsx` — reads `periodCapability` from context; renders three distinct modes (NONE: note only, FY_ONLY: FY selector + reason note, FULL: all controls)
- Dashboard.tsx — removed manual `hideFilterBar` logic; always renders `<GlobalFilterBar />`

## I/J cross-check (stateDashboard.ts)
Excel columns I (cols.monthlyTarget) and J (cols.totalDealers) are the only non-#REF! cells in the SOBR TOTAL row. Added cross-check after the OB/Sales reconciliation block: sums membermonthlyTarget and totalDealers across all 162 members and compares to TOTAL row values. Passes on FY 2026-27 (colI = 349,220,283 verified). The OB/Sales cross-check is still blocked by #REF! errors at cols 12 and 14 — sheet repair required (Task #32).

**Why:** Provides structural integrity confirmation (all member rows read) even when the OB/Sales formula errors block the primary cross-check.
