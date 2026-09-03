---
name: Prompt load approval gates
description: Hard sequencing rules for source-load work that can write production data.
---

Source-load work must not write code or trigger a production load until the requested design points are explicitly agreed, and the exact diff must be shown before it is applied.

**Why:** A prior Prompt 56 load was safe because its sources were pre-validated, but it still ran before Section B confirmation and before the required diff review.

**How to apply:** Treat design confirmation and diff review as blocking gates; if either is missing, remain read-only and ask for approval.