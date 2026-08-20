---
name: Open-FY coverage drift policy
description: Structural-only reconciliation for live register evidence, with frozen periods remaining strict.
---

Open fiscal years report canonical coverage drift only for structural changes: source attribution, customer-to-head movement, customer appearance/disappearance, count changes, effective-date changes, or a leaf gaining/losing a head. Same-head, same-customer, same-period net-value movement is normal while a register remains open.

Frozen fiscal years remain strict and report all differences, including net-value changes.

**Why:** A live register changes as late entries and corrections arrive. Treating each value movement as an ownership warning created false review work, while suppressing structural evidence could conceal a real coverage change.

**How to apply:** Use the shared frozen-register boundary when deciding strictness. Open-FY drift reads are cached without a TTL and must be invalidated only after a committed register replacement (`replaced` or `frozen-anchored`), never after a short-read abort, failed write, or skipped month.