---
name: Prayag live register quirks
description: Differences between live Google Sheets registers and the xlsx register files, and how analytics handles them
---

# Live register vs xlsx register differences

- The historical live register workbooks (FY 2024-25 and 2025-26, single "Sheet1" tab) have NO per-invoice DATE column — only CUSTOMER, CODE, M0NTH (a first-of-month date serial), QTY, SALE RATE, AMOUNT, GROUP, STATION, STATE, STATE HEAD A, FY YEAR, MASTER GROUP. The FY 2026-27 workbook DOES have a DATE column, and the xlsx register files for all FYs have dates.
- Consequence: rows loaded into `sale_line` via the live-Sheets backfill path for historical FYs have `invoice_date = NULL`, while xlsx-backfilled rows have real dates. `line_uid` excludes the date, so both paths dedupe against each other, but null-date rows are never "repaired" by a later insert (ON CONFLICT DO NOTHING).
- Analytics month-completeness handles this: `isMonthComplete` uses max invoice date >= month end when dates exist, and falls back to "month fully elapsed on the calendar" (now >= first moment of next month) when a month has rows but zero invoice dates.
- **Why:** production was loaded via the deployed backfill endpoint (live Sheets only — no xlsx access in prod), so its historical FYs are all null-date; without the fallback every historical month looked incomplete and the Growth tab YoY/retention collapsed to zero.
- **How to apply:** never assume `invoice_date` is populated for FYs before the current one in production; any new date-dependent analytics needs the same null-date fallback. FY 2023-24 exists only as the prior-FY block inside the 2024-25 workbook and cannot be backfilled via POST /verify/backfill (resolveFy rejects it); it needs the xlsx CLI against the target DATABASE_URL.
