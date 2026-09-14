---
name: Resolution priority and relationships
description: Structured storage and ordering rules for resolution-register priorities and cross-item links.
---

Resolution priorities and relationships must be stored as constrained database values, not embedded only in reason or evidence text. Legacy entries without source-backed priorities remain null rather than being assigned a guessed default.

**Why:** Priority ordering and dependency provenance must be queryable and auditable. Free-text links cannot enforce allowed relation types, and guessed legacy priorities would present invented business decisions as facts.

**How to apply:** Require an explicit enum priority for newly created entries, sort null legacy priorities after classified entries, and use stable resolution codes in the relationship table. A question linked to a finding does not close that finding.