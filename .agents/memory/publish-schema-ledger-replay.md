---
name: Publish schema and custom migration ordering
description: Replit Publish can create schema objects before app-managed migration ledger entries are recorded.
---

When a custom migration may run after Replit Publish has already applied its schema diff, every object-creation and constraint step must be replay-safe, especially named foreign keys. Do not rely on `UNIQUE NULLS NOT DISTINCT`: Publish has rewritten it as ordinary `UNIQUE`; use equivalent partial unique indexes for null-safe invariants.

**Why:** A deployment can fail before opening its port if startup replays an unrecorded migration against objects that Publish already created. A full catalog audit found partial-index predicates preserved but the NULL-aware uniqueness flag lost.

**How to apply:** Guard named constraints with catalog existence checks, use idempotent object creation, and test the publish-created-schema-before-ledger scenario. Compare sensitive catalog definitions before and after Publish.