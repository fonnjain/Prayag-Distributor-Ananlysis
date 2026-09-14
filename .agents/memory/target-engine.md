---
name: Engine Generated Targets
description: Durable model-separation, projection, and override rules for AI target proposals
---

# Engine Generated Targets

- **Baseline is date-derived, never config**: baseline FY = prior of current FY from today's date; `?today=` on GET /api/target-engine simulates rollover (verified 1 Apr 2027 → baseline FY2026-27).
- **Multiplier pair convention**: per-segment price indices come from `computeCategoryMultipliers(baselineFy, fy)` / `computeCompanyMultiplier` — baseline→target-FY-to-date, same pair as the Customer Performance page. Reproduces spec figures (company ~1.071, CPVC ~1.006); small drift from the spec's printed values is expected because prices keep moving.
- **Override model**: `engine_targets` table stores ONLY user edits (rowKey namespaced `head:`/`member:`/`params`); the engine recomputes proposals on every GET and overlays edits, so edits survive regeneration by construction. Never persist engine outputs.
- **Primary and secondary are separate**: primary growth proposals use company-dispatch actuals; Secondary People uses retailer-booking actuals. They are not comparable totals and must never be added.
- **Why:** The two engines model different commercial flows and populations; combining them would double-count unlike measures.
- **How to apply:** Keep proposals under AI Targets with explicit source labels; keep canonical/manual writes under Targets. An override remains a proposal until a separate acceptance path exists.
- **Open-FY context**: closed years are full-year actuals; the open year is complete-month actuals divided by the active seasonal-curve share and must be labelled projected with its basis.
- **Why:** A flat run rate materially understates this back-loaded business, while partial current-month rows distort both flat and like-month comparisons.
- **How to apply:** Exclude incomplete months, expose YTD and curve share, and recompute real growth from the resulting projected nominal growth.
- **Weights split GROWTH, not total** — changing weights moves the three route targets but the grand target stays fixed. Validate sum=100 server-side.
- **Populations**: every customer×code pair is in exactly one — old SKU (bought), new SKU (customer active, code not bought = customers × distinct catalogue codes − bought pairs), new customers (zero baseline members by definition). Value reconciliation is territory pairs + project slice = total; only old SKU carries baseline value.
- **Member rollup fallback**: the distributor-TM map Drive folder can list 0 files; when unavailable, allocate each head's baseline to members pro-rata on Data-tab OB (fallback: sale) via `loadMemberTargetSnapshots` in deepDiveData. Members with neither stay unallocated and are named in zeroTargetReport.stillWithoutBaseline.
- **Zero-target basis**: "had a target" is judged from the State-HD Dashboard Data-tab snapshots; heads absent from the Data tab entirely (e.g. Mohanty, Anuj as of Aug 2026) can't be detected as moved — known dashboard limitation.
- New SKU tab reuses GET /api/sku/push-list (distributorKey = the `customer` field of /api/sku/distributors); New Customers tab points at the deep-dive whitespace — nothing recomputed.
