---
name: Engine Generated Targets (T1)
description: Conventions and traps for the target-engine module (Targets page → Engine Generated tab)
---

# Engine Generated Targets

- **Baseline is date-derived, never config**: baseline FY = prior of current FY from today's date; `?today=` on GET /api/target-engine simulates rollover (verified 1 Apr 2027 → baseline FY2026-27).
- **Multiplier pair convention**: per-segment price indices come from `computeCategoryMultipliers(baselineFy, fy)` / `computeCompanyMultiplier` — baseline→target-FY-to-date, same pair as the Customer Performance page. Reproduces spec figures (company ~1.071, CPVC ~1.006); small drift from the spec's printed values is expected because prices keep moving.
- **Override model**: `engine_targets` table stores ONLY user edits (rowKey namespaced `head:`/`member:`/`params`); the engine recomputes proposals on every GET and overlays edits, so edits survive regeneration by construction. Never persist engine outputs.
- **Weights split GROWTH, not total** — changing weights moves the three route targets but the grand target stays fixed. Validate sum=100 server-side.
- **Populations**: every customer×code pair is in exactly one — old SKU (bought), new SKU (customer active, code not bought = customers × distinct catalogue codes − bought pairs), new customers (zero baseline members by definition). Value reconciliation is territory pairs + project slice = total; only old SKU carries baseline value.
- **Member rollup fallback**: the distributor-TM map Drive folder can list 0 files; when unavailable, allocate each head's baseline to members pro-rata on Data-tab OB (fallback: sale) via `loadMemberTargetSnapshots` in deepDiveData. Members with neither stay unallocated and are named in zeroTargetReport.stillWithoutBaseline.
- **Zero-target basis**: "had a target" is judged from the State-HD Dashboard Data-tab snapshots; heads absent from the Data tab entirely (e.g. Mohanty, Anuj as of Aug 2026) can't be detected as moved — known dashboard limitation.
- **Auth posture**: write endpoints are unauthenticated like every other target-write route in the app (reviewed Aug 2026 — pre-existing architecture, not a regression). If the app ever gains auth, add these routes.
- New SKU tab reuses GET /api/sku/push-list (distributorKey = the `customer` field of /api/sku/distributors); New Customers tab points at the deep-dive whitespace — nothing recomputed.
