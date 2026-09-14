---
name: Sales Deep Dive export contract
description: Durable business and auditability rules for the Sales Deep Dive Excel export.
---

The member-level Sales Deep Dive workbook has exactly ten ordered sheets and consumes the already-resolved page payload rather than performing independent source reads. Preserve value, genuine zero, and unavailable as distinct states.

The state-head workbook has a separate basis rule: with no date filter, its headline, like-for-like operands, and confirmed no-target population must come from the same resolved Team Summary shown on screen. With an explicit period filter, use authoritative monthly rows and require exactly one non-null row per selected month; missing or duplicate months make the affected figure unavailable.

Every percentage presented as an audited result must include its numerator and denominator. The workbook has exactly one recomputed cost-ratio KPI: YTD CTC plus YTD T.A. divided by sales received, with the denominator type stated explicitly. Raw source cost-ratio fields may be identified only as unverified metadata, never as KPIs.

Date of Joining must be stored as a genuine Excel date cell using `dd-mmm-yyyy`. Segment Spread intentionally uses the resolved `brand_canon` vocabulary because that source has no reliable item-code/six-master join.

**Why:** The prior export mixed source-calculated ratios, mislabeled period comparisons, and generic numeric formatting that rendered a joining-date serial as currency. Recomputing the default head summary from member target fields also erased confirmed no-target semantics, while loose period sums overstated incomplete months.

**How to apply:** Keep frontend and export field definitions shared, preserve source/status/reason columns, never compare partial current-period data with a prior full year, and export the complete dormant collection even when the UI shows a shorter list. Never turn unavailable member/month operands into zero when building head totals.