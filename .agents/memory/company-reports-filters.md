---
name: Company Reports filters + export
description: Design decisions for the Company Reports cascading filters, month filter, and Excel export.
---

- Month filter never bypasses Rule 1: requested labels are INTERSECTED with the complete like months, keeping current/prior label pairs aligned. YTD/Full send no months param.
- **Prior-FY entity scope:** head/state filters describe the CURRENT FY territory tree; historical head/state columns are backfilled per customer and can disagree for reassigned parties. So heads/states are resolved to the current-FY customer set and the prior FY is filtered by those customers only.
  **Why:** without this, a reassigned distributor's history lands under the wrong (or no) territory and growth figures mislead.
- Filter values travel as JSON-encoded string arrays in query params (distributor names contain commas); SQL uses sql.join IN-lists (drizzle ANY(jsArray) pitfall).
- Filtered or asOf requests always build live (never snapshot — unbounded key space); only the unfiltered default is snapshotted.
- Export guardrails: per-sheet row cap with a visible truncation note + small concurrency limit; the Info cover sheet states active filters so a filtered file is never mistaken for company totals.
- Frontend cascade must prune ALL levels (including heads) whenever the tree reloads (FY switch), or a stale head silently scopes the report to nothing.
- **Pages must keep their established sales basis when gaining filters.** Regional stays on order-book retail sales, Coverage on roster reach — switching a page to sale_line just to enable row-level filtering silently redefines its figures (a completion review rejected exactly that). Filter Sheets-derived pages at the aggregate level instead.
- **Vocabulary bridge:** roster and order-book aggregates use informal head nicknames and their own state spellings, while the filter tree uses sale_line names. Normalise BOTH sides through the shared alias maps before matching; new roster/order-book heads or states need alias entries or they silently match nothing.
- **Snapshot-only pages have no FY dimension:** Regional/Coverage read the current dashboard snapshot, so they are declared NONE (FY selector hidden) and their filter trees are pinned to the current FY. **Why:** a historical FY selection would otherwise combine that FY's filter options with current data and export it as if scoped.
- **Aggregate scoping rule:** under a state filter, per-head tables must be constrained to heads touching the selected states AND clearly marked that their counts cover the head's full territory (no per-state split exists) — in the UI and the export's Info sheet. **Why:** otherwise a state-filtered export mixes state-scoped totals with company-wide head totals.
