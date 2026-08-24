---
name: Publish schema and custom migration ordering
description: Replit Publish can create schema objects before app-managed migration ledger entries are recorded.
---

When a custom migration may run after Replit Publish has already applied its schema diff, every object-creation and constraint step must be replay-safe, especially named foreign keys.

**Why:** A deployment can fail before opening its port if startup replays an unrecorded migration against objects that Publish already created.

**How to apply:** Guard named constraints with catalog existence checks, use idempotent object creation, and test the publish-created-schema-before-ledger scenario.