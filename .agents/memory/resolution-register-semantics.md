---
name: Resolution register semantics
description: Durable rules for known data holds, pending answers, coverage, and retained resolution evidence
---

Only an open HOLD can make a figure unavailable. It applies to explicitly named measures, products, and periods; unaffected measures remain available. PENDING records accountability but never changes a calculation or API response.

**Why:** Returning zero, omitting held periods, or blocking an entire month can create false business conclusions. Pending confirmations describe uncertainty without proving that a displayed figure is wrong.

**How to apply:** Return the affected value as unavailable with structured hold identity, reason, scope, resolution link, and requested/held/available period coverage. Never silently remove a held period from an average.

Resolved, answered, and accepted-as-is records are retained and their closure evidence is immutable.

**Why:** The register is the audit history of accepted gaps and decisions; rewriting a closed record destroys the evidence needed to understand past exclusions.

**How to apply:** Changes to a closed item require a new linked record rather than editing or resolving the old row again. Forward migrations may upgrade exact legacy seed values but must not overwrite administrator edits.