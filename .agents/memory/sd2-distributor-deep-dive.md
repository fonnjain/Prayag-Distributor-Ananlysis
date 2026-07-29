---
name: SD2 Distributor Deep Dive
description: Backend + frontend additions for SD2 — per-state, per-member, correlation, naming candidates, DD OB supplement.
---

# SD2 Distributor Deep Dive architecture

## What was built
Five new SD2 outputs computed in `loadDistributorDeepDive` after Step 9 (mapping quality):

- **`byState: StateDistributorRow[]`** — per-state retailer/none/named counts, activity rates, top distributor OB share. Computed by iterating `allRows` keyed on `row.memberState`.
- **`perMember: MemberDistributorRow[]`** — per-member classification counts from `perMemberAcc` Map (populated during Step 4 classification loop). Includes `removedCount` from `memberRemovedCounts` and `achievementTotal` from `MemberRef`.
- **`unassignedCorrelation: number | null`** — Pearson r between `noneSharePct` and `achievementTotal` across active non-LEFT members with > 0 retailers. Implemented via `pearsonR()` helper.
- **`namingCandidates: NamingCandidate[]`** — near-duplicate distributor name pairs, Jaccard trigram similarity > 0.6, top 30, via `computeNamingCandidates()`. Never auto-merged.
- **`directDealer.dashboardOb`** — from `MemberRef.directDealerOb` (Data-tab directDealersOrder), authoritative DD OB. Working-sheet blank-row OB is NOT the right measure for a direct-dealer channel.

## Key design decisions

- **`MemberRef` now carries `state`, `achievementTotal`, `isLeft`, `directDealerOb`** — these are passed from `MemberKpis` during the map at line ~1119 of deepDiveData.ts. All 4 heads use the same path.
- **`RichRow = RetailerRow & { memberName, memberState }`** — `memberState` comes from `memberStateMap` built before sheet loading.
- **`perMemberAcc`** is populated inside the classification switch (Step 4) for all 5 types (named/none/blank/shared/malformed). No separate re-classification pass.
- **TIMEOUT_MS = 60_000** (was 20_000). On cold load 74 members: 20/74 load at 20s, 63/74 at 60s, 66/74 at 90s. Remaining 8 (Karnataka + stragglers) load on warm cache calls.

## Verified numbers (Sandeep Dadheech, FY2026-27, warm cache)
- dashboardOb = Rs 1,40,628.33 from Sasikant Prasad ✓
- noneCount: 2,734 / totalRetailers: ~4,930 (66/74 members; full 6,248 on all-loaded call)
- unassignedCorrelation: −0.333 (n=58 active) — weaker than Anant Singh −0.90
- namingCandidates: 9–14 depending on members loaded
- byState: 7–8 states (Karnataka appears only when its 3 members' sheets warm)

**Why:**  Must always use `directDealer.dashboardOb` as the authoritative DD OB in the UI — working-sheet blank-row OB is 0 for DD channels. The Data-tab figure is the only correct measure.

## Files
- `artifacts/api-server/src/lib/mgmt/distributorDeepDive.ts` — SD2 helpers + all new computation steps
- `artifacts/api-server/src/lib/mgmt/deepDiveData.ts` — MemberRef extension
- `artifacts/prayag/src/components/dashboard/DistributorDeepDive.tsx` — SD2 UI sections (byState table, naming candidates callout, PerMemberAnalysisSection)
