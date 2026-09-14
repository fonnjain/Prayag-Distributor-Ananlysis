---
name: AI Schemes E2/E3 arithmetic
description: Durable source, hold, catalogue, and category rules for the read-only AI Schemes breadth, band, and margin analytics.
---

Keep E2 and E3 read-only and source-separated: secondary order-booking lines establish positive retailer-item breadth, primary dispatch establishes revenue bands, the current catalogue establishes DORMANT, and margin facts establish gross contribution.

**Why:** Combining these sources changes the business meaning of the figures. Primary revenue and secondary retailer breadth may be displayed together, but they are not interchangeable.

**How to apply:** Aggregate signed secondary rows to retailer-item pairs before retaining positive pairs. Band all positive primary codes by their pre-row cumulative share; use the active catalogue only for DORMANT.

Resolution HOLDs must remove matching months/categories during calculation, and analytics caches must vary with calculation-relevant hold state.

**Why:** A display-only warning leaves held evidence inside percentiles and margins, while an FY-only cache can keep serving arithmetic produced under an older register state.

**How to apply:** Resolve holds before source aggregation, disclose the excluded coverage, and include a deterministic hold signature in cache identity.

Margin categories enrich FY-and-item aggregated margin facts with normalized ERP item groups. Preserve CPVC, AGRI, UPVC, and SWR pipe-versus-fitting splits; fall back to the source segment only when the item group is unavailable.

**Why:** Broad margin segments hide materially different economics inside the same product family, especially fittings versus pipe.

**How to apply:** Never join row-level margin facts to product or secondary rows. Aggregate by fiscal year and item code first, then enrich the item-level result.