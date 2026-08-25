---
name: Product-Wise monthly source lock
description: Immutability policy for verified Product-Wise CRM source months.
---

Product-Wise CRM source loads follow the shared monthly lock: once a successfully loaded month reaches its freeze instant, its fingerprint, source controls, and uploader evidence must remain immutable. A replacement then requires an explicit operator and business reason, recorded in an append-only override audit trail before the replacement can proceed.

**Why:** Product-Wise raw SKU rows underpin retailer-facing and B3/S1 analysis. Later exports must not silently rewrite the source evidence after the period is closed.

**How to apply:** Keep successful-load provenance and overrides append-only. Surface the distinct states `not_loaded`, `in_progress`, and `frozen_verified`; do not imply that an in-progress Product-Wise source has a scheduler or recurring source until one is explicitly approved.