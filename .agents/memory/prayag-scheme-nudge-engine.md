---
name: Prayag Scheme Nudge Engine
description: Architecture and gotchas for the scheme nudge engine (live ROI calculator for distributor schemes).
---

## Architecture

- Config: `artifacts/api-server/config/scheme_master.json` — SLABS + BASKET_MAP + seasonality (seeded from Prayag_Scheme_Master.xlsx).
- Lib: `artifacts/api-server/src/lib/schemes/nudge.ts` — core computation; `dues.ts` — PARTY O/S Sheets fetcher with 1h cache.
- Routes: `artifacts/api-server/src/routes/schemes.ts` — GET /api/schemes/nudge, /cockpit, /annual, /master.
- Frontend: `artifacts/prayag/src/components/customers/SchemeNudgeEngine.tsx` — 6-tab UI in the Schemes section of CustomersPage.

## ROI formula (verified against Q1 demo)

```
they_earn = (next_threshold × next_rate) - (billed_so_far × current_rate)
gap       = next_threshold - billed_so_far
roi       = they_earn / gap
```
Suppress nudge if roi < 5% (configurable). Q1 control: PREM KUMAR & SONS(MALOUT) PTMT billed 1,014,894 → they_earn 41,680.83, roi 8.59%.

## Critical: use group_raw not group_canon

`sale_line.group_raw` (e.g. "PTMT", "C P", "CPVC") matches BASKET_MAP keys.
`sale_line.group_canon` (e.g. "PTMT / Faucets", "CP (Chrome-Plated)") is the normalized display name — does NOT match.
Always filter with `group_raw IN (basketGroups)` and map `BASKET_MAP[row.group_raw]`.

## Dues check (PARTY O/S & PAYMENT 26-27)

Sheet ID: `1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok`
Column detection looks for PARTY_COL_KEYWORDS + OS_COL_KEYWORDS in header row.
If detection fails, dues check is gracefully disabled (duesDataAvailable: false in API response).
To calibrate: read the actual sheet and update PARTY_COL_KEYWORDS / OS_COL_KEYWORDS in dues.ts.

## Channel exclusion

`is_territory = false` rows are excluded from scheme base (non-territory customers).
Also pattern-excludes: GOVT, GOVERNMENT, GEM, JJM, PROJECT in customer name.

**Why:** "Retail sale only. Supplies to Projects and Govt. Deptt. will not be considered." — from scheme conditions.
