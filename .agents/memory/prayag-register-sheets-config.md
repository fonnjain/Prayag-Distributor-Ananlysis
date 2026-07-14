---
name: FY2026-27 register_sheets.json points to order booking sheet
description: The spreadsheetId in register_sheets.json for FY2026-27 is the ORDER BOOKING sheet (not SAP dispatch). Inserting from it into sale_line doubles data.
---

## Rule
`artifacts/api-server/config/register_sheets.json` entry for `"2026-27"` = `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A`.

This spreadsheet is the **ORDER BOOKING** sheet (customer orders to company), NOT the SAP dispatch register (company shipments = invoice lines). Its monthly tabs have ~2× more rows and ~10× the amount of the SAP data because they contain pending orders, not just confirmed shipments.

**Why:** Discovered when `POST /api/verify/backfill?fy=2026-27` ran for the first time after header-detection fix. It inserted 33,074 rows from the OB sheet on top of 30,658 xlsx SAP rows, inflating FY2026-27 total to ₹155 Cr from ₹73 Cr. Rolled back by deleting `WHERE source='sheets' AND fy='2026-27'`.

**How to apply:**
- Never run `POST /api/verify/backfill?fy=2026-27` until register_sheets.json is updated to point at the actual SAP dispatch register for FY2026-27.
- The SAP dispatch register spreadsheet ID is unknown. Ask the user to provide it.
- The OB sheet IS correctly used for the order booking KPI (separate pipeline in `orderBookSale.ts`).
