---
name: SD4 Rizvi distributor deep dive
description: Per-state whitespace/effective-count additions, blankOb reconciliation, and known count-drift + cold-cache behaviours of the distributor deep dive.
---

## Durable lessons

- **Cold-cache partial loads look like data loss.** The distributor deep dive races each member sheet against a 60s timeout; right after a server restart a big team (32–74 sheets) returns `membersLoaded` far below the roster with NO error and NO log warning captured. Retry the same request until `membersLoaded` equals the roster size — caches warm incrementally (Rizvi needed 2 passes, Sandeep ~10).
- **Two retailer-count vocabularies.** Sales Deep Dive `teamSummary.totalRetailers` sums the Data-tab TOTALRETAILERS column; the distributor page counts live member-sheet rows (excl. Removed). They drift member-by-member in both directions (Rizvi Aug 2026: 2,624 dashboard vs 2,646 sheet rows across 25 of 32 members). This is source drift, not a grouping bug — report both, don't force them equal.
- **Direct-dealer reconciliation is on blank-row OB, not blank-row count.** 16 of Rizvi's members have blank rows, but exactly 7 have blank OB > 0 and those sum to the dashboard's ₹61,57,806.74. `perMember.blankOb` exists for this check.
- **Per-state whitespace** is filled after Step 13 by majority-vote district→state mapping over retailer rows, mirroring territory-total filters exactly (coverage = gapType "both", assignment = "assignment"), so state rows always sum to territory totals.
- **Concentration per state** is exposed as effective counts (`effectiveDistributors`, `effectiveRetailers` = 10,000 / HHI over OB shares) in `byState`, never a raw HHI gauge.

## Verified anchors (Aug 2 2026, FY2026-27)
- Rizvi: 32/32 sheets, corr −0.3768 (n=32) vs Anant −0.90 / Sandeep −0.33; blank group ₹61,57,806.74 / 7 members; partyObTotal = named + shared OB by construction.
- Anant Singh today reads corr −0.6218 (n=10) — differs from the −0.90 anchor due to live sheet drift (Rahul Singh sheet now loads); unchanged by SD4 code.
- Sandeep Dadheech: corr −0.3309, n=66, partyOb 35,36,59,848.59 — matches anchor exactly, pre/post identical.
