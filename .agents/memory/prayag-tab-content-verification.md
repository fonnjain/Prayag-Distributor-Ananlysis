---
name: Tab content verification + sheet_confirmed_at
description: How per-head/combined tab exclusion is verified by content, and how ghost rows in sale_line are tracked.
---

## Two-pass readOrderTabInventory

`readOrderTabInventory` (primarySheets.ts) now does two passes:

1. **Monthly pass**: reads monthly + unknown tabs, builds `monthlyByNormHead` (normHead → ₹ sum) and `monthlyTotal`.
2. **Verification pass**: reads per-head and combined candidates, sums their Taxable Value, compares to the monthly aggregate for that head/combined.

`TabContentVerification.status`:
- `confirmed-duplicate` — within ₹1 (safe to exclude)
- `content-differs / diffAmount < 0` — tab has LESS than monthly, no unique rows (safe to exclude)
- `content-differs / diffAmount > 0` — tab has MORE than monthly — WARNING, review required
- `unreadable` — header detection failed or API error

**Current FY2026-27 booking sheet results (Jul 2026):**
- ANUJ SHARMA: diff=−₹1.07 Cr (tab < monthly) — safe to exclude
- Combined: diff=−₹77.76 Cr (tab < monthly) — safe to exclude
- LAST MONTH ORDER: diff=−₹53.77 Cr (tab < monthly) — safe to exclude

## sheet_confirmed_at on sale_line

New nullable column `sheet_confirmed_at timestamp with time zone` on `sale_line`.

Semantics:
- `null` (pre-migration default) → not yet confirmed; after first sync = ghost row (was in DB, not in sheet)
- non-null → timestamp of the last live read in which this row was present in the sheet

`markSheetConfirmed(lineUids, confirmedAt)` in `ingest.ts` batch-UPDATEs the column for every line_uid found in the current live read. It is called from:
- `doSync` in `registerSync.ts` (6h scheduled sync)
- `backfillMissingFromSheets` in `verify.ts` (manual POST /verify/backfill)

**Why:** July 2026 had 4,000 ghost rows (₹6.94 Cr) inserted during a mid-month backfill (Jul 14–15) that were subsequently deleted from the sheet. The marker lets us distinguish confirmed rows from ghost rows without deleting the DB data (non-destructive).

**Verified Jul-26 result:** 6,353 total rows; 2,353 confirmed (₹4.53 Cr, matches live sheet); 4,000 disputed (₹6.94 Cr, ghost rows not currently in sheet).

## GET /api/mgmt/tab-diagnostic

Route: `GET /api/mgmt/tab-diagnostic?fy=2026-27`

Returns:
- `sheets.booking.tabs` — full `OrderTabInventoryRow[]` with `contentVerification`
- `sheets.sale.tabs` — same for the sale sheet
- `disputedRows.byMonth` — per-month counts/amounts split by confirmed vs disputed

**How to apply:** Call this after any July-month-close to confirm ghost-row count drops to 0 once state heads remove obsolete data. The `disputedAmount` field is the ₹ value of DB rows not confirmed by the current live sheet.
