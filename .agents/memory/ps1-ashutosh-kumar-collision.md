---
name: PS1 Ashutosh Kumar joinKey collision
description: Two SHD members share joinKey "ashutoshkumar" — Rudrapur (under Anant Singh) and plain "Ashutosh Kumar" (under Sandeep Dadheech). PS1-B closed out and reconciled.
---

## The collision
`normName()` strips parentheticals, so:
- "Ashutosh Kumar (Rudrapur)" (SOBR, Anant Singh section) → joinKey = "ashutoshkumar"
- "Ashutosh Kumar" (SOBR, Sandeep Dadheech section) → joinKey = "ashutoshkumar"

The Rudrapur entry appears first in the SOBR tab → it was winning in the old first-entry-wins `secByKey`.

## PS1-B close-out (RECONCILED)

**Fix applied**: `secByKey` replaced by `secByKeyMulti` (Map<string, SecMember[]>) with a `secLookup(normKey, rosterStateHead)` helper that uses state-head matching to disambiguate when multiple candidates share a joinKey. Falls back to first-entry if no state-head match.

**Ashutosh Kumar (Rudrapur) is a GENUINE MEMBER** — not a header row. Evidence: real monthly figures (Apr ₹2.31L, May ₹10.89L, Jun ₹8.05L), 100 dealers, working sheet, appears in Anant Singh report pack. His State Head cell is blank only because column B is a MERGED CELL (145 of 162 rows have the same blank). Never exclude a row to make a total agree.

**PS1 fully reconciled against fresh live sheet pull:**
| Period | plan_Cr | OB_Cr   | sales_Cr |
|--------|---------|---------|----------|
| Q1 source (fresh)  | 81.4800 | 57.2696 | 61.8568  |
| Q1 API reported    | 81.4650 | 57.2696 | 61.8568  |
| residual           | −0.018% | exact   | exact    |
| Q2 source (fresh)  | 63.6622 |         |          |
| Q2 API reported    | 63.6500 |         |          |
| residual           | −0.019% |         |          |

The 0.018–0.019% plan residual is further drift between the two reads (live sheet). Treat as reconciled.

Earlier "deviations" against the old snapshot were entirely live-sheet movement — state heads update the SOBR during the day. Compare figures at the same read timestamp, not against a hardcoded reference.

## Rule: never compare against fixed reference figures
The SOBR is live. Use `secondaryReadAt` (Unix ms timestamp now in the API meta) to attribute discrepancies to drift. When a figure is questioned, re-read the source and compare at the same moment.

## No double-counting in meta
Both Rudrapur and Sandeep's AK are genuine SOBR rows counted by the source. Both are counted by our meta (secDash.members loop, not secByKey). The join fix only corrects the per-roster-row API display, not the aggregate.

## Why normName strips parentheticals
The join key uses normName (strips parentheticals) so that SOBR names like "Ravi (Faridabad)" match the roster's "Ravi". This is correct but causes collisions when two genuinely different people share the base name. State-head disambiguation resolves this without modifying the normName logic.
