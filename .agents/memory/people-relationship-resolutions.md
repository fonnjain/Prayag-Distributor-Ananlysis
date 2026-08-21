---
name: People relationship resolutions
description: Guardrails for manual Person Registry to People relationship decisions.
---

Manual relationship review records an effective-dated canonical link (or an
explicit unresolved decision) with the operator, reason, evidence snapshot, and
an optimistic preview hash. It never changes the HR reporting-manager source
text, the operational People manager chain, or historical sales/margin facts.

**Why:** HR roster evidence can identify candidates but cannot safely rewrite
canonical ownership or historical attribution. A review decision must remain
auditable and safe under concurrent organisation changes.

**How to apply:** Require an authenticated admin, a nonblank reason, a live
impact preview acknowledgement, and hierarchy validation before any decision.
Bind the preview hash to both source versions and displayed impact counts.
Reject future decisions and decisions dated before the current one unless a
separate temporal correction workflow is deliberately introduced. Employee-code
evidence is never an automatic selector; it can only inform a human decision.

## Manual link uniqueness

A current human `linked` resolution is one-to-one: one People record may be
selected by only one active manual registry decision. The guard must run during
preview and again inside the save transaction, with a partial unique index as
the concurrency backstop.

**Why:** Mapping two distinct reviewed registry identities to one People record
would silently recreate the identity merge this review workflow exists to
prevent.

**How to apply:** Do not impose this rule retroactively on imported
`person_registry.person_id` links; historical source records can already be
many-to-one and remain evidence. Apply it only to current human decisions, and
return a conflict that identifies the existing reviewed registry record.