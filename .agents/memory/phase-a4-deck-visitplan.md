---
name: Phase A4 visit plan + deck architecture
description: A4-A 27-slide deck and A4-B visit plan fixes — key invariants and architecture decisions
---

## A4-B visitPlan.ts invariants

**Pool decrement:** `developPool.splice(0, Math.min(pool.length, slots))` — splice removes drawn retailers from the shared pool array so each month draws the next tranche. The old index-loop left the pool array unmodified.

**Unassigned exclusion:** Retailers with `!r.distributor` are excluded from develop/reduce pools only. Active retailers (maintain pool) are kept regardless — their active OB proves a supply path even if the column is null. `unassignedExcluded` count is returned on `VisitPlan` and shown to Claude in `planContext`.

**poolExhausted:** True when `devSlots > 0 && developPool.length === 0` (checked BEFORE the splice). Once the pool is exhausted, all future months carry `poolExhausted: true` — the frontend shows a badge and Claude's narrative says "no new development targets remain."

**workingDaysActual:** Optional param on `computeVisitPlan` and `computeCapacity`. When provided, overrides the calendar-based `demonstratedVisitsPerDay`. Source is `MemberKpis.workingDaysActual` (dashboard AG column). Passed via `planContext` to Claude in the travel-plan route.

## A4-A deck architecture

**Format detection (frontend):** `if (result.teamSlides && result.teamSlides.length > 0)` → render 3-section A4A layout; else → render flat `result.slides` grid.

**Route split:** `/ai/presentation` — member branch returns early with `slides: [...], teamSlides: null, memberSlides: null, closingSlides: null`. StateHead branch calls PRESENTATION_PROMPT_A4A, returns `slides: [], teamSlides: [...], memberSlides: [...], closingSlides: [...]`.

**memberSummary:** Built from `MemberKpis[]` only — no extra Sheets reads. Fields: name, hq, hasMappedSheet (=!!getMemberFileId(normKey)), secondaryOB, directDealerOB, totalOB, sale, totalTargetToDate, achievementPct, retailers, visitsCompleted, workingDays. Sorted by totalOB descending.

**achievementBadge:** teal ≥ 60%, amber < 60% or null. Unmapped members (hasMappedSheet=false) must have `unmapped: true` and first bullet = "Retailer, visit, and distributor detail is ABSENT — not zero."

**Why:** The A4-A format keeps KPI-only data for the member summary (no retailerDetail needed per member), making the stateHead deck generation a single Claude call with no extra Sheets reads. Concentration rule (rule 24) is the only permitted derived figure — sum-fraction of memberSummary totalOB vs payload.performance.totalOB.
