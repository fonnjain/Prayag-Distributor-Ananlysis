---
name: Tab content verification + sheet_confirmed_at
description: How per-head/combined tab exclusion is verified by row fingerprints, and how ghost rows in sale_line are tracked and pruned.
---

## Row-fingerprint verification in readOrderTabInventory

`readOrderTabInventory` (primarySheets.ts) does two passes:

1. **Monthly pass**: reads monthly tabs, builds `monthlyByNormHead` (head → ₹), 
   and `monthlyFingerprints: Set<string>`. Each monthly row stores **8 fingerprint
   variants** (date × customer × code, each present or absent), to handle tabs
   that expose different column sets.

2. **Verification pass**: reads per-head and combined candidate tabs. For each row,
   checks all 8 fingerprint variants against `monthlyFingerprints`. If any variant
   matches → `inMonthlyRows++`, else `uniqueRows++`.

`TabContentVerification.status`:
- `confirmed-subset` — every row matched a monthly fingerprint; safe to exclude
- `has-unique-rows` — some rows absent from monthly; exclusion would drop them
- `unreadable` — header detection failed or API error

**Why 8 variants (date × customer × code):** Per-head tabs (e.g. ANUJ SHARMA) 
may expose DATE / CUSTOMER columns with different header names than monthly tabs.
Without the relaxed variants, all 162 ANUJ SHARMA rows appeared "unique" even 
though 157/162 were actually in monthly tabs. After 8-variant matching: 157 
confirmed, 5 genuinely unique (₹0.04 Cr).

**Current FY2026-27 results (Jul 2026):**
- ANUJ SHARMA: 157/162 in monthly, 5 unique (₹0.04 Cr) → has-unique-rows
- Combined: 4,152/4,152 confirmed-subset
- LAST MONTH ORDER: 13,311/13,311 confirmed-subset

## sheet_confirmed_at on sale_line

Nullable column `sheet_confirmed_at timestamptz` on `sale_line`:
- `null` = not confirmed; after a sync has run = ghost row (present in DB, absent from sheet)
- non-null = timestamp of the last live read that found this row

`markSheetConfirmed(lineUids, ts)` stamps the column from `doSync` (scheduled) 
and `backfillMissingFromSheets` (manual POST /verify/backfill).

## Ghost-row pruning: POST /verify/prune-ghost-rows

`pruneGhostRows(fy)` in `verify.ts`:
1. Guards: refuses if `count(sheet_confirmed_at) = 0` (no sync has run yet)
2. Deletes: `DELETE WHERE fy=? AND source='sheets' AND sheet_confirmed_at IS NULL`
3. Returns: `{ guarded, confirmedCount, pruned }`

Only `source='sheets'` rows are touched; xlsx_backfill rows are never affected.

**First production run (Jul 20, 2026):** pruned 4,000 Jul-26 ghost rows (₹6.94 Cr).
After prune: all months show 0 disputed rows. DB and live SALE SHEET now agree.

## Pending source consistency

`companyPending = companyBooking − companySale` where both come from live Sheets reads.
`companySale` reads the SALE SHEET (dispatch register) live — same data as `sale_line`.
Before ghost-row pruning, the two differed for Jul-26 (DB had ₹11.47 Cr, sheet ₹4.53 Cr).
After pruning, both agree → analytics and pending tiles are consistent.

`sources.sale` label is now `"Sale Sheet {fy}"` (was incorrectly "State Head Sale").

## Fingerprint design decision (do not loosen further)

The 4-variant (customer × code) design is intentional.  Date is NOT varied.

**Why:** When a per-head tab uses a date-column header the regex misses, the
resulting "unique" classification is a real finding, not a detection failure.
ANUJ SHARMA's 162/162 unique rows (₹0.39 Cr) are genuinely absent from all
monthly tabs — widening to 8 variants to make them "match" would hide that.

**How to apply:** If a future tab shows `has-unique-rows` and you suspect a
column-detection problem rather than real uniqueness, inspect the actual tab
headers (via the Sheets API) before loosening the fingerprint.  Do not add
date variants.

## Unique per-head rows included in booking total

`loadPrimarySheetData` adds `uniqueAmount` from every `has-unique-rows` tab
into `bookingAgg.total` and into `byNormHead` for the corresponding head.
This means per-head tabs with real unique data contribute to the booking total
without double-counting the rows that are already in monthly tabs.
