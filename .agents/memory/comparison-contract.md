---
name: C1 Comparison contract layer
description: POST /api/comparison — selection schema, twelve guards, basis block; conventions for extending it
---

# C1 Comparison Deep Dive — contract layer

Module: `artifacts/api-server/src/lib/comparison/comparison.ts`; route `POST /api/comparison` (+ `GET /api/comparison/catalogue`). API only — UI is C2+.

## Conventions that must hold when extending
- **Every response carries a basis block** (basis, channel, population, normalise, periods with completeness, sources per measure) and a **full 12-guard report** — even blocked (422) responses fill unevaluated guards as `notApplicable`.
- **Completeness is derived from data + clock**, never config: distinct `month_label`s in `sale_line_current` (primary) or `secondary_register_line` (secondary) for the FY; `complete` needs every month present AND the period's last calendar month ended. `noActualsRecorded` cells say "not recorded yet".
- **Guard 2 rule that finally worked**: block when periods are in *different FYs* with *different fiscal-month shapes* (Q1 vs full FY), regardless of the quarter's own completeness. Same-FY different months is guard 3 (seasonal annotation), not a block.
- **Guard 12 anchors come from the frozen register itself** (`sum(amount) sale_line_current` per closed FY → ₹361.00 Cr for FY2025-26), NOT `verify_anchors.json` `primary_anchors.total` (that file says 361.14 — register-reconciliation figure, not the DB total).
- **Basis is bound to entity type, never a free choice**: company/segment/code/distributor = primary; member/head/retailer = secondary. A conflicting `basis` in the request is a 400 — otherwise the basis block would mislabel the figures.
- **Head `registerOb` must aggregate over member names** (register head_canon = member names); filtering on the head's own name silently returns 0.
- **Data-tab measures are FY-to-date only** (current FY). Historical/period-exact member OB uses `registerOb` from `secondary_register_line` where `lower(trim(head_canon)) = member display name` (register head names are member names).
- **Member/head measure spec names**: OB = orderBooking + directDealersOrder (I+J); achievement always recomputed (OB+DD)/totalTargetToDate; retailers has two named sources (`dataTabDeclared` BH vs `memberSheetRows`); mixing sources across entities → 422.
- Zero-target → value null + "no target recorded"; no target AND no business → "not recorded yet" + `excludeFromRanking: true` on the row. Head groups get `likeForLike` block (headline vs targeted-only achievement, untargeted named).
- Tenure guard: working-day ratio > 2× suppresses absolute `visits` (per-day stays). Correlation min sample = 5.
- Real terms: cross-FY money gets `real`/`realIndex`/`realIndexName` per cell — segment entities use their own Laspeyres, others company multiplier.

## Names useful for tests
Ambiguous: "Ashutosh Kumar" (Sandeep Dadheech/Dhanbad vs Anant Singh/Rudrapur). No-business member: Anuj Sharma (head **Sunil Mohanty** — Mohanty is a head, not a member). Tenure pair: Rahul Singh 11 days vs Amey Deodhar 77. Untargeted under Sulinder Pal: Ritesh Thakur, Arvind Kumar, Brinder Singh.
