---
name: Growth Report WIDEN (state-head deepDive)
description: How the state-head WIDEN lever is sized and deduplicated in aiGrowthReport.ts
---

# Growth Report WIDEN — state-head (deepDive) branch

State-head scope sizes each distributor's brand gap vs the peer-median distinct-brand
count from the Sheets deep dive (`d.skuSpread.distinctBrands`):
`perCodeQuarterly = (medianNet / max(1, months/3)) / peerMedianBrands`;
`valueHigh = gapBrands × perCodeQuarterly × rangeUptake`; `valueLow = valueHigh/2`.
Pinned by `widenDeepDiveSizing` (exported) + `aiGrowthReport.widen.test.ts`.

**Rule: WIDEN must be deduplicated by entity NAME against CLOSE/RECOVER/ACTIVATE.**
**Why:** the state-head deep dive lists distributors under the SAME names sale_line
uses for customers, so an account claimed by a higher-precedence lever would be
double-counted. The growth-report guard's "no entity under multiple lever tags"
check fails otherwise. (Company/state SQL path is distributor-only, no overlap.)

**Numeric guard needs a code-generated ₹ figure in the narrative.** Claude's prose
is intentionally digit-free, so `guard.checked` was 0. Fix: append
`executiveSummary.deduplicationNote` (always carries ₹ Cr) to the guarded body and
add pre/postDedup totals to the guard payload allowlist.

**Cold-cache gotcha:** deep dive can return distributors with no skuSpread attached;
WIDEN then renders `notAvailable` even when real gaps exist. A warm/full load
produces entries. (Follow-up: guard should warm then assert WIDEN populated.)
