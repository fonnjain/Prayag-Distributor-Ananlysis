---
name: Unverified coverage aliases
description: How historical register-label compatibility aliases are exposed without asserting identity or rewriting coverage.
---

Live coverage compatibility aliases must have one registry that supplies their report, export, and people-detail metadata. An alias marked `UNVERIFIED ALIAS` is evidence for review only: it never confirms identity and never authorizes a coverage, person, customer, or sales reassignment.

**Why:** Historical Tamil Nadu register label `Babu` has an active-person compatibility mapping but HR also identifies a separate departed `S.Babu`; collapsing the distinction would silently turn uncertain evidence into a factual attribution.

**How to apply:** Keep historic migration literals unchanged as an audit record. Add or remove current mappings only in the live registry, surface the source label and materiality everywhere a reviewer sees the derived coverage, and require a business decision before any corrective migration.