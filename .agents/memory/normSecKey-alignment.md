---
name: normSecKey alignment
description: Five files aligned so every member lookup key uses normSecKey (keeps parentheticals) instead of normName (strips them). This fixed the Ashutosh Kumar / Ashutosh Kumar (Rudrapur) dedup collision.
---

## The rule
All maps keyed by member name must use **normSecKey** (keeps parentheticals), never normName alone.
`roster.ts` `normKey` = normSecKey. Every map looked up via `r.normKey` or `m.normKey` must use the same function.

## Files changed
| File | Change |
|---|---|
| `roster.ts` | `tryHrRoster` + `loadFallbackRoster` normKey = normSecKey. Dedup compound key stays normName (for extras join). |
| `distributorTmMap.ts` | `memberNormKey = normSecKey(memberName)` — keys byPartyKey, distCountByMember, ddCountByMember |
| `mgmt.ts` | `secByKeyMulti` indexed by `sm.normKey` (normSecKey), not `sm.joinKey` (normName) |
| `hrSfaDashboard.ts` | `nk = normSecKey(name)` so `hrSfa.get(r.normKey)` hits correctly |
| `orders.ts` | `key = normSecKey(tmRaw)` so `agg.perTm.get(member.normKey)` hits correctly |

## What did NOT change
- `primaryTargets.ts` `buildPrimaryTargetMapFromStateTargets` uses state-head names as keys (no parentheticals), so normName vs normSecKey is irrelevant there.
- `roster.ts` extras Map still uses normName as key — the secondary-tab lookup doesn't have parenthetical names, so normName is correct there.

**Why:** normName strips "(Rudrapur)" → collision between two Ashutosh Kumars. normSecKey keeps it → unique key per member. Without this, the second member was silently dropped from the roster dedup Set.

**How to apply:** Any new per-member aggregation map (perTm, perHead, hrSfa, etc.) must be keyed by normSecKey. Any new roster field used as a join key must use `m.normKey` (already normSecKey after this change).

## Known residual gaps (post-fix)
- Ashutosh Kumar (Rudrapur) has no section in the order booking working sheet → totalRetailers / orderBooking from working sheet = null.
- Anant Singh active count shows 10 (roster) vs 11 (HR expectation) — one HR member absent from the dashboard Data tab; pre-existing data gap.
- Booking figure ₹28.99L from secondary register (live data updated since baseline was set).
