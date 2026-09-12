---
name: Secondary monthly export availability
description: Rules for deciding whether a member export has monthly data and preserving mixed-availability month rows.
---

Decide whether to include a Monthly sheet from the selected member's own `secondary_head_month` rows. Never infer availability from teammates or roll up subordinate rows.

Treat monthly plan, ordered, received, and achievement as independently available. A row marked `not_yet_recorded` can still contain a valid ordered amount; preserve every non-null recorded value and blank only unavailable cells.

**Why:** Monthly source rows can represent an order-versus-sales lag. Row-level blanking silently discards valid order booking, while team-level availability gives managers data that is not their own.

**How to apply:** In exports and reports, query the exact member identity and reporting head, conditionally include Monthly from that result, and render each measure as value, genuine zero, or unavailable with a reason.