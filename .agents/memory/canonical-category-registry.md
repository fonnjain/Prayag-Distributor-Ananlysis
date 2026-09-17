---
name: Canonical category registry
description: Durable authority, precedence, composite, and provenance rules for item-code category classification.
---

The canonical product taxonomy is a database-backed, effective-dated item-code registry constrained to the 17 approved primary categories. Current-FY `group_canon` is authoritative; older primary data and other vocabularies may fill uncovered codes but never overwrite it.

**Why:** Broad source vocabularies are not interchangeable. In particular, MRP Division cuts across primary groups, and treating every broad Division as an additional category creates hundreds of false multi-category products.

**How to apply:** Preserve every raw source observation separately from the assignment. Only the explicitly approved pipe-separated MRP composite values may create multiple assignments; broad `Pipes & Fittings` has no one-to-one canonical equivalent. Unknown composites and uncovered current sale codes must fail loudly.

For display-only six-master reporting, use each code's latest reviewed non-null master assignment for every FY. Historical periods are therefore shown under the current classification; missing assignments display as `Unmapped`. Keep effective-dated registry history, stored sales, frozen anchors, and totals unchanged.

**Why:** Historical registry rows before 1 April 2026 have no master assignment, so a sale-period effective-date join would incorrectly classify every FY2025–26 figure as unmapped. The business approved current classification for cross-FY display comparability.

**How to apply:** Use this rule only on approved master-category display surfaces and their exports. If a code is later moved because of a genuine commercial reclassification rather than a correction, revisit the display decision instead of deleting or bypassing effective history.

Every category-coverage probe must state the environment it queried and must not generalise development findings to production.

**Why:** Development had null `master_category` values while production held 10,417 populated assignments, causing a valid production bridge to be reported incorrectly as defective.

**How to apply:** Label every probe result as development or production, and check the intended environment before concluding that assignments, coverage, or source data are missing.

Prompt 68 load controls must validate the approved assignment generation, current transaction cross-foot, zero overlap, and six-master vocabulary. Never freeze current-FY transaction code/value totals into the loader.

**Why:** The original 4,000-code / ₹136.27 Cr / zero-unmapped control was a point-in-time snapshot. It later rejected the unchanged approved generation after valid transactions and a known Composite residue arrived.

**How to apply:** Pin preview-to-apply with the preview hash, require mapped plus explicitly unmapped rows/value to equal the live total, and compare environments separately through the read-only parity snapshot.