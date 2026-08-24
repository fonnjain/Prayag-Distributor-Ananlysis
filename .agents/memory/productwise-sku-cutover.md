---
name: Product-Wise SKU cutover
description: Rules for the Aug-26 Product-Wise CRM source seam into raw SKU data.
---

Product-Wise CRM is a source seam, not a rewrite: map its August-onward retailer-level lines into the existing raw SKU shape, preserving names and explicit RET#/DIST# IDs while leaving prior source rows and their new ID columns untouched.

**Why:** Product-Wise Basic Order Value is the approved ex-GST NET basis, but Dealer Order Value is GST-inclusive and is not comparable to the legacy gross measure. Inventing a gross amount or backfilling old stable IDs would create false financial and identity evidence.

**How to apply:** For Product-Wise loads, populate `net_amount` only from Basic Order Value; leave incompatible gross fields null and do not create gross-required mirrors. Require the approved source fingerprint, one-month replacement scope, retained provenance, and the frozen July RET# population-continuity gate. Do not add scheduling or ID-based consumer rewiring until a genuine recurring source is approved.

Product-Wise month permanence shares the existing `register_month_state` and the shared month-freeze clock: a month locks on the 7th of the next month, with no unfreeze path. A range upload skips an already frozen month entirely and full-replaces only its open months; each Product-Wise row retains both its source filename and the shared freeze timestamp.

**Why:** Manual exports routinely include an already-closed month. A separate Product-Wise clock could disagree with the register/margin state and reintroduce duplicate or altered historical figures.

**How to apply:** Keep all Product-Wise loaders on the shared freeze decision/state; never add a bypass or reset endpoint. The API status must expose every month/source pair's frozen state and source evidence.