---
name: sale_line state_canon normalisation
description: Explicit map of split territory state_canon variants to canonical geographic state names; shared module; all five audit gaps now fixed.
---

## Shared module (single source of truth)

`artifacts/api-server/src/lib/stateCanon.ts`
Exports: `STATE_CANON_NORMALISE`, `normaliseStateCanon()`, `stateVariants()`, `stateVariantsFromArray()`.
All consumers import from here — no local copies.

## The map

```
"DELHI A"        → "DELHI"
"DELHI NCR"      → "DELHI"
"UP ( A )"       → "UTTAR PRADESH"
"UP (AS)"        → "UTTAR PRADESH"
"UP (S)"         → "UTTAR PRADESH"
"HP"             → "HIMACHAL PRADESH"
"KARNATAKA (B)"  → "KARNATAKA"
```

`normaliseStateCanon(raw)` — canonical display name.
`stateVariants(raw)` — all raw DB values for the same geographic state; use for `ANY(ARRAY[...])` SQL filters.
`stateVariantsFromArray(states)` — expand a user-supplied filter array to all DB variants; pass result directly as the `$n::text[]` parameter.

## FY2026-27 distributor counts per split family

| Canonical | Raw variants (count) | Combined | Crosses tier-1 (≥8)? |
|---|---|---|---|
| DELHI | DELHI A (7) + DELHI NCR (3) | 10 | ✓ |
| UTTAR PRADESH | UTTAR PRADESH (58) + UP ( A ) (9) + UP (AS) (7) + UP (S) (0) | 74 | ✓ |
| KARNATAKA | KARNATAKA (0 this FY) + KARNATAKA (B) (4) | 4 | ✗ |
| HIMACHAL PRADESH | HIMACHAL PRADESH (12) + HP (0 this FY) | 12 | ✓ |

## Fixed locations (closing-pass block 2 — 2026-07-30)

1. **`customers/analytics.ts`** — `listCustomers()` calls `stateVariantsFromArray(rawStates)` before passing to SQL. Verified: "DELHI" filter returns rows from DELHI A + DELHI NCR (16 rows).
2. **`companyReports.ts`** — local `normStateExpr()` CASE WHEN replaces all 6 `coalesce(stateCanon, 'Unmapped')` calls. Verified Report 1 labels: DELHI, UTTAR PRADESH, HIMACHAL PRADESH, KARNATAKA — no splits.
3. **`StateFilter.tsx`** — REGION_GROUPS collapsed to canonical names only; `toCanonical()` normalises incoming `selected` for legacy URL state backward-compat.
4. **`customerMaster.ts` routes** — both GET /customer-master and /export use `stateVariants(state)` + `inArray()`.
5. **`audit/extraGroups.ts`** — `inArray(saleLines.stateCanon, stateVariants(anchor.filters.state))` replaces bare `eq`.

## Vocabulary mismatch: dashboard vs sale_line

Dashboard column B (SOBR) uses different names from `sale_line.state_canon`:
- Dashboard: "Delhi" → sale_line: "DELHI A" or "DELHI NCR"
- Do NOT conflate the two lists. This map concerns only sale_line values.

## Maharashtra 2

Does NOT exist in the data. Add to the map if/when a split variant appears.

**Why:** Sales-management territory splits create artificial sub-state groupings.
For geographic tier-1 pool sizing and any state-level analytics, all variants of
the same state must be pooled together or a 7-distributor half-state incorrectly
routes to territory (tier 2) and reports show split rows instead of one.

**How to apply:** Any code that filters `state_canon =` for geographic purposes
must call `stateVariants()` and use `inArray()` or `ANY(ARRAY[...])` instead of equality.
Quintile computation groups by `head_canon` (territory), not `state_canon` — unaffected.
