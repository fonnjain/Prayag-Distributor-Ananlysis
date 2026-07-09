---
name: Prayag Target Master conventions
description: Rules for the targets feature — writable-sheet allowlist, pro-rata split semantics, sheet upsert idempotency.
---

# Target Master conventions

- The Google Sheets client is read-only by design; write helpers only work on sheets explicitly registered in a writable allowlist. Never widen the allowlist beyond the Target Master sheet.
  - **Why:** the app reads many business-critical workbooks it must never mutate; a single allowlisted write target keeps the blast radius at zero.
  - **How to apply:** any new write feature must register its sheet explicitly and be reviewed against this rule.
- Pro-rata split rule (spec-mandated): members with prior-FY actuals share pro-rata; members with NO prior data each get an equal per-capita share (1/N of the total) carved out first, and the remainder is pro-rated among data-bearing members. Do not use mean-weight normalization — it was reviewed and rejected as off-spec.
- Sheet upserts are keyed by (fy, team member). Because Google Sheets has no uniqueness constraint, upserts must be serialized (in-process lock), re-read the row map immediately before writing, and overwrite ALL duplicate rows for a key so no stale copy survives.
- Target semantics in reports: monthly target = monthly override if present, else annual/12. Missing targets render as blank/grey, never zero — "blank never reads as zero" applies to targets exactly as it does to source data.
