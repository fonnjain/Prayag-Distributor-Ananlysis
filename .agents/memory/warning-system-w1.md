---
name: Warning System W1 architecture
description: Backend route, caching behavior, and frontend for the W1 warning engine (State Heads tab).
---

## Route
`GET /api/warnings?fy=&stateHead=` in `artifacts/api-server/src/routes/warnings.ts`.
Mounted via `router.use(warningsRouter)` in `routes/index.ts`.
Path is `/warnings` (NOT `/api/warnings`) because `app.use("/api", routes_default)` already adds the prefix.

## Data flow
1. `loadStateDashboard(fy)` → member list + month data (for A3 trend; SecMember.months has no monthLabel — synthesise from index 0=Apr..11=Mar).
2. `loadDeepDiveData(fy, stateHead, normKey, { skipExtras: true })` per member in parallel — skips winBack+skuSpread (not needed by warnings engine; avoids a slow DB query per member).
3. `buildMemberPayload` → AiPayload for each member with valid kpis.
4. `computeMemberWarnings` → warning cards; `splitWarnings` → root/suppressed/jFlags.

## Caching behaviour
- Cold start: ~9 seconds (12 members × Google Sheets API calls for working sheets).
- Warm cache (in-memory): ~21ms.
- `skipExtras=true` avoids winBack (DB query) which was adding ~0s to each member but causing slow concurrent behaviour.
- Member working sheets are cached by `loadMemberSheet` after first load.
- FY2026-27 (open FY): master sheet always loaded from Sheets (no DB snapshot); individual member sheets cached in memory.

## loadDeepDiveData signature change
Added `opts: { skipExtras?: boolean } = {}` as 4th parameter. When `skipExtras=true`, skips `computeSkuSpread` and `computeWinBack` at lines 844-850 of deepDiveData.ts.

## Frontend
`artifacts/prayag/src/components/dashboard/WarningSystem.tsx`.
API pattern: `const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api"` → fetch `${API}/warnings?...`.
Uses Tabs (State Heads | Distributors), Select for state head, and MemberPanel cards.

## Route registered in
- `routes/index.ts`: `import warningsRouter from "./warnings"` + `router.use(warningsRouter)`
- `pages/Dashboard.tsx`: `{ id: "warnings", label: "Warning System", component: WarningSystem }`
- `components/AppShell.tsx`: `{ id: "warnings", label: "Warning System", path: "/warnings", icon: AlertTriangle }`

## W2/W3 not built
- W2 (Distributors tab): placeholder in UI only.
- W3 (B/F families — real value + variety): requires secondary register not available for FY2026-27.

## Verified acceptance criteria (FY2026-27, Anant Singh, warm cache)
- Jagdev: 6 RED + 3 YELLOW root warnings (D1 RED 55.2%, D2 RED, A1 RED, A2 RED, C1 RED, E1 RED + trend/pace yellows)
- Prasun: 9 root (D1 RED 57.5%, D2 RED, D3 YELLOW, A1 RED, A2 RED, C1 ORANGE, E1 RED, E4 YLW, I1 YLW)
- Rahul Singh: 5 root + J3 (partial tenure) + J5 + 4 suppressed
- Ravinder Puri: 7 root (D1 RED 56.9%, D2 YELLOW, D3 ORANGE...)
- Himanshu Sharma: 0 root, no mapped sheet (J1 flag)

**Why:**
The document's acceptance criteria used example/estimated values. Live data for FY2026-27 as of Jul 2026 differs (e.g. Prasun D1 is 57.5% RED not 41% ORANGE). The engine logic is correct — the numbers simply changed.


## Aug 2026 corrections (lag months, per-member pace, thresholds)
- **Lag months** (closed month, booking present, sales not yet entered → `notYetRecorded`): excluded from trend detection, A4 (recomputed over recorded months when a lag month exists), and J2 (skipped when every booked month is lag). I1 skips non-finite cost ratios (zero sales = lag, not performance).
- **Pace pro-rating** (A2, C1) uses per-member elapsed months from the sheet BD column (`kpis.elapsedMonths / 12`), falling back to the global FY fraction. J3 partial-tenure cutoff = 0.85 × team median working days (norm = median, never hardcoded 65/55).
- **A1 zero-target guard**: to-date target 0/absent with real OB → NOT_AVAILABLE "No target recorded" card, never 0% or RED.
- **LEFT members** are filtered out in the route (`!m.isLeft`); history untouched.
- **Thresholds**: I1 cost ratio Yellow >6 / Orange >10 / Red >15 (aligned with the Sales Deep Dive tile colours); I2 three bands ₹1,000/₹2,000/₹3,500.
- **Head-name resolution**: register spelling ("AQIL RIZVI") is resolved to the Data-tab spelling ("Syed Aqil Rizvi") via normalised token-subset match before deep-dive loads — without it a whole team reads as J1.
- **Known wallpaper**: G1 effective-retailer bands (<5/<10/<20) — all 93 measured members fall under 10; bands need a user decision to recalibrate.
- Families B (Laspeyres deflator) and H were never built; F never built. Engine covers A,C,D,E,G,I,J only.
- `MemberWarnings.lagMonths` exposes the per-member lag-month count.


## Partial-tenure norm basis (Aug 2026)
Rule: teams with <5 members in the dashboard roster use the company fallback norm (65 wd), not a team median; basis exposed as teamSummary.normBasis.
**Why:** a 2-person team of new joiners (8 & 27 working days) makes the "median" meaningless and suppresses every flag. Basis must key on team SIZE, not on how many sheets loaded this pass — cold-load misses otherwise flip a 5-person team to fallback and the snapshot freezes it.
**How to apply:** warnings snapshot key is versioned (warnings|v3|). Any bump must update the invalidation prefix in the register resync route in lockstep, or refreshed data never invalidates warning snapshots.

## Warnings roster limitation
Warnings population comes from the secondary state dashboard roster, not the Data tab: heads with no secondary register (e.g. project-state or brand-new heads) and zero-target members missing from the secondary roster get no warnings coverage. 404 "no members" for a real head usually means this, not a naming bug.
