---
name: Product-Wise monthly source lock
description: Immutability policy for verified Product-Wise CRM source months.
---

Product-Wise CRM source loads follow the shared `monthFreezeAt()` lock exactly: a month becomes permanently non-writable at 00:00 UTC on the 7th of the following month. There is no grace day, loader override, or unfreeze path; any exceptional historical correction is a deliberate database operation outside the loader.

**Why:** Product-Wise raw SKU rows underpin retailer-facing and B3/S1 analysis. Later exports must not silently rewrite the source evidence after the period is closed.

**How to apply:** Keep successful-load provenance append-only and use the shared freeze helper—never a parallel date calculation. Surface the distinct states `not_loaded`, `in_progress`, and `frozen_verified`; do not imply that an in-progress Product-Wise source has a scheduler or recurring source until one is explicitly approved.