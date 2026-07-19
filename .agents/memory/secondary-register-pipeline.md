---
name: Secondary register pipeline fixes
description: Key decisions and verified state for the secondary register pipeline — schema, TM column, FY2023-24 all-tabs, validators, and control totals.
---

## Schema change
`secondary_register_line` replaced the single `amount` column with:
- `gross_amount` — Order Value (NOT NULL numeric)
- `net_amount`   — Sub Total column when present; discount-carry fallback for blank continuation rows (nullable)
- `discount_pct` — parsed from "33.90 (%)" format (nullable)

## TM column fix (critical)
**Root cause:** `secondary_column_maps.json` listed head tokens in order
`["STATEHEAD","HEAD","SALESHEAD","DISTRIBUTOR"]`. Col[10] = "DISTRIBUTOR" matched
before col[13/14] = "TEAM MEMBER" / "TEAMMEMBER", so headRaw was filled with
distributor names (not TM names) for every FY.

**Fix:** tokens reordered to `["TEAMMEMBERNAME","TEAMMEMBER","STATEHEAD","HEAD","SALESHEAD"]`.
All three FYs now read the correct Team Member column.

**Why this matters:** `line_uid` includes `headRaw`. Changing headRaw from distributor to
TM name changes all `line_uid` hashes — any previously ingested rows must be cleared and
re-synced before the fix rows can be inserted (ON CONFLICT DO NOTHING would silently pass
old hashes through).

## Sub Total as net_amount source
`net_amount` column token `["SUBTOTAL","SUBTOTL"]` was added to `secondary_column_maps.json`.
`parseSecRegisterRow` now reads the Sub Total cell directly. The loader's discount-carry
only computes `net_amount` when the Sub Total cell was blank (continuation rows where the
Sub Total is populated only on the first row of an order group).

## FY2023-24 tab_strategy="all"
The FY2023-24 workbook has two data tabs (Data Sheet = Apr-23; Data-Sheet = May-23 to Mar-24)
plus one copy tab (June = copy of Data Sheet) and several report/query tabs.

Rules that must hold for "all" strategy:
1. **Per-tab occurrence counters** — fresh `parseRows` call per tab so occurrence counts restart.
2. **In-memory dedup by line_uid** — removes copy tabs (June: 16,302 dupes removed after TM fix).
3. **For-loop push** — `push(...spread)` causes V8 stack overflow on 245k-row tabs; always use `for (const l of tab.lines) allLines.push(l)`.
4. **dataRows = pre-dedup total** — row-accounting identity `dataRows + excluded + blank == rowsRead` holds only when dataRows is the pre-dedup sum, not `dedupedLines.length`.
5. **Suppress "no header" errors** — report/summary tabs produce zero lines and a "No secondary register header found" error; filter these out before adding to `totalErrors`.
6. **3 non-deduped June rows** — after the TM fix, 3 June-tab rows have a TM name that differs from their Data Sheet counterpart (blank in Data Sheet, filled in June). These produce distinct line_uids and are included as separate rows → FY2023-24 count is 261,540 not 261,537.

## head_alias.json structure
Keys are UPPERCASE-normalised raw names (matching the `raw.toUpperCase().trim()` lookup in `normalizeHead`).
- First 22 entries: primary-pipeline state-head abbreviations (SANDEEP JI, RIZVI JI, etc.).
- Remaining 337 entries: secondary-register TM canonical aliases covering all unique TM names across FY2023-24, FY2024-25, FY2025-26.
- Near-duplicates resolved: JITENDERBIRLA → "Jitender Birla"; "RAVI KUMAR ." → "Ravi Kumar"; "ARUN KUMAR.S" → "Arun Kumar S"; "SOMASUNDARAM.P" → "Somasundaram P", etc.
- When adding future FYs, new TM names that fail `unmapped_heads_empty` must be added here.

## Verified row counts and gross totals (all validators PASS)
| FY      | Rows (post-dedup) | Gross (Order Value) | Unique TMs |
|---------|-------------------|---------------------|------------|
| 2023-24 | 261,540           | ₹313.33 Cr          | 207        |
| 2024-25 | 335,256           | ₹414.48 Cr          | 230        |
| 2025-26 | 379,439           | ₹458.61 Cr          | 202        |

## sum_by_head_consistent validator
Unmapped-head rows route into `"(unmapped)"` bucket so cross-foot always closes.
`unmapped_heads_empty` is the separate validator that enforces complete TM coverage.

**Why:** sum_by_head_consistent purpose is to ensure no amounts are lost (NaN or skipped).
TM mapping coverage is a separate concern (unmapped_heads_empty).
