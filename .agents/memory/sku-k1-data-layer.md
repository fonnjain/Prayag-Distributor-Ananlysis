---
name: SKU Deep Dive K1 data layer
description: Architecture decisions and quirks for the K-series SKU analytics data layer (K1 phase)
---

## Table
`secondary_sku_line` — one row per Cat. No. line from secondary registers at item-code granularity. Separate from `secondary_register_line` (brand-level). Schema: `lib/db/src/schema/secondarySkuRegister.ts`. Pushed to DB via `cd lib/db && pnpm run push`.

## Two separate group maps — NEVER mix them
- `config/group_map.json` — maps secondary-register Segment column values → canonical segment (for `secondary_sku_line.segment_canon` during ingestion, and for `sale_line.group_canon`).
- `config/item_group_map.json` — maps `item_master.item_group` ERP taxonomy → canonical segment (for catalogue denominator only).
- Functions: `canonGroupFromMap()` = secondary register; `canonItemGroup()` = item_master. Both exported from `lib/sku/catalogue.ts`.

## Catalogue denominator
Derived from `item_master WHERE mrp IS NOT NULL AND mrp > 0` (active items) via `item_group_map.json`. Counts may exceed spec reference figures (CP=903 etc.) because item_master has changed — the mechanism is correct, the spec figures are reference targets. `catalogueIncomplete=true` on a segment fact means `codesBought > codesAvailable` (item_master undercounts that segment).

## Drizzle SQL array parameter trap
Passing a JS array to `ANY(${array}::text[])` in a Drizzle tagged template generates `ANY(($1,$2,$3)::text[])` which Postgres rejects as `cannot cast type record to text[]`. Fix: `ANY(ARRAY[${sql.join(arr.map(v => sql\`${v}\`), sql\`, \`)}])`.

## Primary row counts (acceptance anchors, verified 30 July 2026)
- FY2024-25: 141,201 rows in `sale_line` (`version_status='current'`)
- FY2025-26: 144,365 rows
- FY2026-27: 40,016 rows (open FY, growing)

## Channel detection in sale_line
- `type_raw IS NULL OR type_raw NOT ILIKE '%direct%'` → distributor
- `type_raw ILIKE '%direct%'` → direct dealer
- NEVER use `type_raw` as a segment source; segment always from `COALESCE(group_canon, group_raw, 'Unmapped')`.

## Breadth denominator
`codesEverSold` = `COUNT(DISTINCT code)` in `sale_line WHERE version_status='current'` across ALL loaded FYs for that segment. Always ≥ `codesBought` for any period sub-query, so `breadthPct` ∈ [0, 100]. `item_master` is carried as `codesInCatalogue` for reference only. `catalogueIncomplete` flag was removed (structurally impossible with this denominator). Cache TTL 1h. `getEverSoldPerSegment()` in catalogue.ts.

## Never-sold catalogue items
`getNeverSoldCatalogueItems()` in catalogue.ts: LEFT JOIN item_master vs DISTINCT sale_line codes. 1,238 codes with mrp>0 have zero transactions across all loaded FYs. Returned as `neverSold.bySegment` from `/api/sku/catalogue`. Largest: CP (562), Hardware (213), Sanitaryware (127), SWR (121).

## Overview product mix
The Overview renders ALL 17 `group_canon` values from `/api/analytics` — there is no 7-group rollup layer. analytics.ts uses `COALESCE(group_canon, 'Unmapped')` (no group_raw fallback); SKU facts uses `COALESCE(group_canon, group_raw, 'Unmapped')`. NET is identical across all FYs (zero group_raw-only rows confirmed). 17 segments = 17 Overview groups = 1:1 mapping.

## Routes
- `GET /api/sku/facts?fy&level&scope&scopeId&monthFrom&monthTo&segment`
- `GET /api/sku/capability?fy`
- `GET /api/sku/catalogue`

## Secondary SKU backfill CLI
`pnpm --filter @workspace/api-server run secondary-sku-backfill -- --fy 2025-26 --dry-run`
`pnpm --filter @workspace/api-server run secondary-sku-backfill -- --fy 2025-26 --commit`
Sheet IDs in `lib/secondary/skuLoader.ts:SKU_SHEET_IDS`. FY2026-27 deliberately absent — add when register arrives.

## NET definition (must be consistent)
- Primary (distributor/direct_dealer): `sale_line.amount` = taxable value / net invoice amount.
- Secondary (retailer): `secondary_sku_line.net_amount` = Sub Total column from register.
- `Order Total` is never used for analytics.
