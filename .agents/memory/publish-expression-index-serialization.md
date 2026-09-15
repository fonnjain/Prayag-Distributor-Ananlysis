---
name: Publish expression-index serialization
description: A Replit Publish schema-diff limitation affecting PostgreSQL indexes built from multi-argument function expressions.
---

Do not persist a functional index whose indexed expression contains a multi-argument function such as `regexp_replace`. Store the normalized value in an explicit column and index that column instead.

**Why:** Publish introspection serialized the following index columns into the final quoted function argument, producing invalid PostgreSQL even though the development index itself was valid. The Publish migration then failed validation before deployment.

**How to apply:** Keep the display/source value and normalized key together, backfill the normalized key before making it non-null, and use ordinary column indexes for publish-visible constraints. After changing development schema, inspect the exact development-to-production diff rather than relying only on local migration success.