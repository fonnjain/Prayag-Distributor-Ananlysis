---
name: Secondary person-level target engine
description: Conventions for the salesperson/State-Head target engine (T2) — basis, overrides, guards, fallback chain.
---

- **Basis rule:** person-level targets compute on `secondary_sku_line` (retailer × item_code); company/distributor targets stay on the primary engine. The two are labelled, never blended — different populations that will not reconcile.
  **Why:** salesperson names only exist on the secondary register; the primary register has no member attribution for open FYs.
- Attribution: baseline `head_canon` → roster member via `normSecKey`; ~₹13.5 Cr of the FY baseline sits under 58 non-roster names (mostly departed) — reported as "not attributed", never force-mapped.
- Segment mix per person comes from `item_master.item_group` → `canonItemGroup` (secondary_sku_line.segment_canon is ~96% blank); unmatched mass follows a flat monthly curve.
- New-customer pool: registered roster retailers (RET# rows, state col 10) minus each state's members' DECLARED retailer counts (Data-tab BH), clamped ≥0. Strict RET#-ID matching against secondary lines is only a lower bound (most lines carry names) — keep it as `idVerifiedCoverage`, never use it as the pool.
- Override semantics: user edit stores a plain NUMBER in `engine_targets` (`secmember|<nsk>` / `sechead|<nsk>`, params row shared with primary engine); the EFFECTIVE combined must reflow into the route split and head sums, or the table stops reconciling after any edit.
- Fallback chain (never zero): state median (≥3 sound peers) → national median → per-capita share of the attributed company baseline. Members with 0 allocated uncovered retailers get their new-customer weight moved to new-SKU with a visible flag.
- **How to apply:** any change to route splits, guards, or pool attribution must keep member routes summing to combined and head rows equal to the sum of member effective values.
