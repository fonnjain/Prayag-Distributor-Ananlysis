---
name: Master Org Phase 2+3 — people and customer management
description: Routes, impact gate, customer reassignment, and verification protocol for the Phase 2/3 organisation pages.
---

## Routes — Phase 2 (people)

- `GET /api/master/designations` — 14 designations ordered by rank
- `GET /api/master/people` — paginated list; params: q, active, designation_id, page, limit
- `GET /api/master/people/:id` — full detail + directReports + reportingChain + territories + changeLog
- `GET /api/master/people/:id/impact` — subTreeCount + directReports + customersAsStateHead + customersAsTm + totalCustomersAffected
- `PATCH /api/master/people/:id` — edit (name, employee_code, designation_id, reports_to_person_id); reports_to change requires acknowledgedSubTree + acknowledgedCustomers
- `POST /api/master/people/:id/deactivate` — requires acknowledgedSubTree + acknowledgedCustomers; re-verified server-side
- `POST /api/master/people/:id/reactivate` — no impact gate needed
- `GET /api/master/unresolved-links` — 13 rows (was 14; Chhinamastike split merged)
- `POST /api/master/unresolved-links/:id/resolve` — mark mapped or confirmed_gone
- `GET /api/master/verify/inactive-managers` — active people reporting to inactive managers

## Routes — Phase 3 (customers)

- `GET /api/master/customers` — paginated list; params: q, type, page, limit; includes current (open) assignment
- `GET /api/master/customers/by-head` — FY2025-26 totals from sale_line grouped by head_canon **(MUST be declared before /:id)**
- `GET /api/master/customers/:id` — detail + current + history + links
- `PATCH /api/master/customers/:id/assign` — reassign with effective dating (closes old row, opens new)

## Impact gate protocol (people)

1. Frontend calls GET /impact → shows modal with exact numbers
2. User clicks confirm → POST /deactivate (or PATCH with reports_to) with `{ acknowledgedSubTree, acknowledgedCustomers }`
3. Server re-runs impact queries; if numbers changed → 409 (force re-preview)
4. Missing acknowledgment fields → 422

## Effective dating protocol (customers)

- Old open assignment: `effective_to = CURRENT_DATE`
- New assignment: `effective_from = CURRENT_DATE`
- FY2025-26 queries use `sale_line.head_canon` — NEVER touched by customer_assignment edits
- `/by-head` result is invariant to any reassignment (verified: diff empty)

## Seed unresolved links (migration 031 + 032)

13 rows in `seed_unresolved_link`. Two auto-resolved:
- DIST#39381 "Prayag Sale Corporation NE" — xlsx truncated name at 25 chars; 109 links
- DIST#9236 "Chhinamastike Sanitation Pvt. Ltd." — xlsx split name at comma; 174 link rows (different retailer sets in each half)
- 195 customer_link rows actually recovered (88 xlsx entries reference retailers absent from customer table — structural)

## Verification anchors (Aug 2026)

Phase 2 deactivation test — Anant Singh (person_id=9): subTree=10, SH=782, TM=5, total=787
Phase 3 by-head test — before/after DIST#31809 reassignment: diff=empty (13 head rows unchanged)

Effective dating in DB after reassignment:
- Old row: effective_from=2026-08-15, effective_to=2026-08-15 (closed same day)
- New row: effective_from=2026-08-15, effective_to=NULL (open)

## change_log fields on deactivation

- `is_active`: old=true → new=false
- `deactivation_impact_acknowledged`: new=JSON{subTreeCount, totalCustomersAffected}
- On reactivate: `is_active`: old=false → new=true

## TypeScript gotcha in masterOrg.ts

All early-exit `return res.status(N).json(...)` calls inside async handlers must use `return void res.status(N).json(...)`.
Plain `return res.json(x)` mixed with paths that end without return → TS7030.
