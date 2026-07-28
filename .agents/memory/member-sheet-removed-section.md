---
name: Member working-sheet removed section
description: Layout of the "Removed Parties" section in Summary Report tabs and how it is parsed.
---

## The pattern

Working sheets have two sections in the Summary Report tab:

1. **Active section** (rows above the break): numbered rows — col A holds integer serial (1, 2, 3…), col C holds retailer name.
2. **Section header row**: col B holds "Removed Parties" (col C is blank on that row).
3. **Removed section** (rows below the break): no integer serial in col A, names in col C, city column often says "Removed".

The removed retailers carry real prior-year business and are win-back candidates.

## Stop rules (either is sufficient)

- col B (or col C) normalised text is in `SECTION_HEADER_TOKENS` → switch to removed phase
- col C has name text but col A has no integer serial → switch to removed phase (first removed row)

**Why:** The old blank-run guard (3 consecutive blanks) never fired because rows 103–104 between sections are only 1–2 blank rows.

## Parser output

- `MemberSheetResult.rows` = active section only (serial-numbered rows)
- `MemberSheetResult.removedRows` = removed section rows
- `RetailerSpread.removedRetailers` = count of removed rows (excluded from all spread metrics)
- `AiPayload.coverage.removed` = same count
- `AiPayload.formerRetailers` = `{ count, names[] }` when removed section is present (null otherwise)

## Which members have removed sections (FY 2026-27, Anant Singh team, July 2026)

| Member | active | dormant | removed |
|---|---|---|---|
| Ravinder Puri | 74 | 22 | **64** |
| Prasun Chatterjee | 34 | 39 | **47** |
| Manish Gupta | 71 | 23 | **39** |
| Rinku | 22 | 12 | **5** |
| Ravi (Faridabad) | 5 | 33 | **11** |
| Shivam Chauhan | 79 | 57 | **58** |
| Ashutosh Kumar (Rudrapur) | 52 | 48 | 0 |
| Ankit Kumar | 48 | 30 | 0 |
| Tarun Giri | 43 | 11 | 0 |
| Rahul Singh | 5 | 59 | 0 |

6/10 members have a removed section. Total removed rows = 224.

## Prior-year OB for removed retailers

`RetailerRow` reads fixed DEFAULT_COL positions (current-FY OB/sale only). Prior-year business for removed retailers is NOT in `removedRows` fields — cross-reference `secondary_register_line` by retailer name for historical volumes.
