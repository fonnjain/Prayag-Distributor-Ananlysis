---
name: Distributor Deep Dive tabs + vocabulary recon
description: Architecture and identity rules for the Secondary Sales / SKU Evolution / Push tabs and the sheet-vs-register distributor reconciliation.
---

# Distributor tabs + recon (lib/mgmt/distributorTabs.ts, routes /api/mgmt/distributor-recon and /distributor-tab)

## Identity rule (user-binding, Aug 2026)
- Two vocabularies: member working sheets (~190 distributors, also used by `secondary_sku_line.distributor` — 96%+ direct normDistKey match) vs primary register `sale_line` customer names (~513 in FY26-27).
- Match = exact normDistKey, OR location-suffix-stripped normDistKey **with a known geographic state that agrees** (suffix-stripped matches must have `hasGeoState`; exact-norm matches may treat missing/NON-* state as "no disproof").
- **Never merge on spelling similarity** — similar pairs go to a "needs confirmation" list with both sides' state/district/value; pairs where BOTH transact in the same months are auto-flagged RESOLVED-DIFFERENT.
- FY26-27 result: 118 names ↔ 118 sheet distributors = 65.5% of territory value; the ~34.5% unattributed share must be a prominent banner on every joined figure, never a footnote.

## Durable gotchas
- **Every primary-side aggregate must filter `is_territory = true`** (recon values, flow-gap primary-in, push largest-customer pick); a customer with one territory row would otherwise leak institutional value into flow gaps and verdicts.
- Baseline-FY name mapping must NOT call buildDistributorRecon(priorFy) — that builds a prior-FY directory (full Sheets pass, minutes). Use the lightweight `mapRegisterNamesForKey` against the CURRENT directory's sheet vocabulary.
- `computeCategoryMultipliers` returns a Map, not an object.
- `NoneAssignedSummary` has no per-district data; unassigned-retailer coverage is reported per serving member from `perMember` rows.
- Flow-gap language must always state both readings (stock building OR business outside the attributed channel); verdict CLEAR_STOCK_FIRST when primary-in ≥ ₹5L and flow-through <50%.
- SKU existing/new/lost classifier (`classifySkuPopulations`) is the single shared definition, applied to both registers with like-months prior-FY baseline; growth shares are signed and can exceed 100%.
- Frontend: tabs live in DistributorTabsPanel.tsx; DistributorDeepDive.tsx wraps overview content in a `display:contents`/`hidden` div keyed on the tab.
