---
name: C3 matrix + cohort modes
description: Comparison Mode C (matrix/quadrants/roster) and Mode D (rule cohorts) — durable design rules and traps
---

- **achievementTotal from deepDiveData is a PERCENT** (57.5 = 57.5%), not a ratio. Any band/threshold comparison must multiply user-facing ratio bands by 100.
- **Distributor deep dive is per-state-head only** — `loadDistributorDeepDiveResilient(fy)` returns empty without a stateHead. Company-wide figures must aggregate over all `registry.stateHeads`, dedupe members/distributors by normKey, and track headsFailed.
- **Trend direction slope must use the period's actual index** in the requested sequence (not the ordinal within the used subset) so an excluded partial middle period counts as two steps.
- **Tenure guard split**: set-wide guard 7 (working-day ratio > 2 across the entity set) suppresses ranking for everyone; per-entity direction blocking must apply only to the members whose OWN working days are the short side — otherwise one new joiner erases every peer's direction company-wide.
- **Sheet-scoped cohort rules cannot be channel-filtered**: assignment/achievementBand/distributorTier/sheetMapped come from working sheets (territory-only by construction). Reject non-territory channel with 400 and label the basis "WORKING-SHEET DATA", never echo a project/all channel label.
- **Long cohort builds vs proxy timeout**: any endpoint that can run minutes must detach the build (coalesced promise map + bounded TTL cache), return 202 {building:true, retryAfter} after ~45s, and the client polls. Otherwise the dev/prod proxy returns 502 HTML and the frontend sees a JSON parse error.
- **Validate request-controlled cache keys before keying** (rule/channel allowlists, fy regex, band ∈ (0,1)) and bound the cache (evict expired then oldest) — otherwise junk requests grow it for process lifetime.
- Guard 2 blocks cross-year period sets when completeness differs (partial vs complete quarters in different FYs); acceptance tests must use like-complete periods across FYs or same-FY partials.
