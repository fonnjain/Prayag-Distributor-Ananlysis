---
name: Member working sheet column detection
description: Retailer-level working sheets have one Order Booking / Sale column per FY; header detection must NOT use first-match.
---

## Rule
Use fixed DEFAULT_COL positions (W=22 plan, X=23 visits-req, Z=25 OB, AA=26 sale, AB=27 total-visit) for data extraction. Do NOT override them with header detection.

**Why:** Each member's "Summary Report 26-27" tab contains a full historical run of columns — "Order Booking 19-20", "Sale 19-20", … "Order Booking 2026-27", "Sale 2026-27". First-match header detection maps `orderBooking` to the 19-20 column (index 7) instead of the 2026-27 one (index 25), returning historic zeroes/noise.

**How to apply:**
- Call `detectColumns()` only for (a) data-start row inference and (b) diagnostic logging.
- Always assign `const COL = DEFAULT_COL` for actual cell reads.

## Tab selection
The file contains tabs: "Summary Report" (cumulative all-FY), "Summary Report 26-27", "Summary Report 25-26", etc.
- Must prefer the FY-specific tab. Use `findSummaryTab(fileId, fy)` which tries FY variants (2026-27 / 2026-2027 / 26-27 / 2026) before longest-match fallback.

## Row boundary
The "Summary Report 26-27" tab has ~976 rows. The main retailer section (73 rows for Prasun) ends with a TOTAL row. Rows beyond that belong to other sections.
- Break on TOTAL/GRANDTOTAL/SUBTOTAL name (not `continue`).
- Also break on 3+ consecutive blank name-column cells.

## Acceptance anchors — Prasun Chatterjee FY2026-27
73 retailers | 34 active (46.6%) | 39 dormant | OB=2,621,109 | Sale=2,613,934 | top5=64.0% | top10=78.4% | bizPerActive=77,091 | bizPerVisit=6,636 | totalVisits=395
