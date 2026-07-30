---
name: sale_line state_canon normalisation
description: Explicit map of split territory state_canon variants to canonical geographic state names; vocabulary mismatch between dashboard and sale_line; confirmed splits as of FY2026-27.
---

## The map (in `skuPushList.ts` → `STATE_CANON_NORMALISE`)

```
"DELHI A"        → "DELHI"
"DELHI NCR"      → "DELHI"
"UP ( A )"       → "UTTAR PRADESH"
"UP (AS)"        → "UTTAR PRADESH"
"UP (S)"         → "UTTAR PRADESH"
"HP"             → "HIMACHAL PRADESH"
"KARNATAKA (B)"  → "KARNATAKA"
```

`normaliseStateCanon(raw)` returns the canonical name.  
`stateVariants(raw)` returns all DB values that map to the same canonical — used to build `state_canon = ANY(ARRAY[...])` SQL filters so a tier-1 pool spans all split variants.

## FY2026-27 distributor counts per split family

| Canonical | Raw variants (count) | Combined | Crosses tier-1 (≥8)? |
|---|---|---|---|
| DELHI | DELHI A (7) + DELHI NCR (3) | 10 | ✓ |
| UTTAR PRADESH | UTTAR PRADESH (58) + UP ( A ) (9) + UP (AS) (7) + UP (S) (0) | 74 | ✓ |
| KARNATAKA | KARNATAKA (0 this FY) + KARNATAKA (B) (4) | 4 | ✗ |
| HIMACHAL PRADESH | HIMACHAL PRADESH (12) + HP (0 this FY) | 12 | ✓ |

## Tier-2 → tier-1 movers (new distributors, FY2026-27)

11 distributors total:
- DELHI A: 2 new dists (TANEJA HARDWARE & ELECTRICALS, TANEJA TRADERS)
- DELHI NCR: 2 new dists (HYDURE PIPE FITTING COMPANY, JULUCK ENTERPRISES)
- UP (AS): 7 new dists (all 7 are new — UP (AS) only appeared in FY2026-27)

## Vocabulary mismatch: dashboard vs sale_line

Dashboard column B (SOBR) uses different names from `sale_line.state_canon`:
- Dashboard: "Delhi" → sale_line: "DELHI A" or "DELHI NCR"
- Neither is wrong. This map concerns only sale_line values.
- Do NOT conflate the two lists.

## Maharashtra 2

Does NOT exist in the data. Maharashtra is undivided at 28 distributors (FY26-27),
63 across all FYs. Add to the map if/when a split variant appears.

**Why:** Sales-management territory splits create artificial sub-state groupings.
For geographic tier-1 pool sizing, all variants of the same state must be pooled
together, or a 7-distributor half-state falls below the 8-dist threshold and
incorrectly routes to territory (tier 2) instead of state (tier 1).

**How to apply:** Any code that filters `state_canon =` for geographic pooling
should call `stateVariants()` and use `ANY(ARRAY[...])` instead of equality.
Quintile computation in the normal (cohort) path groups by `head_canon` (territory),
not `state_canon`, so it is unaffected.
