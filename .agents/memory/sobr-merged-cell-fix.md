---
name: SECONDARY ORDER BOOKING REPORT merged-cell fix
description: Root cause and fix for the SOBR tab reader reading only 17 rows (first per head) instead of 162 member rows.
---

## Rule
The "SECONDARY ORDER BOOKING REPORT 2026-27" tab in STATE HEAD DASHBOARD has col B (State Head) as a MERGED CELL spanning all member rows per group. The Sheets API (`spreadsheets.values.get`) returns the value only in the top-left cell of each merge; all subsequent rows return null. Any reader that requires col B to be non-empty on every row will silently accept only the first row per state head.

**Why:** Google Sheets merged cells + Sheets API null behaviour — a known pattern for any grouped/banded data in Sheets. Affects `eachRow` consumers in `transform.ts` wherever col B drives a group header.

**How to apply:** Whenever a Sheets tab uses merged cells for a group key (state head, region, category), use a carry-forward pattern:
```typescript
let lastGroupKey = "";
sheet.eachRow((row, r) => {
  if (r < startRow) return;
  const rawKey = readKey(row);
  if (rawKey) lastGroupKey = rawKey;
  const key = lastGroupKey;
  if (!key) return;
  // ... process row using `key`
});
```

## Confirmed values after fix (live sheet, July 2026)
- Member rows: 162 (rows 7–172, minus section headers and total rows)
- Col K (Total Dealer 26-27): 11,338
- Col M (Order Booked 26-27): Rs 573,676,739 (Rs 57,36,76,739)
- Col O (Sales 26-27): Rs 620,389,253 (Rs 62.04 Cr; prompt said Rs 61.94 Cr — live-sheet drift)
- Col O and Data tab col AY (Sale Report 26-27) agree at Rs 62.04 Cr

## 182 vs 162 row discrepancy (Data tab vs SOBR tab)
- 20 members in Data tab absent from SOBR tab; all 20 have zero secondary sales (Data col AY = 0)
- Their secondary OB in Data tab: col P (Old Party OB) + col Q (New Party OB) = Rs 1.84 Cr
- Explains Rs 1.65 Cr of the Rs 59.02 Cr (Data) vs Rs 57.37 Cr (SOBR) gap
- Residual Rs 0.19 Cr: SOBR col M runs slightly higher than Data P+Q for the shared 162 members (different OB computation methods / timing)

## State head groupings (as of July 2026)
10 canonical heads in the SOBR tab: Anant Singh (12), Sulinder Pal (2), Pawan Sharma (10), Nasir Hussain Khan (5), BIJU C.O (16), AQIL RIZVI (32), Sandeep Dadheech (65), Lalan Kumar (15), Sunil Patel (4), Biju CO (1 — M. Raman in LEFT TEAM MEMBERS section).

"BIJU C.O" and "Biju CO" are two alias forms for the same head; both resolve through HEAD_ALIAS.
