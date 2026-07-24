---
name: AI Analytics payload architecture
description: GET /api/ai/payload Phase A1 — verified metrics payload; no Anthropic call in this endpoint; architecture, classification rules, and known gaps.
---

# AI Analytics Payload — Phase A1

## Architecture rule
`app = numbers. Claude = judgement.`
The payload endpoint computes all figures from already-loaded Deep Dive data and
returns them as a JSON blob. Later phases hand this blob to Claude for narrative.
Claude NEVER receives raw retailer rows, never does arithmetic.

## Endpoint
`GET /api/ai/payload?fy=&stateHead=&member=&period=`

Two paths:
- **Member selected**: calls `buildMemberPayload` → full payload including retailer detail sections (customer states, top customers, concentration, visits, capacity, cost).
- **No member**: calls `buildStateHeadPayload` → aggregate of Data tab KPIs across all team members; no member sheets loaded; retailer-level sections are null.

## Customer state classification (per-retailer, from member sheet rows)
```
retained    : isActive AND businessPlan > 0
reactivated : isActive AND NOT (businessPlan > 0)
atRisk      : dormant AND totalVisit > 0 AND businessPlan > 0
never       : all other dormant
```
**Why atRisk requires both visit AND plan:** A plan signals management expects OB; a visit
signals rep effort. The conjunction = tracked account that rep tried but couldn't convert.
Exploratory visits to plan-less retailers go into "never" (no prior relationship).

**Known gap:** Per-retailer prior-year OB is not in RetailerRow; `obLastYear` in
customer state groups is always null. Adding it requires extending column detection in
memberSheet.ts to capture the FY-specific prior-year OB column (e.g., "Order Booking 2025-26").

## workingDaysActual
Added `workingDaysActual: number | null` to `MemberKpis` (deepDiveData.ts), read from
`cols.workingDaysAg` (AG column = "Working days in month" in the Data tab). Prasun Q1 = 72
(not 78 calendar days — 6 days were leaves/holidays). The payload prefers this value over
the calendar count.

## Known state head aggregate gaps (Phase A1)
- `visits.done` = sum of `kpis.visitedRetailers` (monthly point-in-time from Data tab), NOT
  cumulative YTD. The YTD cumulative would require loading all 13 member sheets.
- `secondaryOB` may be ~2.7M short for Anant Singh team if some members have null
  `orderBooking` (column detection miss on their Data tab row). directDealerOB and
  salesReceived are exact.

## Verified anchors (Prasun Chatterjee, FY2026-27, Jul 24 2026)
- dataCutoff=2026-06-30, elapsedMonths=3, workingDays=72 ✓
- secondaryOB=18,34,504, directDealerOB=7,86,605, total=26,21,109, sales=26,13,934 ✓
- achievement: 48.5%/36.0%/262.2%/48.4% ✓
- businessPlan=18,000,000, annualProgress=14.6% ✓
- 73 retailers, 34 active, 39 dormant ✓
- retained=32, reactivated=2 ✓
- visits=395/1704, visitedNoOrder=28 ✓
- cost: ctcToDate=1,39,170, taBill=16,484, total=1,55,654 ✓

## atRisk live-data note
Acceptance baseline recorded atRisk=20/never=19. Live sheet shows atRisk=27/never=12
(Jul 24 2026). Prasun's business plan assignments change as he updates his Summary Report;
the classification rule is correct — it's a data drift, not a code bug.
