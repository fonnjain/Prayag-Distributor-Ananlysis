---
name: Month-completeness rule tied to register lock
description: isMonthComplete grace-window semantics and the Oct-24 dropped-month incident
---

**Rule:** `isMonthComplete` (analytics.ts) treats a month with invoice dates as complete when max invoice date reaches the month's last calendar day, OR once the register month-lock instant has passed (00:00 UTC on the 7th of the following month = lastDay 00:00 + 7 days). Months with null dates use the calendar-elapsed fallback.

**Why:** Oct-24's last invoice was Oct-30, so the old "must reach the literal last day" rule silently dropped a fully closed month from Company Reports' like-months (FY24-25 showed ₹318.48 Cr instead of ₹341.14 Cr). Once a month is locked its data cannot change, so it is complete regardless of where invoices stop.

**How to apply:** Any completeness heuristic keyed on max invoice date must also accept the lock instant. Beware off-by-one: lock = lastDay + 7d, NOT lastDay + 1d + 7d (a review caught exactly this).

**Snapshot interaction:** frozen-FY snapshots are served final and never rebuilt — any change to payload-shaping logic (like this rule) requires bumping the snapshot key version (`company-reports|v2|`, `analytics|v2|`) AND updating every `invalidateSnapshots` prefix that referenced the old key.
