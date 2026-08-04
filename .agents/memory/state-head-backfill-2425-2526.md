---
name: FY24-25/25-26 state/head backfill
description: Why those FYs had NULL state_canon/head_canon and how migration 008 fixed it; residual Unmapped is structural.
---

Schema B registers (FY2024-25, FY2025-26; 11 columns) carry NO STATE or STATE HEAD columns, so sale_line rows for those FYs were ingested with state_canon/head_canon NULL — this, not name-vocabulary drift, made every state/head-grouped prior-year figure read zero (Company Reports Report 1 etc.).

**Fix:** migration `008_backfill_state_head_2425_2526` fills both attributes per `lower(trim(customer))` from FY2026-27 first, then FY2023-24. Amounts/row counts untouched, so frozen anchors still hold. No customer has conflicting states within a source FY (verified Aug 2026).

**Residual:** customers appearing ONLY in 24-25/25-26 stay NULL → 'Unmapped' (~₹13.1 Cr of Apr–Jul FY25-26). Structural — the sheets never had the column; only a manual mapping file could close it.

**How to apply:** any analytics grouping prior FYs by state/head should now work; if a new FY register lacks STATE columns, extend the migration pattern rather than joining at query time. Company Reports snapshot key is `company-reports|v3|<fy>` — bump it AND the invalidation in routes/registers.ts together (they drifted once).

Audit Group 10 (`frozen-anchors` in extraGroups.ts) reconciles sale_line rows+amounts against config/frozen_registers.json — rupee-exact; a fail means something wrote to a closed year. The old "Total Sale (net)" verify check was relabelled "Secondary OB file total (Sub Total, net)" (₹231.09 Cr is the secondary OB measure, not company sale).

Known pre-existing audit fails (Aug 2026, unrelated): 6.2a/6.6a report-logic LY drift (~3% off client-approved anchors) and 7.6 PSCode3 brand mirror empty for 2026-27 (actual 0).

**State Head files (Drive folder "Sate Head 2026-27", 15 spreadsheets, Aug 2026):** each file's Sheet1 tab holds positional 15-col line data (K=STATE, L=STATE HEAD, N/O=FY labels "FY-2025-26"/"FY-2026-27", no header row) covering BOTH FYs — control totals 191,770 rows / ₹362.82 Cr + ₹104.72 Cr verified. Loaded into scratch table statehead_file_line (scripts/statehead-files-load.ts; build with esbuild like build.mjs — no tsx in repo). Validation: ₹300.02 Cr of the ₹313.02 Cr customer backfill agrees 100% with the files (zero state-vs-state disagreements; PROJECT/OTHER file states = Non-territory bucket). Files resolve 141/245 previously unattributed customers (₹44.05 of ₹47.98 Cr); MOHAN IMPEX confirmed PROJECT ₹35.73 Cr to the rupee. File names/heads use OLD vocabulary (RIZVI JI JI, BIJJU, Snadeep ji…) — apply head_alias.json, never create heads. SULINDER file id transcription trap: re-query Drive rather than copying ids from listings.
