---
name: FY2024-25 order-booking restatement
description: Scope boundary for the approved corrected Segment Wise order-history source.
---

The corrected FY2024-25 Segment Wise source was approved for isolated order-booking history despite a small accepted annual source variance and one explicitly excluded blank-product row.

**Why:** The date correction fixed a material month-allocation problem, while the remaining annual value variance was accepted as immaterial. That approval did not resolve the separate frozen-table date issue.

**How to apply:** Treat this approval as limited to the FY2024-25 `secondary_order_line` order-booking slice. Do not use it to restate or reload `secondary_register_line` or `secondary_sku_line`; those frozen tables require a separate decision.