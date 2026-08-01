---
name: mgmt/data cold-start DB snapshot
description: How GET /api/mgmt/data avoids the ~20s cold-start Sheets wait via the shared payload snapshot layer.
---

`/api/mgmt/data` is served through the shared snapshot layer in `artifacts/api-server/src/lib/payloadSnapshot.ts` — `serveWithSnapshot({key, ttlMs, build, log})` backed by the generic `route_payload_snapshot` table (key text PK, payload jsonb, saved_at; migration id `005_route_payload_snapshot`). Key format: `mgmt-data|<fy>|<monthFrom>|<monthTo>`.

- Warm in-process cache → instant; cold cache + persisted snapshot → instant with `meta.snapshotSavedAt` (unix ms) + `meta.refreshing: true` while a deduped background rebuild runs; first-ever key → blocking live build.
- Simulated-clock requests (`_simulatedNow`) bypass snapshot/cache entirely and never persist (call `buildMgmtDataPayload` directly).
- `invalidateMgmtDataCache(fy?)` in routes/mgmt.ts wraps `invalidateSnapshots(prefix)` (payloadSnapshot.ts): drops warm cache entries + deletes route_payload_snapshot rows by key prefix (LIKE, with %/_ escaped) — otherwise a post-xlsx-upload reload re-serves stale target columns.
- The bespoke `mgmt_data_snapshot` table was removed (migration `006_drop_mgmt_data_snapshot` copies old rows into the shared key format first, guarded for fresh DBs where the table never existed).

**Why:** autoscale prod cold-starts made the first visitor wait ~21s on the STATE HEAD DASHBOARD full-sheet read; warm cache is ~13ms. Two parallel snapshot implementations meant poll/TTL fixes had to be made twice.

**How to apply:** any new heavy route adopts `serveWithSnapshot` with a `<route>|<params>` key; invalidate via `invalidateSnapshots("<route>|" + optionalParamPrefix)`. Build fns throw `SnapshotHttpError(status, body)` for non-200s so errors are never snapshotted. Other adopters: `/api/company-reports` (key `company-reports|<fy>`, skipped when `asOf` present) and `/api/warnings` (key `warnings|<fy>|<statehead lc>`). Frontend: SnapshotBanner + useSnapshotRefresh poll until `meta.refreshing` disappears; warnings cold rebuild ~35-55s is within the ~2-min poll budget.
