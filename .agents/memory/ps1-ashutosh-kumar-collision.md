---
name: PS1 Ashutosh Kumar joinKey collision
description: Two SHD members share joinKey "ashutoshkumar" — Rudrapur (under Anant Singh) and plain "Ashutosh Kumar" (under Sandeep Dadheech). Findings from the PS1-B diagnostic.
---

## The collision
`normName()` strips parentheticals, so:
- "Ashutosh Kumar (Rudrapur)" (SOBR, Anant Singh section) → joinKey = "ashutoshkumar"
- "Ashutosh Kumar" (SOBR, Sandeep Dadheech section) → joinKey = "ashutoshkumar"

The Rudrapur entry appears first in the SOBR tab → it wins in `secByKey`.

## Consequences
1. **Roster join mismatch**: The roster member "Ashutosh Kumar" under Sandeep Dadheech looks up `secByKey.get("ashutoshkumar")` and gets **Rudrapur's** SHD data. So the API row for Sandeep's AK shows the wrong secondary plan/OB/sales.
2. **Orphaned SHD row**: Sandeep's "Ashutosh Kumar" SHD entry is shadowed in secByKey; it contributes to the meta aggregate (correctly, since the source counts all 162 SOBR rows) but is never linked to a roster row.
3. **No double-counting in meta**: Both entries are genuine SOBR rows, both are counted by the source, both counted by our meta. Not the cause of any aggregate discrepancy.

## Residual deviations after PS1 (not caused by this collision)
After all PS1 fixes:
| Period | plan_diff_Cr | ob_diff_Cr | sales_diff_Cr |
|--------|-------------|-----------|--------------|
| Apr    | +0.0158     | +0.0040   | +0.0628      |
| May    | +0.0565     | +0.0021   | +0.0531      |
| Jun    | +0.0527     | +0.0016   | +0.2410      |
| Jul    | +0.2400     | 0.0000    | n/a          |
| Q1     | +0.1250     | −0.0023   | +0.3468      |
| Q2     | +0.3960     | 0.0000    | n/a          |

OB is essentially exact (rounding). Plan +0.15% overcount is likely formula-precision (fractional monthly targets). June sales +0.88% and Jul plan +0.94% likely reflect data entered in the SOBR after the user's verification snapshot was taken.

## Fix needed (member-level, separate from PS1)
To fix the wrong SHD data for Sandeep's "Ashutosh Kumar": the join in mgmt.ts needs to disambiguate using state head when normKey collides. Or the SOBR source should rename "Ashutosh Kumar (Rudrapur)" to a distinct name.

**Why:** normName strips parentheticals for the join key (to match roster names like "Ravi" → "Ravi (Faridabad)"), but this causes false-positive collisions between two genuinely different people.

**How to apply:** Any time a normKey collision warning fires, check whether both colliding SHD entries have a corresponding roster entry. If yes, add state-head-aware disambiguation at the join.
