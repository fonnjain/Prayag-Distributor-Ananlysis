---
name: Product-Wise MRP fallback drift
description: Effective-history gaps make closed-month Product-Wise controls move when the active synced catalogue refreshes.
---

For a closed Product-Wise month, every priceable code needs effective-dated history; an active-catalogue fallback makes agreement buckets and reconstructed discounts time-dependent.

**Why:** Production August controls changed after a later active MRP sync even though the August order rows were unchanged. The median basis stayed valid, but bucket counts, values, and the active-vs-effective comparator drifted.

**How to apply:** Treat active synced MRP as an availability fallback only, disclose any fallback coverage, and do not call closed-month controls frozen or reproduce an old active-price comparison unless the corresponding catalogue generation was retained.