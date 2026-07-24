---
name: Dashboard snapshot field mapping
description: sync.ts explicitly picks each field from buildResources into totals — new fields in ResourcesResult must be added there or they silently become undefined in the snapshot.
---

## Rule

`artifacts/api-server/src/lib/dashboard/sync.ts` builds the `totals` object by explicitly listing each field from the `resources` object returned by `buildResources`. Spreading `...resources` is not used.

**Why:** The snapshot is stored as JSON in the DB. Any field not explicitly listed in the `totals` block in sync.ts is silently omitted from every snapshot produced after that point, even though the TypeScript type and the seed JSON both include it.

**How to apply:** Whenever a new field is added to `ResourcesResult` in transform.ts, also add the corresponding `fieldName: resources.fieldName` line to the `totals` block in sync.ts (around line 134–147). After the code change, restart the API server and trigger `POST /api/dashboard/refresh` to write a fresh snapshot; the DB will otherwise continue serving the old snapshot with the field missing.
