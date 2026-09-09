---
name: Publish CHECK serialization
description: How to avoid malformed Publish SQL when new PostgreSQL CHECK constraints are still NOT VALID in development.
---

New development `CHECK` constraints intended for Publish must be validated before recomputing the development-to-production diff.

**Why:** The Publish schema-diff serializer can misrender `NOT VALID` constraint definitions, producing extra closing parentheses or nested `CHECK (CHECK (...))` SQL even though PostgreSQL stores the development constraint correctly.

**How to apply:** Keep the allowlist constraint replay-safe for legacy rows, validate it in development through the normal migration flow, then inspect the generated Publish diff. Proceed only when it emits a plain balanced `ADD CONSTRAINT ... CHECK (...);` statement.