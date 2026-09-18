---
name: AI Sales Plan source-aware RET#
description: Source-dependent retailer identity rule for the AI Sales Plan and secondary SKU analytics.
---

For Prompt 105, retailer and cohort identity comes from
`secondary_order_line.dealer_id`; valid `cp_code` supplies DIST# when present,
with exact `cp_name` as the explicit legacy fallback. `secondary_sku_line`
supplies only item-level quantity and NET history. Link those rows back to the
order-register RET# using a validated, source-aware SKU-side expression; never
make the SKU mirror the authority for the identity population.

**Why:** Prompt 105 originally asked the SKU mirror an identity question and
mistook the resulting zero for missing source data. Production order lines
carry valid RET# on every FY2025–26 and FY2026–27 row. DIST# begins with the
Product-Wise period, and malformed non-DIST prefixes must be excluded.

**How to apply:** Build selectors, member filters, distributor/state cohorts,
and annual-value quintiles from the order table. Use the SKU table only after
the RET# population has been established. Label table, field, measure, and
period separately; never sum the two tables together.