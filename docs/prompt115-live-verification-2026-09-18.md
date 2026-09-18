# Prompt 115 live verification — 2026-09-18

## Run status

The development API was authenticated using the existing bootstrap environment.
Credential values, cookies, user identity, and session identifiers are
intentionally omitted.

- Authentication: `GET /api/auth/me` returned HTTP `200` for an administrator.
- Focused automated verification: 17 Prompt 115 tests passed.
- API package typecheck: passed.
- Critical live safe-failure questions: all three returned HTTP `200` after the
  fixes described below.
- Full 14-question live transcript: incomplete. The first two broad questions
  reached the numeric guard and returned HTTP `422`; the workspace restarted
  during the long sequential run and erased its temporary transcript before the
  remaining questions completed.

No unsupported numeric answer reached the caller.

## Broad-question acceptance inventory

| # | Question | Final observed status |
|---:|---|---|
| 1 | Which state heads are ahead of plan and which are behind, and by how much? | HTTP `422`. The model calculated plan gaps that were not typed graph measures; the numeric guard rejected the draft and its one bounded rewrite. |
| 2 | Is the business growing? Show the monthly shape, not just the YTD figure. | HTTP `422`. The model introduced unsupported derived growth displays; the numeric guard rejected the draft and its one bounded rewrite. |
| 3 | Which members' order booking is not converting into dispatch? | Not completed before workspace restart. |
| 4 | What is our projected year-end, seasonally adjusted? | Not completed before workspace restart. |
| 5 | Which categories are growing and which are shrinking? | Not completed before workspace restart. |
| 6 | Which products are we selling that we cannot price? | Not completed before workspace restart. |
| 7 | Where is our margin concentrated, and where is it thin? | Not completed before workspace restart. |
| 8 | Which SKUs are sold by only one or two retailers? | Not completed before workspace restart. |
| 9 | Which retailers stopped buying this year? | Not completed before workspace restart. |
| 10 | Which distributors have pending orders with no assigned member? | Not completed before workspace restart. |
| 11 | Which customers buy narrowly compared with their peers? | Not completed before workspace restart. |
| 12 | What figures are currently unreliable, and why? | Not completed before workspace restart. |
| 13 | Where is our revenue concentrated? | Not completed before workspace restart. |
| 14 | What data are we missing, and what is it worth? | Not completed before workspace restart. |

The API intentionally does not return a rejected draft, so there is no verbatim
answer for questions 1–2. It returned only the structured numeric-guard error.

## Critical safe-failure transcript

### PTMT margin for April 2026

**HTTP status:** `200`

> The PTMT margin figure for FY2026-27 — including April 2026 — is currently
> **withheld** and cannot be reported.
>
> Both Gross Margin and Gross Contribution are on hold under H1 (Data Quality).
> Factory cost is materially understated for this period, which would overstate
> gross margin. The underlying margin is withheld pending correction.
>
> The April 2026 PTMT margin cannot be stated until the factory cost master is
> corrected and the hold is lifted.
>
> Traversal: `margin/PTMT/2026-27`

The live answer contained no blocked margin value. The full numeric evidence
remains in the Resolution register and is not copied into the model-facing hold
reason.

### Projected year-end for an unspecified state head

**HTTP status:** `200`

> I need a bit more information before I can proceed.
>
> Please name the State Head and the measure. A projection may only be reported
> if the underlying node carries a typed projection measure with
> seasonal-service, observed-month, and calibration metadata. If no such
> measure exists, I will report it as unavailable and will not estimate or
> extrapolate from actuals.

### August “sales” for an unspecified member

**HTTP status:** `200`

> I need the member name and the intended basis.
>
> Secondary Order Booking is distributor-to-retailer booking. Primary Dispatch
> is company-to-distributor sale. These are different populations and will not
> reconcile. I can present either basis or both side by side with each basis
> clearly labelled.

## Fixes found by live verification

1. Standalone calendar years and Unicode/spaced fiscal-year forms are now
   treated as temporal metadata, without exempting currency, percentage, or
   count claims.
2. H1 now matches the Resolution register's canonical `margin` scope while the
   graph still emits the stricter `gross_margin` measure kind.
3. H1's model-facing reason is a safe non-numeric explanation; the detailed
   numeric evidence remains available only in the Resolution register.
4. Unsupported first drafts receive one bounded rewrite using the same resolved
   nodes and the same numeric guard. A second unsafe draft remains blocked.
5. Unspecified projection and August-member questions now produce deterministic
   basis-aware clarifications.

## Final verification result

The Prompt 115 implementation, focused tests, typecheck, and all three required
safe-failure behaviors pass. The complete live 14-question acceptance transcript
is not claimed as passed: two questions are explicitly blocked by missing typed
derived measures, and the remaining run was interrupted by a workspace restart.