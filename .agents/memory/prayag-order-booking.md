---
name: Secondary Order Booking files
description: Quirks of the Drive order-booking workbooks, segment mapping, and name-match expectations for the management report
---

# Secondary Order Booking source quirks

- One workbook per FY in the Drive folder (config `secondary_order_booking`); NO 2026-27 file exists yet (2025-26 data ends 31-03-2026). When the report-FY file is missing, order columns must grey out with an explicit reason — never silently show zeros. Autodiscovery matches titles containing "2026-27"/"26-27"/"2026".
- Older files (2021-22 → 2023-24): block layout with forward-filled Date/Retailer/TM cells, block-level Sub Total, no Order ID column, serial dates, headers `ID`/`Retailers`/`Team member`. Forward-fill must persist across 50k-row chunk boundaries.
- "Sub Total" is the net measure that reconciles with the workbook's own header total; "Order Value" is gross MRP — use it only as fallback.
- Segment labels are marketing brand lines ("CPVC DURALIFE", "SWR DRAINTECH") but the authoritative INDEX tab keys are item types ("CPVC PIPE"). `config/segment_alias.json` maps brand → INDEX key; INDEX stays the sole authority for the final TYPE. Segments genuinely absent from INDEX (VIGNETTE, MANHOLE COVER, COLUMN PIPE, COCKROACH TRAPS & GRATINGS) stay unmapped and are listed in the Missing Data tab — do not invent mappings.
- **Why** prefix matching is layered: word-boundary prefix ("C P 5000 SERIES" → "C P") plus squashed prefix only for keys ≥4 chars ("PTMTSYMET" → "PTMT") so short keys like "CP" can never claim "CPVC ...".
- Prior-FY files legitimately fail the >95% team-member match target against the current roster (attrition: verified 57/58 unmatched 2025-26 names are truly absent, not normalization misses). Warn below 95% only for the report-FY file; always list unmatched names both directions in Missing Data.
