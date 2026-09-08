---
name: Publish schema and custom migration ordering
description: Replit Publish can create schema objects before app-managed migration ledger entries are recorded.
---

Two Publish reconciliation behaviors are confirmed: it can remove production-only relations absent from development, and it drops PostgreSQL's `NULLS NOT DISTINCT` flag by recreating the rule as ordinary `UNIQUE`. Custom migrations must be replay-safe, especially around named foreign keys.

**Why:** One Publish removed an entire production ledger relation; another weakened a NULL-aware table constraint and admitted duplicate open-ended assignments. A full catalog audit found all partial-index predicates preserved.

**How to apply:** Keep production objects represented in development, avoid `UNIQUE NULLS NOT DISTINCT`, and use equivalent partial unique indexes for null-safe invariants. Compare sensitive catalog definitions before and after every relevant Publish.