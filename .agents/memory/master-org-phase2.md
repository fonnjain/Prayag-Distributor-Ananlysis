---
name: Master Org Phase 2+3 — people and customer management
description: Durable operational decisions for the Phase 2/3 organisation routes.
---

## Impact gate — double-count invariant

GET /impact returns `totalCustomersAffected = COUNT(DISTINCT customer_id)`, NOT the sum of separate role counts. A customer where the person is both state_head and TM must count once. The PATCH/deactivate re-verification query must use the identical `COUNT(DISTINCT customer_id)` predicate; mismatching counting rules cause spurious 409 rejections for dual-role assignments.

**Why:** The impact system lets operators acknowledge exact counts before irreversible hierarchy changes. Even a one-off mismatch (e.g. dual-role customer) produces a 409 that can never be resolved without a code fix.

## Effective dating protocol (customers)

Reassignment closes the old open assignment (`effective_to = CURRENT_DATE`) and opens a new one. `sale_line.head_canon` is baked at register ingest and is never touched. GET /customers/by-head result must be invariant to any reassignment — use it as a before/after diff canary.

**How to apply:** GET /customers/by-head must be declared before /:id in Express route registration order to prevent "by-head" from matching the :id param.

## Route correction: unresolved-links and inactive-managers

GET /master/unresolved-links queries `seed_unresolved_link` (not `sale_line`).  
GET /master/verify/inactive-managers joins `person` to `person` on `reports_to_person_id` (not `sale_line`).

**Why:** Both routes were accidentally written to query sale_line in an earlier merge, returning sales aggregates instead of org-graph data.

## TypeScript gotcha

All early-exit paths inside async handlers must use `return void res.status(N).json(...)`. Plain `return res.json(x)` mixed with void paths → TS7030.
