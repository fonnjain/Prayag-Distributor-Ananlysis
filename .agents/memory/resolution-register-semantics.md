---
name: Resolution register semantics
description: Durable rules for known data holds, pending answers, coverage, and retained resolution evidence
---

Only an open HOLD with `blocks_api=true` can make a factual figure unavailable. A non-blocking HOLD may require a linked coverage disclosure while preserving accurate loaded-period values. It applies to explicitly named measures, products, and periods; unaffected measures remain available. PENDING records accountability but never changes a calculation or API response.

**Why:** Returning zero, omitting held periods, or blocking an entire month can create false business conclusions. Pending confirmations describe uncertainty without proving that a displayed figure is wrong.

**How to apply:** Return the affected value as unavailable with structured hold identity, reason, scope, resolution link, and requested/held/available period coverage. Never silently remove a held period from an average.

AI and other inferential surfaces may fail closed even when the underlying HOLD is non-blocking for factual tables.

**Why:** A clearly labelled one-month table can remain true, while a narrative that generalises that month into a full-period conclusion can be materially false.

**How to apply:** Keep accurate factual rows visible with exact coverage, status, owner, and resolution link. Withhold only the conclusions whose requested period intersects missing coverage; a coverage lookup failure must not be interpreted as proof that no gap exists.

Resolved, answered, and accepted-as-is records are retained and their closure evidence is immutable.

**Why:** The register is the audit history of accepted gaps and decisions; rewriting a closed record destroys the evidence needed to understand past exclusions.

**How to apply:** Changes to a closed item require a new linked record rather than editing or resolving the old row again. Forward migrations may upgrade exact legacy seed values but must not overwrite administrator edits.