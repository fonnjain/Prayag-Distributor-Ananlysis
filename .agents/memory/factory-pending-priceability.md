---
name: Factory pending priceability
description: Rules for valuing REPORT 2 pending quantities without hiding source-grain or water-tank unit gaps.
---

Price factory pending only from the product-group quantities explicitly carried by REPORT 2. Treat the difference between Balance Qty and the sum of product-group columns as unpriceable, not zero and not implicitly allocated. Use FY-specific realised amount per group quantity, with missing rates shown as unavailable.

**Why:** REPORT 2 currently allocates only 2,00,053 of 2,98,679 balance pieces to its product-group columns. The remaining 98,626 pieces have no defensible group-level price. WATER TANK is pieces in REPORT 2 while legacy sale rows can store litres, so a raw amount/qty rate can understate tanks by 200–5,000×.

**How to apply:** Preserve source quantity and attribution totals independently from pricing. Reconcile priced amounts in integer paise through the same hierarchy, report unpriceable pieces alongside them, and use the canonical tank-capacity map to obtain a per-tank sale denominator.