---
name: Person Registry
description: DB-backed replacement for head_alias.json + normalize.json territory_heads; mutable module-level maps populated at startup.
---

## Rule
`person_registry` table (migration 021) is the single source of truth for head alias resolution and territory-head classification. **Never read `head_alias.json` or `normalize.json territory_heads` in new consumer code** — use the exported maps from `personRegistry.ts`.

**Why:** JSON files required a redeploy to fix alias mistakes; the DB table lets operators patch aliases via `PATCH /api/person-registry/:id` without a deploy.

## How to apply
- Module-level exports: `headAliasLookup` (Map), `territoryHeads` (Set), `institutionalHeads` (Set), `canonicalStateHeads` (string[]).
- Call `loadPersonRegistry()` at startup (already wired in `index.ts`) before any register ingest or SAP derive.
- After a PATCH, the route calls `loadPersonRegistry()` again to hot-reload maps.
- `assertHeadCoverage()` runs at startup (after register data is ready) and logs WARN for unresolved FY2026-27 heads. Non-fatal.
- **Bucket labels to exclude from coverage check:** "NON-TERRITORY / PROJECT / GOVT", "PROJECT", "GOVT", "UNMAPPED", "[UNRESOLVED]" — these are computed by normalize.ts, not raw register heads.

## Seed
`POST /api/person-registry/seed` reads config/head_alias.json + normalize.json + hr_roster.csv and inserts rows (ON CONFLICT DO NOTHING). Call once after first deploy. Idempotent.
`resolveConfigDir()` tries `cwd/config` first (dev), then `cwd/artifacts/api-server/config` (prod).

## Key identity rules
- **Pawan Kumar Sharma** (id≈11, `is_state_head=true`) — the state head, aliases include PAWAN KUMAR, PAWAN SHARMA, etc.
- **Pawan Kumar (HR)** (id≈191, `is_state_head=false`) — separate team member under Nasir Hussain Khan. Never merge.
- **Two Ashutosh Kumar rows** — different norm_keys; one code-based, one `ashutoshkumar:sandeepdadheech`.
- Non-persons: GEM, GOVT, JJM, OTHER, PROJECT — `is_person=false`.

## Relationship-model boundary
`person.reports_to_person_id` is the operational reporting hierarchy. `person_registry.reporting_manager` is imported HR/roster text and provenance, not an operational relationship key.

**Why:** A measured comparison found both unresolved manager text and conflicts with the existing operational hierarchy; a shared employee-code case also proves employee code cannot be a person identity key.

**How to apply:** Do not widen the registry editor beyond aliases until a dedicated convergence flow maps registry records to stable `person_id` values, sends unresolved or ambiguous matches to review, and validates self-links and cycles before backfilling. Retain raw manager text as provenance while the relational hierarchy is reconciled.

## Verified (Aug 2026)
- Seed: 1033 rows (14 state heads, 1015 members, 5 non-persons, 135 skipped)
- Head-coverage assertion: PASSED on startup with seeded DB
- All comparison guards: 94/94 unit + 12/12 guard checks passing
- Typecheck: clean across all packages
