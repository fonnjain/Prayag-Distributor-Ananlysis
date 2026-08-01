---
name: SKU K4 discounts, seasonality, movement
description: K4 layer — two discount measures never conflated, customer-bridge project exclusion, seasonality basis, in-process backfill route
---

# SKU Deep Dive K4

## Two discount measures — never conflated
- Primary = discount off MRP: `(mrp×qty − amount)/(mrp×qty)` from sale_line_current JOIN item_master (sale_line has NO mrp column; item_master.mrp is the rate list). Coverage reported per response (~56–60% of rows have MRP).
- Secondary = register Discount column in secondary_sku_line.discount_pct — it is a PERCENTAGE: `gross × (1 − disc%) = Sub Total` holds for 100.00% of FY2025-26 lines (379,439) within ₹1. Aggregation must use discount_pct weighted by gross, NOT derived 1−net/gross. Population reconciliation gate: withhold the measure if <99% of lines reconcile.
- Blocked, never approximated: margin per code (cost_master empty; MRP discount ≠ margin) and live-year retailer discount (no FY2026-27 secondary SKU register). Reasons carried in `blocked` on /api/sku/discounts.

## Project exclusion — FY-conditional customer bridge
FY2024-25/25-26 sale_line rows have NULL head_canon (21-col registers have no head column). Territory filter must be ROW-conditional: head attributed → trust head; head NULL → exclude customers ever project-attributed in FY2023-24/2026-27 (the bridge). Applying the bridge to attributed rows is WRONG (drops genuine territory sales of mixed customers). See territoryFilterSql/projectFilterSql in skuK4.ts.

## Seasonality basis
All channels including project (territory-only HDPE ₹8.3 Cr is meaningless; 2 of 3 closed FYs can't be split). Pooled 3-yr HDPE Q1 = 37.1% (spec reference ~31.6% — same direction), June largest month, 3/3 years consistent. Most other segments peak Q4 (Jan–Mar).

## In-process backfill route
Shell-launched CLIs (nohup/setsid) get reaped when the ShellExec session ends in this environment — long backfills must run inside the API server process. POST /api/sku/secondary-backfill?confirm=true&reason=… (allowlisted closed FYs only, 423 without confirm, clears K4 cache on finish). Full 3-FY SKU backfill takes ~4 min in-process (976K rows).

## skuLoader API drift
loadSecSkuFromSheets(fy, sheetId, dryRun) — positional args; readTabRowsChunked is callback-style, not async-iterable. SKU_SHEET_IDS is the sheet map (2021-22…2025-26; 2026-27 deliberately absent).

## Push-list enrichment
Segments carry peakQuarter/Label/Share; codes carry discountAboveNorm (≥5pts above own closed-years territory norm; current side uses the push list's period). Enrichment is try-catch non-fatal.
