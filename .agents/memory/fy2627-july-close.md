---
name: FY2026-27 July month-close
description: Past-FY materiality decisions, production DB baselines (post-backfill Jul 2026), and the Aug 1 close checklist.
---

## Past-FY materiality decisions (closed July 2026)

| FY | DB total | Anchor | Gap | Gap% | Decision |
|----|---------|--------|-----|------|---------|
| FY2023-24 | ₹349.02 Cr | none | — | — | closed (prior-FY only) |
| FY2024-25 | ₹341.14 Cr | ₹341.14 Cr | ₹33,805 | ~0% | closed (rounding only) |
| FY2025-26 | ₹361.00 Cr | ₹361.14 Cr | ₹0.14 Cr | 0.04% | closed (well within 1% bar) |

FY2025-26 note: production re-ingested from live Sheets on Jul 31 2026 (145,547 current rows, 66 superseded). Materiality gap reduced from prior 0.45% (xlsx backfill) to 0.04%.

## Production DB baselines (post Jul-31-2026 backfill)

| FY | Source | Current rows | Rs Cr | Notes |
|----|--------|-------------|-------|-------|
| FY2023-24 | xlsx (dev only) | 0 prod | 349.02 dev | Schema C — no invoiceNo/color; prod load deferred (Task #68) |
| FY2024-25 | Sheets | 141,193 | 341.13 | 8 superseded rows (normal dedup); REGISTER_SYNC_PAUSE cleared |
| FY2025-26 | Sheets | 145,547 | 360.89 | 66 superseded rows; REGISTER_SYNC_PAUSE cleared |
| FY2026-27 | Sheets | 39,677 | 94.06 | Apr/May/Jun/Jul only; reconciled=False resolves on next auto-sync |

REGISTER_SYNC_PAUSE = "2023-24" only (shared env). FY2026-27 auto-sync (6h) resumes normally.

## FY2026-27 Q1 baselines (verified July 31, 2026)

- Q1 total: ₹72.82 Cr (Apr+May+Jun) · Jul-26 = ₹21.25 Cr → Q1+Jul = ₹94.06 Cr
- Apr-26: 5,542 rows · ₹13.11 Cr
- May-26: 11,812 rows · ₹28.28 Cr
- Jun-26: 12,868 rows · ₹31.43 Cr
- Jul-26: 9,455 rows · ₹21.25 Cr (sheet grew slightly since dev check of 9,387)

## July-close mechanism — all correct (no code changes needed)

- `isMonthComplete("Jul-26", max_date)`: auto-flips true when July 31 invoice data arrives
- `getCompleteMonths(fy)`: queries MAX(invoice_date) from DB grouped by month_label
- Secondary: `isMonthClosed(monthIdx=3, "2026-27")` shows `notYetRecorded=true` for July until Aug 1
- Month-block detection in `stateDashboard.ts`: dynamic 12-column scan

## July-close checklist (run on or after Aug 1)

1. **Verify July is complete**: `GET /api/customers/months?fy=2026-27` — confirm `Jul-26` in `completeMonths` (needs max invoice_date = 2026-07-31).

2. **Update verify_anchors.json**:
   - `primary_anchors["2026-27"].closedMonths`: add `"Jul-26"`
   - `primary_anchors["2026-27"].closedMonthsTotal`: sum Apr+May+Jun+Jul from DB
   - SQL: `SELECT SUM(amount::numeric)::bigint FROM sale_line WHERE fy='2026-27' AND month_label IN ('Apr-26','May-26','Jun-26','Jul-26')`
   - Restart API server (verify_anchors.json is statically bundled by esbuild).

3. **Run audit**: `GET /api/audit` — confirm Jul-26 passes closed-months dispatch check.

4. **Secondary side**: auto-picked up on next `loadStateDashboard("2026-27")` call (15-min TTL).
