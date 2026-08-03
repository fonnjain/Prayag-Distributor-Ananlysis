---
name: Warning B1 real-value architecture
description: How the "growth below price inflation" warning (family B) computes its inputs and its data-quirk gotchas
---

# Warning B1 — growth below price inflation

- Engine (`warnings/engine.ts`) only bands/formats; the route (`routes/warnings.ts`) computes the numbers because they need DB access.
- Nominal growth: recorded-months current OB vs prior-year same period, pro-rated from the Data tab's prior-year quarterly actuals (helper `priorYearSamePeriod`).
- **Prior-year quarters gotcha:** some FY Data tabs label them plain `Q1..Q4` (land in `kpis.extra`), not `Q1LASTYEAR` etc., so `kpis.lastYearQ1-4` are null. `priorYearQuarters()` in the route falls back to `extra.Q1..Q4` ONLY when they cross-foot against `extra.TOTALORDER<prior-fy-suffix>` within 1% (plain Q1 is ambiguous — could be current-FY quarters).
- Inflation: member's secondary segment mix (`computeSkuSpread`, brand_canon) → broad segment via `brandToBroad` (exported from distributorSkuSpread.ts, matches group_canon canonical names) → weighted per-category Laspeyres multipliers; unmatched share falls back to company multiplier.
- Real growth = ((1+g)/multiplier − 1); bands on real growth: Yellow <0, Orange <−5, Red <−10; skipped for partial tenure and cross-FY key splits.
- **Why:** nominal growth below segment price inflation means the member is shrinking in real terms and nothing else surfaces it.
- **How to apply:** any new YoY-based warning needs the same quarter-fallback and partial-tenure/key-split guards; snapshot key is versioned (`warnings|vN|`) — bump it on payload-logic changes and note the degraded-cold-build risk below.

## Cold-build degraded snapshots
Bumping the warnings snapshot key forces cold rebuilds; if a blocking request races the startup prewarm, Sheets 429 negative-caching can make an entire team read as J1 ("no working sheet") and that degraded payload gets PERSISTED and also cached in-process (10-min TTL — DB delete alone doesn't clear it). Recovery: delete the `route_payload_snapshot` rows, wait out the in-memory TTL/quota, then rebuild. The warnings route has no "only complete loads may overwrite snapshot" guard (distributor DD has one).

## Update (Aug 2026)
The plain Q1–Q4 fallback (with prior-FY TOTALORDER cross-foot) moved from routes/warnings.ts into deepDiveData.ts as `resolvePriorYearQuarters` + parse-time `applyPriorYearQuarterFallback`; kpis.lastYearQ1–Q4 are now populated at parse and on DB snapshot load, so all consumers (AI payload priorYears, warnings) see resolved values.
