---
name: Authoritative MRP cache
description: Rules and limits for current MRP sourced from prayag-price.com.
---

The authoritative current-price source is `prayag-price.com`, read only. A refresh must validate a complete one-code snapshot, stage it under a new generation, and activate only that completed generation in the same database transaction. Do not modify the legacy MRP, sales, or margin tables during this proving period.

**Why:** An interrupted source read must retain the last known-good local catalogue. The currently available public product contract carries current MRP and division data but exposes neither a source batch/version token nor complete review lineage, so it cannot prove a consistent remote snapshot or auditable source approval.

**How to apply:** Use the active-cache current catalogue for present-day MRP lookups and retain legacy effective-dated history only for as-of calculations until the authority exposes history. Preserve one price row per item code and put any multi-division membership in a child mapping; callers must explicitly choose a segment for a multi-division code. Never fabricate upstream batch or review fields—surface missing lineage as incomplete provenance.