---
name: State-head Excel drill-down scope
description: Why reference-style state-head Reports 1 and 2 use direct historical head scope rather than the web comparison resolver.
---

Reference-style state-head Excel Reports 1 and 2 must apply the explicit state-head filter directly to both fiscal years. Keep this export behavior separate from the web report's intentional prior-year remapping through the current customer set.

**Why:** For Sandeep Dadheech, current-customer remapping reduced the prior April–August total to about ₹54.99 Cr, while direct historical `head_canon` scope produced the expected source-aligned total (about ₹61.60 Cr in the reviewed production snapshot). The uploaded workbook is an older or separately adjusted snapshot, so a remaining source variance is disclosed rather than fabricated away.

**How to apply:** Build the extra party/state/month datasets only for Excel export. Preserve existing web and Reports 3–7 comparison semantics. Keep live party dropdown output bounded per state and disclose any cap-based truncation.