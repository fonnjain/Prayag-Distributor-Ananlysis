---
name: Canonical coverage evidence
description: Rules for canonical, effective-dated organisation coverage derived from sales-register customer evidence.
---

Coverage is anchored to assignable `state_hierarchy` leaves and the responsible state head, never to legacy territory spelling variants.  A register-derived coverage period is valid only when each selected customer has exactly one resolved, non-system register head in the leaf and fiscal year.  Coverage represents full register months and stores its customer count and net evidence.

**Why:** Aggregate totals can hide customer-level overlap, unassigned rows, and project buckets. Assigning those cases to a person would fabricate sales geography. Punjab FY2023-24 is deliberately retained as an explicit uncovered gap rather than guessed.

**How to apply:** Any future derivation must validate every register bucket before writing coverage, exclude mixed, NULL, system, or unresolved attribution from derived rows in the same transaction, and persist those rejected buckets as explicit uncovered gaps. Reconcile source rows, coverage rows, customer evidence, and effective month bounds in the verification report. System “Unassigned coverage” remains a distinct inactive sentinel, never an employee assignment.

Post-sync drift detection is read-only: it records an `ok`, `drift`, or `error` audit event and warns operators, but never changes coverage from refreshed register values.

**Why:** New register rows can change customer evidence without an approved organisation decision. Auto-rewriting coverage would silently reassign geography.

**How to apply:** Resolve a recorded drift through a separately reviewed coverage change; preserve the audit event as evidence of what the register changed.

Direct State Head workbooks are a separate operational-attribution evidence source. When a transaction-level pack conflicts with derived coverage, report the named customer/head differences read-only and require an explicit approved coverage review before changing any assignment.

**Why:** A direct workbook may reflect a valid business reassignment, but it can also contain carry-forward, future-dated, institutional, or departed-head rows. Treating either source as an unattended migration authority would silently rewrite organisation ownership.

**How to apply:** Compare raw dates, canonical State Head aliases, state variants, and customer-level head sets first. Keep project/other and departed-head values visible as unassigned evidence until an approved organisation decision defines their destination.