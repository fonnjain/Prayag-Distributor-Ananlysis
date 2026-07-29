---
name: Primary period-aware service
description: Architecture of the shared primary booking+sale loader and the root cause of the ₹0.42 Cr booking discrepancy.
---

## Rule
`lib/mgmt/primaryPeriod.ts` is the single source of truth for all primary booking and dispatch-sale data. Any page that reads primary figures must call `loadPrimaryPeriodData(fy, monthLabels)` — never call `loadOrderBookSaleByHead` or `loadDispatchSaleFromDb` directly from a route.

**Why:** Before this consolidation, State Head and Primary Performance used two separate reader paths that disagreed by ₹0.42 Cr (blank-STATE-HEAD rows counted differently). Both pages now agree exactly.

## How to apply
- `fiscalMonthsToLabels(fy, monthFrom, monthTo)` is exported from `primaryPeriod.ts`; use that everywhere (it was previously duplicated in `mgmt.ts`).
- Booking: `loadOrderBookSaleByHead()` caches `byHeadByMonth` (tab title → head → amount); the service period-filters via 3-char month-prefix match.
- Sale: `loadDispatchSaleFromDb()` (DB, always period-exact). Falls back to `loadStateHeadSale()` (Sheets, FY total, `periodFiltered=false`).
- Historical FYs (booking): `loadPrimarySheetData()` FY total only, `periodFiltered=false`.
- `loadPrimarySheetData()` is still called in `/api/mgmt/primary` for `byDistributor` and `tabInventory` (always FY total; no per-row date on distributor column).

## The ₹0.42 Cr discrepancy (resolved)
`orderBookSale.ts` previously skipped rows where the STATE HEAD cell was blank (`if (!head || amt <= 0) continue`). `primarySheets.ts` counted those rows in `nonTerritoryTotal`. Fix: blank-head rows now tracked as "Unattributed" bucket in `orderBookSale.ts`, counting in the company total.

## Period filter flag
`bookingPeriodFiltered` / `salePeriodFiltered` booleans flow through to the frontend. When `false` and a sub-year period is selected, the UI shows "FY total — period filter not applied" on tiles and the By State Head table.

## Verified anchors (Q1 / YTD Apr–Jun-26)
Order Booking ₹77.76 Cr, Sale/Dispatch ₹72.86 Cr, Pending ₹4.90 Cr — matches State Head exactly.
