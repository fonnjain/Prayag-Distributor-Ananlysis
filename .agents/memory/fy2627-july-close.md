---
name: FY2026-27 July month-close
description: Past-FY materiality decisions, current DB baselines, and the exact checklist to run on Aug 1 when July 2026 closes.
---

## Past-FY materiality decisions (closed July 2026)

| FY | DB total | Anchor | Gap | Gap% | Decision |
|----|---------|--------|-----|------|---------|
| FY2023-24 | ₹349.02 Cr | none | — | — | closed (prior-FY only) |
| FY2024-25 | ₹341.14 Cr | ₹341.14 Cr | ₹33,805 | ~0% | closed (rounding only) |
| FY2025-26 | ₹359.52 Cr | ₹361.14 Cr | ₹1.62 Cr | 0.45% | closed against 1% bar |

FY2025-26 gap root cause: Sheets register ITEMCODE column (index 6) is empty in all 148,022 data rows; actual code is at ITEMNAME (index 8). Sheets backfill path is permanently broken without spreadsheet remediation. Only original xlsx can close the gap.

## YoY impact of FY2025-26 gap

The FY2025-26 gap (₹1.62 Cr / 0.45%) causes the prior-year Q1 comparator to read ₹74.14 Cr instead of the correct ₹74.56 Cr (₹42 L short in Q1). This shifts the analytics YoY:

| Metric | DB-derived | Correct (restored) |
|--------|-----------|-------------------|
| Overall Q1 YoY | −1.4% | −2.0% |
| Territory Q1 YoY | +8.5% | +7.8% |
| Institutional Q1 YoY | −54.1% | −54.1% (unchanged) |

These figures are within the 1% health-check tolerance and are accepted per the materiality bar.

## FY2026-27 Q1 baselines (verified July 20, 2026)

- Q1 primary total: ₹73.09 Cr (730,867,205) — exact match to anchor
- Q1 invoices: 5,714 — exact match
- Q1 distinct customers: 439 — exact match
- Jul-26 in DB: 6,353 rows, ₹11.47 Cr, max_invoice_date=2026-07-18 (partial, 2-day lag)

## July-close mechanism — all correct (no code changes needed)

- `isMonthComplete("Jul-26", max_date)`: false while max_date < 2026-07-31; auto-flips to true when July 31 invoice data arrives
- `getCompleteMonths(fy)`: queries `MAX(invoice_date)` from DB grouped by month_label — already correct
- Secondary: `isMonthClosed(monthIdx=3, "2026-27")` returns false until Aug 1; shows `notYetRecorded=true` for July — correct
- Month-block detection in `stateDashboard.ts`: dynamic 12-column scan; July column auto-detected from STATE HEAD DASHBOARD header row — correct
- No hardcoded Q1 assumptions in `CombinedPerformanceDashboard.tsx`

## July-close checklist (run on or after Aug 1)

1. **Verify July is complete**: `GET /api/customers/months?fy=2026-27` — confirm `Jul-26` has moved from `partialMonths` to `completeMonths`. This only happens once `max(invoice_date for Jul-26)` reaches `2026-07-31` in `sale_line`.

2. **Update verify_anchors.json**:
   - In `primary_anchors["2026-27"].closedMonths`: add `"Jul-26"`
   - In `primary_anchors["2026-27"].closedMonthsTotal`: set to sum of Apr+May+Jun+Jul from DB
   - SQL: `SELECT SUM(amount::numeric)::bigint FROM sale_line WHERE fy='2026-27' AND month_label IN ('Apr-26','May-26','Jun-26','Jul-26')`
   - Restart API server to pick up the config change (statically bundled by esbuild)

3. **Run audit**: `GET /api/audit` — confirm Jul-26 passes closed-months dispatch check.

4. **Secondary side**: State heads enter July secondary figures in STATE HEAD DASHBOARD at month-end. Auto-picked up on next `loadStateDashboard("2026-27")` call (15-min TTL cache for current FY). No manual action needed.

**Why:** `verify_anchors.json` is statically imported by esbuild and bundled at build time — changes require a server restart to take effect.
