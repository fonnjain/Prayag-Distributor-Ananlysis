---
name: Product-Wise CRM head authority
description: Why Product-Wise salesperson attribution must use a separate effective-dated CRM authority before person_registry.
---

Product-Wise salesperson attribution uses an approved, effective-dated full Employee ID + Sales User Name pair before consulting the general person registry. Do not remove prefixes such as `PRG-` for authority matching. A pair outside the authority may use a deterministic registry fallback, but it must remain visibly classified as NEW; ambiguous or unresolved pairs remain unattributed.

**Why:** The general registry contains legacy employee-code aliases and collisions. In the August 2026 source, stripping `PRG-351` linked Prabhakar Pratap Singh to a registry row for Sunil Patel, and `PRG-386` linked Santanu Kalita through Devdutt Joshi, overstating Sunil Patel by ₹79,99,623.

**How to apply:** For Product-Wise rows, select the authority version covering the source order date using the exact normalized full-ID/name pair. Use person_registry only after a true authority miss, and preserve the miss in user-facing reconciliation even when fallback attribution succeeds.