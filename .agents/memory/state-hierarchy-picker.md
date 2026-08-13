---
name: State Hierarchy Picker
description: Two-level state_canon→parent hierarchy; DB table, route, and frontend picker architecture; why server-side expansion was removed.
---

# State Hierarchy Picker

## The rule
The `state_hierarchy` table (migration 025) maps every `state_canon` DB value to a
`state_parent` display name, `is_split` flag, `picker_visible` flag, and `display_order`.

**Frontend sends leaf values only.** Selecting "Delhi" (parent) → frontend sends
`["DELHI A", "DELHI NCR"]`. Server never expands. `stateVariantsFromArray` in
`analytics.ts` was removed; the `states` param is used verbatim.

**Why:** The old `stateVariantsFromArray` was a workaround for a flat picker that
didn't know the splits. The new picker always sends the full leaf set, so expansion
would double-count nothing — but it did silently include canonical names that don't
exist in the DB (e.g. "DELHI"), returning zero rows for parent selections.

## Structure (37 rows)
- 7 split groups (13 split state_canon values, `is_split=true`, `picker_visible=true`):
  Delhi (DELHI A / DELHI NCR), UP (UTTAR PRADESH / UP ( A ) / UP (AS)),
  Karnataka (KARNATAKA / KARNATAKA (B)), J&K (JAMMU / KASHMIR),
  Rajasthan (RAJASTHAN / RAJASTHAN (N)), Tamil Nadu (TAMIL NADU / TAMILNADU (S)),
  Andhra Pradesh (AP — single-member split)
- 19 geographic non-splits (`is_split=false`, `picker_visible=true`): parent = self
- 4 non-geographic channel codes (`picker_visible=false`): GEM, JJM, HITESH,
  Non-territory / Project / Govt

## Key files
- `lib/db/src/runMigrations.ts` — migration 025_state_hierarchy
- `artifacts/api-server/src/routes/stateHierarchy.ts` — GET /api/state-hierarchy?fy=
- `artifacts/api-server/src/lib/stateCanon.ts` — added RAJASTHAN (N) and TAMILNADU (S)
- `artifacts/prayag/src/components/ui/StateFilter.tsx` — hierarchical picker component;
  module-level singleton cache; exports REGION_GROUPS (updated to DB leaf values) + ALL_STATES
- CompanyReportFilters.tsx, CompanyReports.tsx, DistributorDeepDive.tsx — callers

## REGION_GROUPS update
Now uses actual DB state_canon leaf values (e.g. "DELHI A", "UP ( A )"), not canonical
names. This fixes the region mode in DistributorDeepDive where `geoStates.has(s)` was
silently missing split rows (e.g. "DELHI" !== "DELHI A").

## Verification anchors (run after any filter change)
- `SELECT COUNT(*) FROM state_hierarchy` → 37
- FY25-26: `SUM(amount)/1e7 → 360.9954, COUNT(*) → 145613` from `sale_line WHERE fy='2025-26'`
- Split arithmetic: for every `state_parent` with `is_split=true`, sum of children nets
  equals the parent subtotal at the rupee level.
