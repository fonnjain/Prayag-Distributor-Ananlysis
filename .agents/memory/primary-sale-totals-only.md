---
name: Primary sale totals-only path for head-less FYs
description: How FY2024-25/2025-26 sale figures stay period-exact despite missing state-head attribution, and the pending-orders basis rule.
---

FY2024-25 and FY2025-26 registers came from 11-column sheets with no STATE HEAD column, so `sale_line.head_canon` is NULL for those years.

**Rule:** `loadDispatchSaleFromDb` must never discard the period-exact company total just because head attribution fails. When >90% of the amount is unmapped, it returns a totals-only result (`headsAvailable:false`, empty `byHead`) instead of an error.

**Why:** The old guard returned an error, which made the app fall back to a full-FY-total sheet (2025-26) or nothing at all (2024-25). Consequences: date filters silently ignored on prior FYs, and pending = period booking − full-FY sale produced negatives of hundreds of crores.

**How to apply:**
- `_loadSalePeriod` (primaryPeriod.ts) merges per-head splits from the State Head Sale sheet only when the selection is the FULL FY (`monthLabels.length >= 12`); sub-year selections keep `byHead` empty — honest blank beats fabricated splits.
- Pending orders (both `/mgmt/data` and `/mgmt/primary`): compute only when booking and sale share the same period basis (or the selection is full-FY), clamp at ≥0, otherwise send null. Frontend treats null pending as "—" and suppresses the PendingChip.
- FY2025-26 genuinely has sale (361.00) > OB (342.03) for the full year — OB source incompleteness or prior-FY carry-over, unresolved as of Aug 2026.
