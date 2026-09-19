---
name: Product-Wise SKU cutover
description: Rules for the Aug-26 Product-Wise CRM source seam into raw SKU data.
---

Product-Wise CRM is a source seam, not a rewrite: map its August-onward retailer-level lines into the existing raw SKU shape, preserving names and explicit RET#/DIST# IDs while leaving prior source rows and their new ID columns untouched.

**Why:** Product-Wise Basic Order Value is the approved ex-GST NET basis, but Dealer Order Value is GST-inclusive and is not comparable to the legacy gross measure. Inventing a gross amount or backfilling old stable IDs would create false financial and identity evidence.

**How to apply:** For Product-Wise loads, populate `net_amount` only from Basic Order Value; leave incompatible gross fields null and do not create gross-required mirrors. Require the approved source fingerprint, one-month replacement scope, retained provenance, and the frozen July RET# population-continuity gate. Do not add scheduling or ID-based consumer rewiring until a genuine recurring source is approved.

The August raw-SKU copy keeps the existing `register_month_state` freeze policy. From September 2026, Product-Wise order bookings instead have one authoritative home in `secondary_order_line`; do not duplicate them into `secondary_sku_line`. Each approved source is a versioned manifest with fingerprint, cutoff, completeness, and freeze time. Replacements must be monotonic (never earlier cutoff or complete→partial), and September stays replaceable through 31 December 2026 before freezing at 1 January 2027 IST.

**Why:** September introduced recurring partial Product-Wise exports. Writing the same source independently to two tables can diverge, while a fixed next-month lock would block the approved later full-month replacement.

**How to apply:** Keep August’s protected raw-SKU path separate. For September onward, load only an approved manifest into the order table using transactional month replacement, strict identity collision checks, retained duplicate occurrences, post-write reconciliation, and persisted operator/source evidence.

Product-Wise and PSCode3 have a permanent source seam. PSCode3 ends on 31 July
2026; Product-Wise begins on 1 August 2026, so no overlapping CRM month exists
and cross-source retailer-item equality is unprovable from CRM data.

**Why:** The lowest Product-Wise order is dated 1 August. Aggregate sources that
span both months measure different grains (member dashboards or primary
dispatch) and cannot establish a conversion between PSCode3 NET and Product-Wise
Basic Order Value.

**How to apply:** Product-Wise-only periods may be used on Basic Order Value,
ex-GST with source/cutoff/completeness metadata. Keep pre-August and post-August
retailer-item arithmetic separate forever; refuse mixed sums and trends. Gross
derived through discount must remain labelled derived, and rows without
effective MRP are unavailable/not offered, never zero.