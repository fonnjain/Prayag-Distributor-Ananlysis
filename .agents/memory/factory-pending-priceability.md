---
name: Factory pending priceability
description: Rules for valuing REPORT 2 pending quantities without hiding source-grain or water-tank unit gaps.
---

Price factory pending only from the product-group quantities explicitly carried by REPORT 2. Treat the difference between Balance Qty and the sum of product-group columns as unpriceable, not zero and not implicitly allocated. Use FY-specific realised amount per group quantity, with missing rates shown as unavailable.

**Why:** A reviewed September 2026 REPORT 2 snapshot allocates 3,36,353 of 3,50,750 balance pieces to product-group columns. The remaining 14,397 pieces have no defensible group-level price. WATER TANK is pieces in REPORT 2 while legacy sale rows can store litres, so a raw amount/qty rate can understate tanks by 200–5,000×.

**How to apply:** Preserve source quantity and attribution totals independently from pricing. Reconcile priced amounts in integer paise through the same hierarchy, report unpriceable pieces alongside them, and use the canonical tank-capacity map to obtain a per-tank sale denominator.

REPORT 2 factory pending and derived OB-minus-Sale are related operational measures, not two valuations of a common order population. They have no common order key, and non-territory Project/GOVT/GEM/JJM/Other balances are visible in the derived measure but cannot be identified or order-matched in REPORT 2.

**Why:** Treating their difference as an integrity fault is misleading. A reviewed FY2026-27 snapshot showed ₹2.93 Cr of derived pending in non-territory buckets alone, while REPORT 2 exposes only head, party, total quantity, and product-group quantities.

**How to apply:** Cross-check wording must say the measures are not directly comparable. The combined export has exactly six sheets: Summary, Detail, Group Rates, Unpriceable, Reconciliation, and Info. Detail preserves source quantities even if pricing fails; amount-derived cells remain blank. Thin rate evidence must be flagged rather than hidden.

Spreadsheet error tokens in source-head cells are data-quality markers, not identities. Route them to an explicit unresolved-source bucket while preserving the party and quantity.

**Why:** REPORT 2 contained a `#N/A` head for CASH SALE with 2 pieces. Treating the error token as a person or discarding the row corrupts both hierarchy and source reconciliation.

**How to apply:** Sanitize the head before carry-forward grouping, label special buckets consistently, and verify that exports contain neither source error tokens nor literal internal fallback values such as `None`.

Party-level Total Order and Sale come from the FY2025-26 State Head Dashboard distributor table and join to REPORT 2 only by exact `normParty`; never use the head-level primary loaders or fuzzy fallback. Unmatched or ambiguous parties remain blank with a reason. Summary commercial totals may sum matched rows only, but must visibly disclose partial coverage. The source dashboard's assigned-member count supports its AVG and per-person/month calculations; it is not the current pending-hierarchy attribution count.

**Why:** The 16 September 2026 read-only audit matched 70 of 151 REPORT 2 parties, with 81 unmatched and 0 ambiguous. Only 20 of the 70 matched dashboard member counts agreed with current pending attribution. Treating either absence or disagreement as zero would fabricate commercial values.

**How to apply:** Keep dashboard Order/Sale/Difference as rupee measures in a visually separate group from REPORT 2 pending pieces. State the negative-difference drawdown convention, annotate partial aggregates, and preserve the source dashboard member-count semantics rather than relabeling current assignment counts.