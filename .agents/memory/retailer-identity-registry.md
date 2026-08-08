---
name: Retailer identity (RET#) registry
description: RET# is the retailer identity in secondary SKU registers; merged-cell carry-forward, never-merge-on-name rule, and quota-safe backfill lessons.
---

# Retailer identity (RET#)

**Rule:** RET# is the retailer key; names are display only. Two RET#s = two retailers ALWAYS; one RET# with several spellings = one retailer. Never auto-merge on name similarity — surface candidate pairs for human decision, and ambiguous lookups must list all candidates instead of taking the first match.

**Why:** hundreds of RET#s appear under multiple distributors, and every tested same-name high-similarity pair turned out to be DIFFERENT retailers by ID — name-keyed queries silently merge and double-count.

**How to apply:**
- Identity cells in the SKU order sheets (RET#, date, order id, segment, retailer, distributor) are MERGED — without carry-forward, coverage reads ~15% instead of ~100%. A non-blank retailer-name cell starts a new carry block and must reset the carried RET#, or the previous block's ID leaks.
- Older FYs title the RET# column "ID"; newer ones "RETAILER ID". Row-serial columns (SR.NO) must never bind to the retailer-id field — only `RET#<digits>` forms are valid IDs (normalise + reject everything else so serial pollution can't recur).
- Column matchers: "RETAILER ID" startsWith "RETAILER", so name/id columns need exact matching, not prefix matching.
- Cross-period retailer joins must match ID-to-ID only when BOTH sides carry one, else name-to-name — a plain coalesce key mis-declares rows "new" when ID coverage is asymmetric.
- Backfills that change line UIDs need atomic per-FY replace: buffer all parsed rows, then delete+insert in ONE transaction only after every sheet read succeeded (a mid-read quota failure must never half-load an FY). Also: `arr.push(...rows)` overflows the call stack on ~300k-row tabs — loop instead.
- Register (non-SKU) rows carry no retailer id — consumers there stay name-keyed but must surface registry ambiguity counts rather than merging silently.
