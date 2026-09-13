---
name: Audit manifest invariants
description: Rules that keep audit checks visible when dependencies fail and distinguish N/A from not evaluated.
---

Every audit group must declare its expected keys inside the group before dependency evaluation. Produced keys outside that manifest are errors; missing declared keys become explicit not-evaluated rows.

**Why:** Reconstructing keys after a failure cannot recover checks that disappeared before producing output, which previously made the total count unstable.

**How to apply:** Derive static and dynamic keys from pre-evaluation configuration, finalize inside the group, and require expected = evaluated + not evaluated across API, workbook, UI, and release verification.

Legitimate skip/N/A and pending business outcomes count as evaluated. Only checks that could not execute because a dependency failed count as not evaluated.

**Why:** Status describes the business result; evaluation describes whether the check actually ran. Conflating them makes valid N/A results look like outages.

**How to apply:** Keep status and evaluation as separate fields and aggregate totals from evaluation, never from status.