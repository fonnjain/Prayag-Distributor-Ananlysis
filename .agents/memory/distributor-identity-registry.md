---
name: Distributor identity registry
description: DIST#-backed distributor identity — merge rules, resolver semantics, fail-closed rule, and threshold caveats
---

# Distributor identity registry

- **Rule:** DIST# is the ONLY merge key for distributors. Two different DIST# are two distributors always; one DIST# with several spellings is one distributor. No-ID identity = name + state + district. Alternate spellings are persisted as ID-anchored aliases — never name-inferred merges.
- **Why:** a wrong distributor merge produces a false concentration figure the numeric guard cannot catch — every individual number stays correct.
- **How to apply:** resolve distributor names through the shared registry (persisted `distributor_identity` + alias table, synced from the Retailer-Distributor roster workbook and the Party TM Map bridge). Ambiguous lookups must return every candidate, never a first match.
- **Fail closed:** when the registry cannot load, identity-guarded entry points must refuse (503 / flagged node) rather than fall back to normalised-name matching — the fallback is exactly the silent blend the registry prevents.
- Trigram caveat: jaccardTrigram strips non-alnum, so keys differing only in spacing score 1.0 — such pairs must be INCLUDED in candidate reports (strongest candidates). Same-normKey raw-name pairs must surface too (they are what name-key joins silently blend). SHREE/SHRI-style variants score just below the 0.6 threshold — known gap.
- Empty-registry cache must be short: a Sheets 429 during the cold-start burst otherwise pins an empty registry for the full TTL.
