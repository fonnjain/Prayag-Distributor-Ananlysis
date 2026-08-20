---
name: Post-departure imported records
description: Safe handling of customer assignments or coverage seeded after a confirmed departure.
---

# Post-departure imported records

When a confirmed departure predates a seed-imported customer assignment, void the imported source row and create a current unassigned row that preserves `former_person_name_raw`; do not close it at the earlier departure date or transfer it to holding. The same explicit action may void only import-origin coverage (`seed_import` or `migration`). Any later non-import row must fail closed for manual remediation.

All operational “current assignment” queries must mean `effective_to IS NULL AND voided_at IS NULL`. Voided source rows are read-only audit evidence even after their unassigned replacement is assigned to a real owner.

**Why:** back-dating a later import creates an impossible effective interval and invents historical ownership. Deleting or mutating it later loses the evidence needed to explain the correction.

**How to apply:** use the guarded departure option only after the operator acknowledges the exact live impact. Keep historical derived-register coverage intact, preserve the void metadata and change-log entry, and add the live-row predicate to any future assignment-moving endpoint.