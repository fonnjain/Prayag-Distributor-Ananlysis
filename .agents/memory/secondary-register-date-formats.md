---
name: Secondary register date formats
description: FY-split on how date cells are stored in secondary register sheets; critical for toMonthLabel correctness.
---

## Rule

`toMonthLabel()` in `normalize.ts` must handle three date representations:

1. **Number** (Excel serial, e.g. 44291) — FY2021-22, FY2022-23, FY2023-24
2. **String "DD-MM-YYYY"** (e.g. "25-04-2025") — FY2024-25, FY2025-26
3. **String "Apr-25" / "April 2025"** (month-name) — general fallback

The Sheets API is called with `UNFORMATTED_VALUE + SERIAL_NUMBER`. Actual date-formatted cells return as numbers; TEXT-formatted cells return the raw string. FY2024-25 and FY2025-26 sheets have dates entered as plain text, so they arrive as `"25-04-2025"`.

**Why:** Before the fix, the missing DD-MM-YYYY branch caused every text-date row to return `monthLabel=null` → blank-skipped. FY2025-26 went from 79,903 rows (₹44.75 Cr, 20% of true value) to 379,439 rows (₹231.09 Cr) — an exact match with the control cell.

**How to apply:** If a future FY register also uses text dates, the fix already handles it. If dates appear as ISO "YYYY-MM-DD", that branch is also present. Always check the `first5Rows` log from a dry-run gate1 to confirm which format the sheet uses.

## Amount column also splits by era

- FY2021-22 → FY2023-24: amount = **Sub Total** (col 11, net of discount). Continuation rows have empty Sub Total → blank-skipped correctly.
- FY2024-25 → FY2025-26: amount = **Order Value** (col 9, gross). All rows have Order Value → blank_skipped = 0 after date fix.

## Gate 1 control totals (dry-run, no DB writes)

| FY      | Data rows | Grand total        | All months |
|---------|-----------|--------------------|------------|
| 2021-22 |    42,792 |  1,211,404,286     | YES        |
| 2022-23 |    61,966 |  1,559,652,864     | YES        |
| 2023-24 |     4,638 |    105,306,248     | Apr only   |
| 2024-25 |   335,256 |  2,160,011,256     | YES        |
| 2025-26 |   379,439 |  2,310,913,869 ✓  | YES        |

FY2023-24 source register has only April data — the sheet is incomplete at the source.

Negatives (data quality, not pipeline): FY2022-23 Mar-23 -₹66,167; FY2024-25 Sep-24 -₹7,569.
