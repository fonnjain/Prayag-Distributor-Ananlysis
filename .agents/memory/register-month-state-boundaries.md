---
name: Register month-state boundaries
description: Compatibility constraint for source separation and the deliberate difference between SKU completeness and replacement freeze clocks.
---

Do not add multiple source- or fact-qualified rows to the existing register month-state relation in place. Preserve its one-row-per-FY/month compatibility contract; introduce source-aware lifecycle state through a separate table or a staged compatibility layer.

**Why:** Primary replacement and Product-Wise SKU loading currently share the row, while many scalar readers, joins, locks, and upserts assume uniqueness. Adding a discriminator directly would multiply joins or make first-row reads nondeterministic.

**How to apply:** Inventory and migrate every reader/writer before source separation. Keep the existing row as the primary compatibility record until all consumers are explicitly source-qualified.

The SKU canary's month-complete clock and the replacement freeze clock are intentionally different. Completeness begins immediately after month-end for early missing-data detection; freeze occurs later under the four-month IST replacement window.

**Why:** Making the canary wait for freeze would delay detection by roughly three months and defeat the wipe/missing-source warning.

**How to apply:** Retain the early canary clock unless product requirements explicitly redefine alert freshness; use freeze only to decide whether replacement is prohibited.