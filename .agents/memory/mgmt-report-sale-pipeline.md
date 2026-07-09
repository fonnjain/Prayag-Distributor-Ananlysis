---
name: Management report dispatched-sale pipeline
description: Durable rules for the State-Head register / Party TM bridge sale sources in the management report
---

- Dispatched Sale comes from per-head register workbooks in the "State Heads" Drive folder (one workbook per head, tab detected by content, not title: date serial in col1, numeric amount col7, FY label col13/14). Workbook titles are messy ("Snadeep ji", "RIZVI JI JI", "Tamilnadu") — never key on filename text; head identity is resolved and merged separately.
- **Why:** titles are hand-typed and change; content detection survived all 13 workbooks on first run.
- Per-member Sale REQUIRES the "Party TM Map" bridge sheet (Party/Customer | Team Member | State Head). Until it exists, Sale is reported at head grain only in the Missing Data tab; per-member Sale cells stay grey/blank, never zero. The per-member "Copy of <Name>" files are retailer-grain (RET# ids) and CANNOT substitute for the bridge — the register parties are distributors.
- The bridge is Drive-searched on every cached load, so creating the sheet auto-wires it with no config change.
- Anchor for regression: Anant Singh FY26-27 Sale 2,57,08,142 / 245 invoices / 29 parties (head-grain, from register workbook).
- **How to apply:** any change to register parsing or bridge logic must reproduce the anchor and keep sale cross-foot (head total vs member split) within ±1 rupee, surfaced on the Missing Data tab.
