---
name: Employee-code identity policy
description: Rules for safely handling shared employee codes and historical numeric registry keys.
---

Employee codes are supporting roster evidence, not person identity keys. Any lookup by
employee code must return no match, one match, or an explicit ambiguous candidate set;
it must never select the first candidate. Numeric legacy registry keys are source aliases
for historical attribution, not canonical people identifiers. New registry identities use
normalized name plus reporting-manager evidence, while a re-seed must recognize the same
existing name-and-manager record even if its historical key is numeric.

**Why:** HR source data can legitimately reuse a code for more than one person. Treating it
as unique silently merges people and can misattribute operational alerts or reporting.

**How to apply:** Before adding a person-resolution path, decide whether it is identity
resolution or legacy source matching. For identity resolution, require unambiguous evidence.
For source matching, retain all candidates and leave ambiguous rows unresolved rather than
backfilling, alerting, or attributing them to an arbitrary person.

For a production correction, use a new forward migration that audits every changed
registry-to-Person link, validates normalized name plus the Person hierarchy's manager
evidence, and clears unsupported links before selectively relinking them. Never rely on
editing already-recorded migrations to repair deployed data.

When producing a derived person-to-state map, count every identity candidate before
filtering for a usable state. A duplicate with a null state is still ambiguous and must
block attribution rather than allowing the populated duplicate to win.