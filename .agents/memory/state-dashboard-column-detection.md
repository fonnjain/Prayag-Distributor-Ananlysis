---
name: STATE HEAD DASHBOARD column detection
description: Column layout quirks in the SECONDARY ORDER BOOKING REPORT tab; how detectCols and detectMonthBlocks must handle it
---

# STATE HEAD DASHBOARD — column detection quirks

## Fixed column headers have FY year suffixes
The anchor row uses headers like `"Monthly CTC 25-26"`, `"Monthly Target 26-27"`,
`"Business Plan 26-27"`, `"Order Booked 26-27"`, `"Sales 26-27"`. These normalise to
`MONTHLYCTC2526`, `MONTHLYTARGET2627`, etc. Simple key matching (`find("MONTHLYTARGET")`)
misses them all.

**Fix:** after building the normalised header index, do a second pass stripping trailing
4-digit year suffixes (`/\d{4}$/`). Add the stripped key to the index if not already
present. This makes `MONTHLYTARGET` resolve to the `2627`-suffixed column.

## Month block positions are Excel date serials, not text labels
The anchor row stores month-start dates as Excel serial numbers (`46113` = April 1 2026,
`46143` = May 1 2026, …) rather than text month names. `detectMonthBlocks` scanning for
"APRIL"/"MAY" finds nothing and falls back to positional with the wrong `monthStart`,
shifting every month block one column to the left.

**Fix:** Strategy 2 in `detectMonthBlocks` — after the text-name scan, scan for numeric
cells in the valid date range (40000–55000) and convert using
`(serial - 25569) * 86400_000` → `new Date(ms)` → extract UTC year+month → map to FY
month index. This gives the correct block starts (April at col 15, May at col 22, …).

## Resulting block structure (7 columns each)
base+0: Plan Amount (₹)
base+1: Plan Count (dealer target)
base+2: Order Booked Amount (₹)
base+3: Order Booked Count
base+4: Achievement % (Sales/Plan — sheet formula is CORRECT here, unlike the annual total)
base+5: Sales Received Amount (₹)
base+6: Sales Received Count

## Verification anchors (FY2026-27, secondary members only, Q1 closed)
- Annual Business Plan = ₹364.97 Cr (spec said ₹364.98 Cr — exact match ✓)
- Q1 YTD Sales = ₹48.37 Cr, YTD Achievement = 63.1%
- Per-member spot-check: Ravinder Puri April plan ₹18L, sales ₹16.74L → 93.0% ✓
- Earlier drafts cited ₹57.88 Cr / 69.4% — those figures included primary-role members;
  secondary-only (8 primary-role excluded) gives ₹48.37 Cr.

**Why:** The anchor row structure was discovered by adding a temporary debug log that
printed anchorRow[0..30] and the first 3 data rows; without the raw dump it's impossible
to tell whether a cell holds a date serial or text.
