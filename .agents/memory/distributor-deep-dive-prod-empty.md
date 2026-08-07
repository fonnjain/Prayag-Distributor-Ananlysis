---
name: Distributor Deep Dive prod-only empty pages
description: Why prod showed only one head, snapshot warmer + concurrency cap fix, and the memberResolver/directory architecture
---

**Rule:** any page whose payload requires many parallel Google Sheets reads AND gates snapshot-saving on a fully complete load will work in dev (incremental cache warm-up) but stay permanently empty in fresh prod deploys — the parallel burst trips the per-minute 429 quota, the load is "degraded", and no snapshot is ever saved.

**Why:** Distributor Deep Dive worked only for Anant Singh in production (Aug 2026). Member-sheet mappings were never in the DB — they live in bundled `config/member_sheet_map.json`. Prod failed because 74-member teams loaded sheets full-parallel → SheetsQuotaError → isCompleteLoad false → snapshot never written.

**How to apply:**
- Member-sheet mapping single source of truth: `lib/mgmt/memberResolver.ts` (MEMBER_FILE_MAP, resolveTeam, coverageByHead, getMemberFileId). Never import the JSON elsewhere.
- Sheet loads use a worker pool (SHEET_CONCURRENCY=4, 60s/sheet). A snapshot warmer in index.ts builds every head sequentially (3min after boot, then 6h, 30s pauses).
- `GET /api/mgmt/member-sheet-coverage` reports per-head mapped counts.
- Cross-head consumers (distributor directory) must read snapshots via `loadDistDdSnapshotOnly`, never trigger a 12-head live cascade.
- Known gap (architect review): Promise.race timeouts don't cancel underlying Sheets requests; sheetsApi coalescing + 429 negative-cache bound the damage, but a shared limiter across warmer + request paths doesn't exist yet.
