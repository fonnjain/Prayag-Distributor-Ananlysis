---
name: Raw SKU source separation
description: Distinguishes the transaction-level source required for SKU alerts from price and aggregate reporting sources.
---

B3/S1 “stopped buying” signals must use the raw `secondary_sku_line` transaction source at retailer/distributor/item/month/quantity grain. MRP masters, State Head dashboard aggregates, and Product-Wise order reports are not acceptable substitutes.

**Why:** Those other sources lack the buyer- and month-level transaction evidence needed to determine whether a retailer stopped purchasing a specific item.

**How to apply:** Any manual load or scheduled refresh for B3/S1 must name and validate an authoritative raw-SKU transaction source. If it is not configured or fails its guards, keep existing rows and surface the coverage gap rather than falling back to an aggregate or price list.