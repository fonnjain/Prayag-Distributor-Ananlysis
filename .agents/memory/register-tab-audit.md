---
name: Register new-tab detection
description: How unrecognised register/order workbook tabs are detected, proposed or ignored, and audited
---
Ledger table `register_tab_audit` (migration 011; PK sheet_id+tab_name+fy+register) records every workbook tab the loaders do NOT read. Module `lib/registers/tabAudit.ts`; endpoint GET /api/registers/tab-audit (also flags a missing register file ID for the clock-derived current FY).

Rules:
- Month tabs matched by PARSING (`toMonthLabel`), never hardcoded lists. Sale reader (`readRegisterFromSheets`) reads only month tabs whose calendar month has STARTED; a future-month tab (e.g. early "Sep") is shape-tested and **proposed**, never auto-read. Everything else is **ignored** with a concrete reason.
- Shape test = header scan (first 20 rows) requiring invoice-number + date + taxable-value/amount columns (`isHeaderRow`/`mapRegisterColumns`). Sheet11 passes isHeaderRow but lacks invoice/date → ignored.
- Audit caches verdicts by grid row count — no repeated Sheets sample reads when a tab is unchanged (quota).

**Why (pitfalls fixed by review):**
- Order-sheet orphan cleanup must keep every tab *physically present in the workbook*, not just tabs replaced this run — otherwise a policy-skipped future-month tab's mirror rows get deleted as "orphans".
- Audit failures must WARN (never bare `.catch(()=>{})`) or a skipped real month tab goes unrecorded silently.

**How to apply:** any new register-like loader should divert non-read tabs into `auditRegisterTabs`; never key audit rows on sheet_id+tab alone.
