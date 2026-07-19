---
name: Secondary register pipeline fixes
description: Key decisions and known limitations from the gross/net split + FY2023-24 all-tabs strategy work.
---

## Schema change
`secondary_register_line` replaced the single `amount` column with:
- `gross_amount` — Order Value (NOT NULL numeric)
- `net_amount`   — Sub Total / after discount (nullable)
- `discount_pct` — parsed from "33.90 (%)" format (nullable)

Column token priority in `secondary_column_maps.json`: Order Value detected first; Sub Total is net fallback.

## FY2023-24 tab_strategy="all"
The FY2023-24 workbook has two data tabs (Data Sheet = Apr-23; Data-Sheet = May-23 to Mar-24) plus one copy tab (June = copy of Data Sheet) and several report/query tabs (REPORT 1–4, Sheet5, Sheet10).

Rules that must hold for "all" strategy:
1. **Per-tab occurrence counters** — fresh `parseRows` call per tab so occurrence counts restart.
2. **In-memory dedup by line_uid** — removes copy tabs (June: 16,305 dupes removed).
3. **For-loop push** — `push(...spread)` causes V8 stack overflow on 245k-row tabs; always use `for (const l of tab.lines) allLines.push(l)`.
4. **dataRows = pre-dedup total** — row-accounting identity `dataRows + excluded + blank == rowsRead` holds only when dataRows is the pre-dedup sum, not `dedupedLines.length`.
5. **Suppress "no header" errors** — report/summary tabs produce zero lines and a "No secondary register header found" error; filter these out before adding to `totalErrors`.

## Verified row counts and gross totals
| FY      | Rows (post-dedup) | Gross (Order Value) |
|---------|-------------------|---------------------|
| 2023-24 | 261,537           | ₹313.32 Cr          |
| 2024-25 | 335,256           | ₹414.48 Cr          |
| 2025-26 | 379,439           | ₹458.61 Cr          |

## sum_by_head_consistent validator fix
Old code counted rows with `headRaw` but null `headCanon` as "dropped" and excluded them from the byHead sum, causing delta = grandTotal → hard fail.

Fix: route unmapped-head rows into an `"(unmapped)"` bucket so every row is in exactly one bucket and cross-foot always closes. `passed = (badAmounts === 0 && delta <= 1)`. The `unmapped_heads_empty` validator separately reports which raw names need to be added to `head_alias.json`.

**Why:** sum_by_head_consistent purpose is to ensure no amounts are lost (NaN or skipped). TM mapping coverage is a separate concern (unmapped_heads_empty).

## Structural limitation: unmapped_heads_empty always fails for register FYs
All three register FYs (2023-24, 2024-25, 2025-26) use a **Distributor** column as the head field — there is no TM column. This means 239–270 distributor names appear as unmapped heads. `unmapped_heads_empty` will always fail for these FYs.

This does NOT block data quality: cross_foot, sum_by_head_consistent, all_months_present, and no_negative_amounts all pass. The amounts are fully accounted for in the `"(unmapped)"` bucket.

To resolve: either populate `head_alias.json` with all distributor → TM mappings (requires business decision), or accept this as expected for distributor-level registers.
