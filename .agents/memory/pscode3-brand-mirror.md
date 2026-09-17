---
name: PSCode3 brand mirror chaining
description: FY2026-27 sku loader refreshes the brand-level mirror in the same transaction; audit 7.6 flags drift
---
**Rule:** `pscode3-load.ts --write` now deletes+reinserts BOTH `secondary_sku_line` (fy) and the `secondary_register_line` rows with `source='pscode3_brand_rollup'` in one transaction. `pscode3-brand-backfill.ts` remains only as a standalone repair tool — its mapping (brand=segment_raw, customer=retailer, head_canon=head_raw, line_uid='brl-'+sku uid) must stay byte-identical to the mirror step in the loader.

**Why:** the two tables were previously loaded by separate manual runs; forgetting the second left segment-spread/win-back/effective-discount views silently stale (found Aug 2026 with the mirror completely empty while sku table had Apr–Jun).

**Update (Sep 2026):** development contains a standalone Apr–Jun repair (89,179 rows, ₹59.02 Cr NET), but production does not. Treat the production gap as unresolved until the original source is rerun through the protected dual-write loader with hash, controls, provenance, and audit 7.6 coverage. Do not copy development rows into production.

**How to apply:** audit cross-foot check 7.6 (`cf_7_6_sku_vs_brand_mirror` in extraGroups.ts) compares authoritative, provenance-backed months. Factual readers may show accurate loaded months with a live Resolution-register disclosure; AI conclusions fail closed when requested months intersect the missing scope. Resolve the gap only through the reviewed protected loader.
