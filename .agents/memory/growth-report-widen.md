---
name: Growth Report secondary opportunity basis
description: Durable population, period, omission, and deduplication rules for WIDEN and ACTIVATE
---

# Growth Report WIDEN and ACTIVATE basis

**Rule:** WIDEN must monetize a secondary distributor range gap with median
positive signed secondary NET per distributor from the same eligible population,
FY, geography, and loaded period. ACTIVATE must monetize dormant secondary
retailers with median positive signed secondary NET per retailer from that same
retailer cohort and period.

**Why:** Mixing secondary counts with a primary-customer median materially
overstates both opportunities. Filtering positive rows before aggregation also
inflates NET by discarding returns and credit adjustments.

**How to apply:** Aggregate all signed rows first, then retain positive
distributor/retailer aggregates. Keep state-head WIDEN on its existing brand
vocabulary and company/state WIDEN on its existing segment vocabulary. Normalize
quarterly values using actual loaded-month coverage, not an assumed 12 months.

**Rule:** If the matched rows, peer group, median, or period coverage is missing,
emit null and omit the entity/lever from narrative ranking; never convert missing
basis into a numeric zero.

**Why:** Zero is a business result. Missing evidence is an availability state and
must not be included in totals or narrated as a calculated opportunity.

**How to apply:** Payload basis metadata must name population, entity, source,
period, and geography. Keep the half-to-full estimate range and assumptions
visible. Preserve precedence CLOSE > RECOVER > ACTIVATE > WIDEN and deduplicate
distributor names against higher-priority levers.
