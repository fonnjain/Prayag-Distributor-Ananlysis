---
name: Tank qty loader bug — three-way reconciliation findings
description: SAP-vs-DB-vs-SHEET reconciliation for WT/WCT tank codes; unit confirmed, fix pending unit-decision.
---

## The bug

`sale_line.qty` for WT/WCT tank codes was stored as per-tank-litres (one unit's capacity) instead of the billed quantity. This affects 13,016 rows across FY2023-24 → FY2026-27 (65.3% of all tank rows). Revenue (amount) is unaffected.

## Confirmed by GET /registers/tank-three-way-sample (FY2026-27 via SAP Combined tab)

- **SAP stores PIECES** (billing master). Example: 19 pieces of WCT-3LL-05 (500 L each).
- **DB stored 500** — one tank's capacity — not 19, not 9,500.
- **DB amount = SAP amount exactly** on all 12 matched rows. Revenue is safe.
- **DB is in a mixed state** (not uniformly wrong):
  - 5 rows: SAP=1 (single unit) → DB qty is correct in any schema
  - 5 rows: SAP>1 AND DB=perTankLitres → clear bug
  - 2 rows: SAP>1 AND DB=totalLitres → loader stored total litres correctly for these

## Suffix-to-litres mapping (confirmed)

| suffix | litres |
|--------|--------|
| 02     | 200    |
| 03     | 1,500  |  ← confirmed from WT-3LC-03 DB qty
| 05     | 500    |
| 07     | 750    |
| 10     | 1,000  |
| 15     | 1,500  |
| 20     | 2,000  |
| 25     | 2,500  |
| 30     | 3,000  |
| 50     | 5,000  |

## Source coverage

- FY2026-27: SAP Combined tab available (sheet 19Oj6P2c…, 33,693 rows). Invoice column found. Match by invoice_no + closest amount.
- FY2025-26: invoice_no present in DB but no SAP source → DB-only (SHEET read too slow for single request).
- FY2023-24 / FY2024-25: invoice_no is NULL → DB-only.

## FY2026-27 invoice format

DB invoice numbers like "22600950", "72600223", "22600072" match SAP Combined tab which has "52600001", "72600001", "42600003", "12600002" etc. Branch prefixes: 1=Bhiwadi, 2=unknown, 4=Delhi, 5=Gujarat, 7=Andal.

## Pending decision (do not fix until user confirms)

REGISTER_SYNC_PAUSE=2026-27 env var is set; no qty writes until user decides:
1. **Pieces** — matches SAP billing, matches non-tank rows (recommended for consistency)
2. **Total litres** — matches SALE SHEET reporting; 2/12 sample rows already correct
3. **Pieces + separate qty_ltr column** — cleanest for analytics; requires schema migration

## Diagnostic route

`GET /api/registers/tank-three-way-sample` — builds the DB+SAP comparison. Reads SAP Combined tab (~30s). The two-level subquery (inner: one row per fy×code; outer: cap 12 per FY) is required so FY2023-24 does not exhaust the sample. The SALE SHEET is NOT read inline (full-sheet reads time out in a single request).

**Why:** Revenue-safe confirmation required before any qty backfill. The unit question (pieces vs litres) is a product decision, not just a technical one.
