---
name: Canonical coverage evidence
description: Rules for canonical, effective-dated organisation coverage derived from sales-register customer evidence.
---

Coverage is anchored to assignable `state_hierarchy` leaves and the responsible state head, never to legacy territory spelling variants.  A register-derived coverage period is valid only when each selected customer has exactly one resolved, non-system register head in the leaf and fiscal year.  Coverage represents full register months and stores its customer count and net evidence.

**Why:** Aggregate totals can hide customer-level overlap, unassigned rows, and project buckets. Assigning those cases to a person would fabricate sales geography. Punjab FY2023-24 is deliberately retained as an explicit uncovered gap rather than guessed.

**How to apply:** Any future derivation must validate every register bucket before writing coverage, reject mixed, NULL, system, or unresolved attribution in the same transaction, and reconcile source rows, coverage rows, customer evidence, and effective month bounds in the verification report. System “Unassigned coverage” remains a distinct inactive sentinel, never an employee assignment.