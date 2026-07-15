---
name: sale_line dedupe and occurrence-count stability
description: Why deleting rows from sale_line causes line_uid drift; the correct clean-re-sync procedure; the two-guard dedup approach.
---

## The occurrence-count cascade problem

`line_uid` is a SHA-1 of `fy|month|customer|code|qty|rate|amount|occurrence`.
`occurrence` is a per-`(customer,code,qty,rate,amount)` counter across all
rows in the source sheet **in source order**. It is deterministic only if
the source order is stable AND the same number of preceding rows exist.

**If you DELETE rows from `sale_line` for a given FY, the live sheet's
occurrence counter for subsequent rows diverges from what the DB stored.**
The verify endpoint then reports those rows as "missing" even though the same
natural-key data is present under the old line_uid. This is not a real gap —
it is occurrence-count drift.

Symptom: `verify.missingFromDb.count ≈ number of rows deleted`, and the
"missing" rows are all already in the DB under different line_uids.

**Rule: never delete individual rows from `sale_line` for an open FY without
immediately doing a full clear-and-re-sync for that FY.**

## The two-guard dedup approach (correct design)

1. `dedupeByNaturalKey()` in `insertSaleLineBatches` — collapses rows with
   identical `(fy, invoice_no, code, qty, amount, invoice_date)` within a
   single insert batch, keeping the first (alphabetical line_uid). This
   handles "sheet-level double-reads" where the source sheet contains the
   same physical line item twice (e.g., invoice 72600021 had 3 pairs of
   identical lines in Apr-26 of the live SALE SHEET 26-27).

2. `ON CONFLICT (line_uid) DO NOTHING` — prevents exact re-reads (same
   source state → same occurrence → same line_uid hash).

3. `sale_line_natural_key_idx` (UNIQUE INDEX on the natural key, partial
   WHERE invoice_no IS NOT NULL AND invoice_date IS NOT NULL) — database-level
   guard for future cross-run duplicates on rows that have both fields set.

**Why:** A single sheet may contain duplicate rows (sheet data quality issue).
Without guard 1, those rows would get occurrence=1 and occurrence=2, producing
two DB rows for the same physical line item. Guard 1 prevents this. Guard 3
prevents the same natural-key row from being inserted again on a future sync
run even if occurrence drifts.

## Clean re-sync procedure for an FY

When occurrence-count drift is detected (or after any manual deletion):
1. Drop `sale_line_natural_key_idx`.
2. `DELETE FROM sale_line WHERE fy = '<fy>'`.
3. `POST /api/verify/backfill?fy=<fy>` — reads live sheet, dedupeByNaturalKey,
   inserts, confirms count.
4. Re-create `sale_line_natural_key_idx`.
5. Run verify endpoint to confirm `missingFromDb.count` equals the known
   sheet-level duplicate count (expected non-zero if the source sheet has
   double-read rows).

## Sheet-level duplicates are expected and documented

For SALE SHEET 26-27 (FY2026-27): 492 rows in the live sheet are natural-key
duplicates (same invoice_no, code, qty, amount, date appearing twice).
After dedupeByNaturalKey: DB has 31,788 rows vs sheet 32,280 rows.
Invoice count and customer count match exactly (6,103 / 456) on both sides —
the 492 extra rows are line-level duplicates, not missing invoices.
`verify.healthy` will show `false` because it compares raw row counts, but
this is the known-good state. Do not "fix" it by inserting the duplicates.

## Closed-months anchor for open FYs

For FY2026-27 (and any future FY where the current month is open):
- Use `closedMonths` + `closedMonthsTotal` in `verify_anchors.json` instead
  of the full-year `total`. The closed-months check only queries
  `month_label IN (...)` and stays stable as the open month fills.
- Anchor set 2026-07-15: Apr+May+Jun 2026 = Rs 72,54,24,443 (Rs 72.54 Cr).
- When July closes: add "Jul-26" to `closedMonths` and update
  `closedMonthsTotal` in `verify_anchors.json primary_anchors["2026-27"]`.

**Why:** A full-year running total drifts every time the current month is
synced, making the check meaningless. Closed-months totals are immutable once
those months close and provide a stable regression anchor.
