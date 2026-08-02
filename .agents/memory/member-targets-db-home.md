---
name: Member targets database home
description: member_targets table replaces the read-only Target Master sheet as the writable store; overlay + never-overwrite rules.
---

# Member targets database home (Aug 2026)

- `member_targets` table (migration 007 in `lib/db/src/runMigrations.ts`; drizzle schema `lib/db/src/schema/memberTargets.ts`): one row per (fy, team_member), jsonb `annual` + `monthly` (4 measures × 12), `source`, `updated_by`.
- **Rule:** only explicit user saves (POST /api/targets) write this table — no seed or background job does, so `source='user'` rows can never be overwritten by re-seeds. Keep it that way.
- `loadTargetsForFy` merges: Target Master sheet = read-only seed, DB rows overlay and win per member. Sheet rows with `updated_by` starting `curl-test` are discarded (confirmed API-test junk, user-approved). Sheet read failure degrades to DB-only with a logged error.
- All consumers (report assembleRows, verifyFull, salespeople, mgmt roster export) go through `loadTargetsForFy`, so they pick up DB values automatically.
- **Why cache invalidation matters:** mgmt/report snapshots are prewarmed; POST /targets must call `invalidateMgmtDataCache(fy)` after upsert or reports serve stale targets (code review caught this once already).
- Save route stores canonical roster spelling, rejects duplicate normalized members in one request (422), caps 300 rows, caps updatedBy at 80 chars.
- Pro-rata split: members with no prior-year history get an equal per-head share, surfaced via `basis: "equal-share"` in split-preview and called out in the UI — never silently zero (explicit user requirement).
- Both target editors live on /targets (State Head Targets = primary per head per month in Lakh, DB; Member Targets = 4 measures per member, DB overlay on sheet). Data Sources only links there. Do NOT merge or reconcile the two grids — they are different measures/levels by design.
- drizzle-kit push prompts interactively in this repo (views/renames) — add new tables via the inline migration runner instead.
- orval regen gotcha: `AnalyticsReport.groups`/`AnalyticsGroupStat` was hand-added to the generated client without a spec entry; now in openapi.yaml. Never hand-edit generated client files.
