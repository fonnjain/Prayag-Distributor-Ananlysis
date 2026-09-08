---
name: Canonical category registry
description: Durable authority, precedence, composite, and provenance rules for item-code category classification.
---

The canonical product taxonomy is a database-backed, effective-dated item-code registry constrained to the 17 approved primary categories. Current-FY `group_canon` is authoritative; older primary data and other vocabularies may fill uncovered codes but never overwrite it.

**Why:** Broad source vocabularies are not interchangeable. In particular, MRP Division cuts across primary groups, and treating every broad Division as an additional category creates hundreds of false multi-category products.

**How to apply:** Preserve every raw source observation separately from the assignment. Only the explicitly approved pipe-separated MRP composite values may create multiple assignments; broad `Pipes & Fittings` has no one-to-one canonical equivalent. Unknown composites and uncovered current sale codes must fail loudly.