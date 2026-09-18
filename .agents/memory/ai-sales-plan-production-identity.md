---
name: AI Sales Plan production identity prerequisite
description: Data-readiness requirement for accepting retailer-specific AI Sales Plan tabs in production.
---

Retailer-specific AI Sales Plan tabs require production `secondary_sku_line`
rows to carry stable RET# and DIST# identity. Do not treat working source code,
development fixtures, or the frozen state-versus-India tab as evidence that
the retailer tabs are usable in production.

**Why:** On 18 September 2026 the production population had substantial
FY2025–26 and FY2026–27 row counts but no populated retailer or distributor
stable IDs, so the selector returned no retailers and STOPPED, limited-history,
peer-size, and sub-five-cohort acceptance states could not be exercised.

**How to apply:** Before accepting or re-verifying retailer tabs, query current
production identity coverage and prove that representative RET# rows exist.
Any remediation is a protected source load: follow the reviewed-diff and
explicit-approval gates, then verify all four acceptance states on the deployed
screen.