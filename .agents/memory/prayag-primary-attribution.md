---
name: Prayag primary attribution pipeline
description: How primary order booking + dispatch sale are attributed to individual team members via the distributor-TM map
---

## Rule

The FY2026-27 "Sale" KPI was incorrectly pointing to the Order Sheet (booked orders, ~₹96 Cr). The correct sheet IDs are:
- **Order Booking (Primary)** = Order Sheet 26-27: `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A`
- **Sale (Dispatched)** = State Head Sale 2026-27: `1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs`

Both IDs are also encoded in `primaryAttribution.ts`.

## Distributor-TM map

- Drive folder `1-guQptN9S4NrW024jGizKo0V4nFDtHMv` holds ~180 per-member Google Sheets.
- Each has a "Distributor Visit Report" tab with a Name + Type header table.
- `distributorTmMap.ts`: `getDistributorTmMapIfReady()` is non-blocking (background build on first call, null returned); `loadDistributorTmMap()` blocks. 60-min TTL.
- On first request the map is null → per-member primary columns are blank; populated on subsequent requests after the background build completes (~30–60 s for 180 files).

**Why non-blocking:** reading 180 files × 2 API calls each at 429-throttled Sheets quota takes 30–60 s. Blocking the request would time out.

## Per-member attribution flow

1. `primaryAttribution.ts`: `loadPrimaryAttribution(fy, distMap)` reads each data tab of both sheets.
2. For each row: `normParty(Customer)` → look up in `distMap.byPartyKey` → accrue to member's `orderAmount` / `saleAmount`.
3. Rows with no Customer column or no map match bucket under `normHead(STATE HEAD)` in `unassignedByHead` — totals are preserved.
4. 30-min per-FY cache keyed by FY string.

## mgmt.ts integration

- `getDistributorTmMapIfReady()` returns the cached map or null (starts background build).
- If map is ready → `loadPrimaryAttribution(fy, distMap)` is called (blocks, but uses its own 30-min cache).
- Four new member fields: `primaryOrderAmount`, `primarySaleAmount`, `primaryDistributors`, `primaryDirectDealers`.
- Three new meta fields: `orderBookingPrimary` (head-level record), `pendingOrdersTotal` (derived), `primaryAttributionDiagnostics`.

## How to apply

- If SALE_SHEETS["2026-27"] ever needs changing, update BOTH `stateHeadSale.ts` AND `DISPATCH_SALE_SHEET_IDS["2026-27"]` in `primaryAttribution.ts`.
- If Order Sheet ID changes, update `ORDER_BOOKING_SHEET_IDS["2026-27"]` in `primaryAttribution.ts` AND `ORDER_BOOK_FY2627` in `orderBookSale.ts`.
- The distributor map is FY-agnostic — it maps distributors to members regardless of period.
