---
name: Name normalisation families
description: Which normalisation each name-join family uses; why they must not be unified; distributor directory distKey rename
---

Four deliberate normalisation families coexist — they are matched-pair systems, not inconsistencies:

1. **normSecKey** (person/member keys): lowercase alphanumerics, keeps parentheticals. SQL equivalent `LOWER(REGEXP_REPLACE(x,'[^a-z0-9]','','gi'))`. Person-name SQL joins (person_registry ↔ person) must use this form.
2. **normDistKey** (distributor vocabulary): UPPERCASE + single spaces + variant merges (TRADERS→TRADE). Persisted in distributor_tier_override, deep-dive snapshots, registry byNormKey, frontend URLs — never change its output values. Idempotent on its own output.
3. **headNormKey / head_canon** (secondary loader): lowercase space-collapse. Migration 034's display_key deliberately mirrors it. Full-stripping 034 would newly attribute ~₹3.97 Cr across 12 head buckets (s.tirumala rao, ravi faridabad, …) — head totals move, so it must stay space-collapse.
4. **UPPER+TRIM exact** (headAliasLookup / registers/secondary normalize / TERRITORY_HEADS): alias tables and lookups use the same key on both sides — consistent pair, do not "upgrade".

**Why:** two production incidents came from a person-name SQL join using space-collapse only (dotted vs undotted spellings of the same person). The fix is normSecKey-equivalent SQL **plus an employee-code conflict guard** — full-strip can collide genuinely different people whose names differ only in punctuation but who carry different employee codes. Never name-merge when both sides carry differing codes.

**How to apply:** the distributor directory response field is `distKey` (renamed from the misleading `normKey`, Aug 2026) — it holds normDistKey form; pass it RAW to `dist=` on the distributor-tab route (lowercasing it makes resolveTabScope throw and guard live checks silently SKIP). Migration 045 re-runs person_id population with the corrected SQL.
