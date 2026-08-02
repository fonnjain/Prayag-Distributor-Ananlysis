---
name: PSCode3 brand mirror chaining
description: FY2026-27 sku loader refreshes the brand-level mirror in the same transaction; audit 7.6 flags drift
---
**Rule:** `pscode3-load.ts --write` now deletes+reinserts BOTH `secondary_sku_line` (fy) and the `secondary_register_line` rows with `source='pscode3_brand_rollup'` in one transaction. `pscode3-brand-backfill.ts` remains only as a standalone repair tool — its mapping (brand=segment_raw, customer=retailer, head_canon=head_raw, line_uid='brl-'+sku uid) must stay byte-identical to the mirror step in the loader.

**Why:** the two tables were previously loaded by separate manual runs; forgetting the second left segment-spread/win-back/effective-discount views silently stale (found Aug 2026 with the mirror completely empty while sku table had Apr–Jun).

**Update (Aug 2026):** mirror for FY2026-27 was empty again after the Apr–Jun PSCode_3 drop; repaired by running the identical delete+insert SQL directly (89,179 rows, ₹59.02 Cr NET), 7.6 back to green. Live-year segment-spread views now attach a coverage note derived from `DISTINCT month_label` (secondaryCoverageNote in skuSpread) — open FY wording "not loaded yet", closed FY wording "data gap"; never hard-code a month range.

**How to apply:** audit cross-foot check 7.6 (`cf_7_6_sku_vs_brand_mirror` in extraGroups.ts) compares per-month NET between the two tables and fails on >₹1 drift; if it fires, re-run the loader with --write (or the backfill repair script). If the mirror mapping changes, change it in BOTH scripts and keep 7.6 green.
