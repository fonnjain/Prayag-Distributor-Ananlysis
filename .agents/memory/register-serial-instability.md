---
name: Register serial instability doubles open-FY months
description: Sheet column-A serials shift on re-sort; serial in identity key causes mass duplicate inserts that blast-radius guard then protects.
---

The FY2026-27 register sheet renumbers/re-sorts its column-A serials as new rows are added. The same physical line (invoice|code|color|qty) can carry a different serial on every read.

**Rule:** never use the sheet serial as part of row identity for matching. Identity must be invoice|code|color|qty|month + an occurrence index for genuine duplicate lines; serial is display-only.

**Why:** twice (30 Jul and 1 Aug 2026) production July doubled (~9,200 phantom inserts per sync, ₹41.26 Cr vs sheet ₹25.90 Cr, negative Pending). Mechanism: serial shift → all identities "new" → mass insert → displaced rows orphaned → tombstoneOrphans halts on the 10% blast-radius guard → old+new both stay current. The serial-inclusive key sees zero duplicates, so no invariant fires. Revive pre-flight and the rows_per_month baseline were innocent — baseline only guards short reads, nothing guards identity churn.

**How to apply:** treat sheet row order and serial columns as unstable in any register/sheet loader. Diagnostic signature of this failure: two ingested_at day-batches both current, 0 duplicate serial-inclusive identities, thousands of cross-batch matches when serial is ignored, tombstone log "blast-radius limit exceeded". FIXED Aug 2026 by abandoning identity-key reconciliation entirely — see [register-monthly-replace.md](register-monthly-replace.md) (nightly per-month full replace). Legacy versioned-sync code remains only behind manual routes.
