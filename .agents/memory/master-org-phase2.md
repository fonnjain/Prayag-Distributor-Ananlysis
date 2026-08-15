---
name: Master Org Phase 2 — people management
description: Routes, impact gate, and verification protocol for the Phase 2 organisation people page.
---

## Routes (artifacts/api-server/src/routes/masterOrg.ts)

- `GET /api/master/designations` — 14 designations ordered by rank
- `GET /api/master/people` — paginated list; params: q, active, designation_id, page, limit
- `GET /api/master/people/:id` — full detail + directReports + reportingChain + territories + changeLog
- `GET /api/master/people/:id/impact` — subTreeCount + directReports + customersAsStateHead + customersAsTm + totalCustomersAffected
- `PATCH /api/master/people/:id` — edit (name, employee_code, designation_id, reports_to_person_id); reports_to change requires acknowledgedSubTree + acknowledgedCustomers
- `POST /api/master/people/:id/deactivate` — requires acknowledgedSubTree + acknowledgedCustomers; re-verified server-side
- `POST /api/master/people/:id/reactivate` — no impact gate needed
- `GET /api/master/unresolved-links` — 14 seed distributor names, 372 lost links
- `GET /api/master/verify/inactive-managers` — active people reporting to inactive managers

## Impact gate protocol

1. Frontend calls GET /impact → shows modal with exact numbers
2. User clicks confirm → POST /deactivate (or PATCH with reports_to) with `{ acknowledgedSubTree, acknowledgedCustomers }`
3. Server re-runs impact queries; if numbers changed → 409 (force re-preview)
4. Missing acknowledgment fields → 422

**Why:** "nothing may save until confirmed" requirement. The acknowledged counts in the body ensure the user saw the real numbers before the mutation happened.

## Verification 6 lifecycle

- Returned 0 at Phase 1 (all 179 active, no inactive managers exist)
- After deactivating Anant Singh (person_id=9): count=10, all 10 direct reports orphaned
- After reactivating: back to 0
- The check is at GET /api/master/verify/inactive-managers — call it after any deactivation

## seed_unresolved_link (migration 031)

14 distributor names from the seed that matched no customer row. 372 links lost.
Phase 3 UI will surface these for operator resolution (map to customer_id or confirm_gone).

## Verified impact numbers (Aug 2026)

Anant Singh (person_id=9): subTree=10, SH=782, TM=5, total=787

## change_log fields written on deactivation

- `is_active`: old=true → new=false
- `deactivation_impact_acknowledged`: new=JSON{subTreeCount, totalCustomersAffected}
- On reactivate: `is_active`: old=false → new=true
