---
name: HR Roster CSV architecture
description: How User_List.csv (HR SFA system) feeds emp code / designation into the dashboard roster without polluting the member list.
---

# HR Roster CSV (User_List.csv) — architecture

## The rule
The member list always comes from the **State Head Dashboard Data tab** (~182 current members). The CSV is an enrichment layer only — it must never be used as the primary member list because it contains the full historical churn log (440+ rows across all FYs).

**Why:** Using the CSV as the roster caused 440 rows in mgmt/data (all historical deactive members leaked in). The dashboard already maintains the correct current-team view (active + recently departed), so it is the source of truth for WHO appears.

## How to apply
- `loadFallbackRoster()` — State Head Dashboard, always the base (182 members)
- `loadCsvHrEnrichment()` — returns `Map<normSecKey, CsvHrEnrichment>` (emp code, designation, CTC, DOJ, leftDateSerial, activeLeft). Applied to each dashboard member by normSecKey lookup.
- `loadRosterUncached()` priority: CSV enrichment → Drive xlsx → none
- Source reported as `"hr_roster_csv"` when the CSV loaded, regardless of match rate

## Path resolution
The esbuild bundle outputs `dist/index.mjs` (single file). `import.meta.url` therefore points to `dist/`, not `src/lib/mgmt/`.
Correct path: `join(dirname(fileURLToPath(import.meta.url)), "../config/hr_roster.csv")`
(candidates: `../config/`, `process.cwd()+config/`, `process.cwd()+artifacts/api-server/config/`)

## CSV columns (User_List.csv, 35 cols)
Key columns (0-indexed): Name=3, Employee Code=5, Designation=2, Date of Joining=12, Date of Leaving=13, Reporting Manager=15, Status=17, Headquarter=24, Working State=25, CTC=31, Weekly Off=14.
Dates format: "DD-Month-YYYY" (e.g. "23-July-2026") → convert via parseCsvDate().

## empCode in API
`empCode` and `designation` added to `RosterMember` type and exposed in `/api/mgmt/data` row output (mgmt.ts). Synthetic members (departed TMs from order file) also get `empCode: null, designation: null`.
`designation` in the row prefers hrSfa → r.m.designation as fallback.

## Snapshot invalidation
When the roster source changes (e.g. CSV refresh), the mgmt-data snapshot cache must be cleared:
`DELETE FROM route_payload_snapshot WHERE key LIKE 'mgmt-data|%'`
Or call `invalidateMgmtDataCache()` from any route that mutates roster data.

## Known gap (Aug 2026)
6 of 182 members have no emp code — normSecKey mismatch between SFA name and dashboard display name, or truly absent from SFA system. Investigate by checking `normKey` vs CSV names for the 6 unmatched.
