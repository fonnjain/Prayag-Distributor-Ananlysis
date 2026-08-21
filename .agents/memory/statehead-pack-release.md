---
name: State Head pack release
description: Rules for safely assembling State Heads folder workbooks into a reconciled master pack.
---

Temporary copies and legacy feeder workbooks must be represented in an audit manifest, not silently included in folder totals. A canonical filename may establish identity only when its row label resolves through the person registry; competing canonical candidates need a manifest-level conflict, while unknown, mixed, and non-territory files require an explicit approved mapping. Released totals must compare to the matching territorial primary-register scope, including missing material heads. A workbook's FY label is never sufficient on its own: raw transaction dates must sit within that FY, and rows later than the review date must be reported separately.

**Why:** Folder-level sums can double-count copied workbooks and can misattribute departed or project feeders while still looking numerically plausible. FY2025-26 State Head workbooks also carried FY-labelled lines dated in FY2026-27, so large date leaks can cancel unrelated scope gaps and create a false reconciliation.

**How to apply:** Preserve file IDs, Report 1 totals, mappings, exclusions, raw-date/FY mismatch totals and ranges, future-dated totals, and material per-head discrepancies in the read-only release output. Treat unresolved feeder evidence or any material date/FY mismatch as a release blocker until explicitly approved.