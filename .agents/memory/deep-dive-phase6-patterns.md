---
name: Deep Dive Phase 6 patterns
description: DB freeze for closed FYs, A-vs-B reconciliation, win-back list, run-rate panel — verified July 2026.
---

## DB freeze (closed-FY snapshot)

- `deep_dive_snapshot` table (singular, not plural) holds one row per (FY, save) of the Data-tab parse result.
- On first Sheets read, `saveDeepDiveSnapshot` fires-and-forgets an insert. No `ON CONFLICT` — multiple rows per FY are intentional; `loadDeepDiveFromDb` picks the latest by `saved_at`.
- On cold restart, `loadAllMembers` checks `isClosedFy(fy)` first. If true and a snapshot exists, serves from DB and sets `_fromDbSnap.set(fy, true)`. FY2025-26 cold-start response time: 24 ms.
- `isClosedFy`: `fyStartYear(fy) < fyStartYear(currentFy())`. Uses UTC month ≥ 3 → April boundary.

## A-vs-B reconciliation

- Pure frontend computation. No extra API field needed.
- A = `kpis.orderBooking + kpis.directDealersOrder` (from Data tab).
- B = `retailerDetail.spread.totalOrderBooking` (re-derived from working sheet rows).
- Prasun Chatterjee FY2026-27 verified: A = ₹26,21,108.55 vs B = ₹26,21,109.07 — variance 0.0000%.
- Panel shows green "Reconciles within 1%" badge when |variance pct| ≤ 1.

## Win-back list

- `computeWinBack(memberKey, currentCustomers)` queries `secondary_register_line` for past-FY customers (FY2024-25, FY2025-26) not in `currentCustomers` list.
- `currentCustomers` comes from `retailerDetail.rows[].name` when `status='ok'`; empty list if sheet is still loading.
- Prasun: 11 dormant customers found. First entry: 'Tyagi hardware & electrical', lastActiveFy='2025-26'.
- `winBack` field on `DeepDiveDataResult`: `WinBackItem[] | null` (null when no member selected).

## Route parameter: `member=`, not `memberKey=`

- The deep-dive route reads `req.query.member` (not `memberKey`). It then calls `normSecKey(memberRaw)` internally.
- Frontend correctly sends `params.set("member", memberKey)`.
- When debugging with curl: `?fy=2026-27&member=prasunchatterjee`.

## Run-rate panel

- Only shown for `fy === "2026-27"` when `roiCost.elapsedCompleteMonths > 0`.
- `ytdOb = kpis.orderBooking + kpis.directDealersOrder`. Projected = ytdOb / elapsed × 12.
- elapsedCompleteMonths = 3 for Jul-23 (Apr, May, Jun closed).

**Why:** Recording because the "member=" vs "memberKey=" naming confusion wasted a verification loop, and the DB-freeze pattern is non-obvious (singleton key pattern is hidden in the table name singular/plural).
