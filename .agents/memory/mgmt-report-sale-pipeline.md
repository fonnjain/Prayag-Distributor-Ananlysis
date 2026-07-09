---
name: Management report dispatched-sale pipeline
description: Durable rules for the State-Head register / Party TM bridge sale sources in the management report
---

- Dispatched Sale comes from per-head register workbooks in the "State Heads" Drive folder (one workbook per head, tab detected by content, not title: date serial in col1, numeric amount col7, FY label col13/14). Workbook titles are messy ("Snadeep ji", "RIZVI JI JI", "Tamilnadu") — never key on filename text; head identity is resolved and merged separately.
- **Why:** titles are hand-typed and change; content detection survived all 13 workbooks on first run.
- Per-member Sale needs the "Party TM Map" bridge sheet. If it is missing, the server auto-builds it in the background from the member report folder (only files with "Distributor Visit Report"/"Retailer Report" tabs contribute; DIST# rows are authoritative, distributor links inferred from a retailer's "Assigned Distributor" column are non-authoritative and lose conflicts) and caches it back to a created sheet. While building/failed, Sale stays head-grain only; per-member cells blank, never zero, never a guessed allocation.
- The bridge is Drive-searched on every cached load (exact title preferred, then most recent), so hand-editing or replacing the sheet auto-wires with no config change. POST /api/mgmt/bridge/rebuild forces a rebuild; GET /api/mgmt/bridge/status shows progress.
- Register Customer joins the bridge by DIST# id when present, else normalized name (parentheticals like "(CITY)" stripped). Unmatched revenue lands in per-head "Unassigned (<Head>)" synthetic report rows — it is never dropped.
- Coverage reality: only ~18 of ~728 member-report files carry the report tabs, so matched-revenue sits ~37% (target 90%, warn logged). Raising it needs more member files filled in or manual bridge-sheet rows, not code.
- Anchor for regression: Anant Singh FY26-27 Sale 2,57,08,142 / 245 invoices / 29 parties (register head total; member split + Unassigned must reproduce it).
- **How to apply:** any change to register parsing or bridge logic must reproduce the anchor and keep sale cross-foot (head total vs members + Unassigned) within ±1 rupee, surfaced on the Missing Data tab.
