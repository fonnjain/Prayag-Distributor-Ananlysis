---
name: Product-Wise monthly source lock
description: Immutability policy for verified Product-Wise CRM source months.
---

Product-Wise CRM source loads follow the shared `monthFreezeAt()` lock exactly: the current month plus three prior months remain open, and a month freezes at 00:00 IST on the first day of the fourth following month. For Aug-26, that is 1 December 2026 IST. There is no loader override or ordinary unfreeze path.

**Why:** Product-Wise raw SKU rows underpin retailer-facing and B3/S1 analysis. Later exports must not silently rewrite the source evidence after the period is closed.

**How to apply:** Keep successful-load provenance append-only and use the shared freeze helper—never a parallel date calculation. A persisted `register_month_state.frozen_at` is stronger than the calendar; if a freeze-policy migration extends the window after an old rule already stamped rows, correct that historical state explicitly and narrowly. Surface `not_loaded`, `in_progress`, and `frozen_verified`; do not imply that an in-progress Product-Wise source has a scheduler or recurring source until one is explicitly approved.