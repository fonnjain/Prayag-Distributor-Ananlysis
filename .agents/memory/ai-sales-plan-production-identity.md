---
name: AI Sales Plan source-aware RET#
description: Source-dependent retailer identity rule for the AI Sales Plan and secondary SKU analytics.
---

Retailer identity in `secondary_sku_line` is source-dependent. Never query
`dealer_id` alone across legacy and Product-Wise populations. Validate the RET#
format and select the source-appropriate field: legacy Sheets can carry RET# in
`retailer`, PSCode 3 carries it in `retailer_id`, and Product-Wise CRM carries
it in `dealer_id` (also copied into `retailer_id`).

**Why:** A fixed `dealer_id` query returned zero for the frozen production
populations and was mistaken for missing identity data. Field-by-field checks
showed that RET# was present elsewhere. P44 also mislabeled nonblank numeric
order serials in FY2025–26 `retailer_id` as RET#.

**How to apply:** Centralize a validated source-aware RET# expression and use
it consistently in selectors, history joins, and peer queries. Before accepting
retailer tabs, print counts for `retailer`, `retailer_id`, and `dealer_id`
separately by fiscal year and source, then verify all four acceptance states on
the deployed screen.