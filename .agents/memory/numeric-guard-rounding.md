---
name: Numeric guard 2-dp display rounding
description: Why buildAllowed adds 2-decimal lakh/crore rounded forms to the allowlist
---

**Rule:** `buildAllowed` in numericGuard.ts adds, for every payload number, its 2-decimal lakh (≥1,000) and crore (≥100,000) display forms (e.g. 13,890 → 14,000 via "Rs 0.14 lakh").

**Why:** The 0.15% tolerance covers 2-dp rounding only for large displayed values; small values ("Rs 0.14 lakh") round with up to ~4% relative error and were flagged as unmatched even though they are legitimate citations of payload figures. This does not weaken the guard — only the exact rounded display of an existing number is allowed; derived sums still get flagged (by design).

**How to apply:** If reports show `requires_review` with values that are exact 2-dp displays of payload numbers, the guard allowlist is the place to look — not the prompt.
