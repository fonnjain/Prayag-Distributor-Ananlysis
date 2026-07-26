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
