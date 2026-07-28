---
name: Cross-FY head_canon key splits
description: Six head_canon aliases that differ across fiscal years, causing false zero LY in YoY queries. DB diff confirmed Jul 2026.
---

## The problem

`sale_line.head_canon` for FY2023-24 through FY2025-26 preserves pre-alias raw-normalised values. In FY2026-27 the aliases in `head_alias.json` took effect (either added or corrected after older ingestion). Six pairs of head_canon values are each used in mutually exclusive fiscal years — they never co-exist in the same FY. Any YoY query that joins on `head_canon = <currentCanon>` returns zero rows for the prior year, producing a false 100%-loss signal.

**Root fix (not yet applied):** run an UPDATE or re-ingest older FYs with the corrected aliases.

## The six confirmed alias pairs (all splitFromFy = 2026-27)

| Current canon (2026-27) | Prior canon (2023-24 – 2025-26) |
|---|---|
| Sandeep Dadheech | Sandeep Ji |
| Syed Aqil Rizvi | Rizvi Ji |
| Pawan Sharma | Pawan Kumar |
| Biju C.O | Bijju |
| Lalan Kumar | Lalan |
| Nasir Hussain Khan | Nasir Husain |

All verified: never co-exist in the same FY → safe alias candidates.

## DB data (FY2025-26 LY values, confirmed)

| Head | Customers | ₹ Cr |
|---|---|---|
| Sandeep Ji (25-26) | 90 | 163.32 |
| Rizvi Ji (25-26) | 94 | 56.71 |
| Pawan Kumar (25-26) | 45 | 8.40 |
| Bijju (25-26) | 22 | 17.24 |
| Lalan (25-26) | 37 | 11.48 |
| Nasir Husain (25-26) | 32 | 3.37 |

## Suppression implementation (active)

- `src/lib/headSplits.ts` — canonical config + `getSplit(headCanon, fyCy, fyLy)` 
- `src/lib/mgmt/warnings/engine.ts` — `CROSS_FY_KEY_SPLITS` updated with all 6 pairs
- `src/lib/mgmt/graph/gapNodes.ts` — `KNOWN_KEY_SPLITS` updated with all 6 pairs
- `src/routes/customers.ts` — `/performance` route adds `headYoySplit` to response when head filter hits a split
- `CustomerRanking.tsx` — hides all LY columns + shows blue banner when `headYoySplit` prop is set

## Other heads not affected

- **Anuj Sharma** — only in FY2026-27, no prior FY data → genuinely new head
- **Sulinder Pal** — only in FY2025-26 + FY2026-27 → joined in 2025-26, not a split
- **Shailesh Sharma** — only in FY2023-24 + FY2024-25, very small amounts → likely left

## What to do when applying the UPDATE

1. Run `UPDATE sale_line SET head_canon = '<currentCanon>' WHERE head_canon = '<priorCanon>'`
2. Remove the entry from `CROSS_FY_SPLITS` in `headSplits.ts`
3. Remove from `CROSS_FY_KEY_SPLITS` in `engine.ts` and `KNOWN_KEY_SPLITS` in `gapNodes.ts`
4. Verify YoY totals before + after with the per-FY SQL diff query
