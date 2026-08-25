---
name: Register monthly full-replace pipeline
description: Open-FY register sync design (Aug 2026) — nightly per-month delete+insert replace, DB-persisted short-read baseline, clock-derived month freeze at 00:00 on the 8th (grace 1st–7th inclusive).
---

# Register monthly full-replace pipeline (supersedes versioned sync for open FY)

The sale register sheet has NO stable row identity (col-A serials renumber on re-sort; ~0.3% of rows are fully identical on every field). Any identity-key reconciliation (versionedSyncLines + tombstoneOrphans) doubles rows when the sheet re-sorts — this happened twice in production (July 2026, ₹41 Cr vs ₹26 Cr).

**Design:** Open months are atomically full-replaced from the source sheet; no unstable sheet serial or row-identity reconciliation is used.

**Why:** source-sheet re-sorts make row-level identity reconciliation unsafe, while a complete verified replacement preserves an exact DB snapshot.

**How to apply:** protect every month replacement with a shared FY/month transaction lock; reject materially short reads against the persisted baseline; freeze the month at midnight UTC on the 8th (the 1st–7th are the grace period).
