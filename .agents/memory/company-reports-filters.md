---
name: Company Reports filters + export
description: Design decisions for the Company Reports cascading filters, month filter, and Excel export.
---

- Month filter never bypasses Rule 1: requested labels are INTERSECTED with the complete like months, keeping current/prior label pairs aligned. YTD/Full send no months param.
- **Prior-FY entity scope:** head/state filters describe the CURRENT FY territory tree; historical head/state columns are backfilled per customer and can disagree for reassigned parties. So heads/states are resolved to the current-FY customer set and the prior FY is filtered by those customers only.
  **Why:** without this, a reassigned distributor's history lands under the wrong (or no) territory and growth figures mislead.
- Filter values travel as JSON-encoded string arrays in query params (distributor names contain commas); SQL uses sql.join IN-lists (drizzle ANY(jsArray) pitfall). Empty customer resolution uses a "\u0000none" sentinel — IN () is invalid SQL.
- Filtered or asOf requests always build live (never snapshot — unbounded key space); only the unfiltered default is snapshotted.
- Export guardrails: per-sheet row cap with a visible truncation note + small concurrency limit; the Info cover sheet states active filters so a filtered file is never mistaken for company totals.
- Frontend cascade must prune ALL levels (including heads) whenever the tree reloads (FY switch), or a stale head silently scopes the report to nothing.
