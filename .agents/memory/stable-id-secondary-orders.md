---
name: Stable-ID secondary orders
description: Source-reconciliation and duplicate-handling rules for Product-Wise Secondary Order Reports.
---

The stable-ID secondary-order table is **order booking**, not dispatch or secondary sales. Its source may contain repeated `(order_id, product_code)` lines. Preserve every source line with a source-position occurrence identity and a content hash; do not collapse genuine repeated lines.

Exact repeated export rows are retained in analytical totals so the page always reconciles to the supplied export. They must be shown in load verification and on the page, and the system should flag a future file when exact duplicate-export rows exceed 0.5% of loaded lines.

**Why:** The initial August 2026 report had 32 repeated order/product pairs: 27 had distinct commercial values and five were exact export duplicates. Dropping either class created an unexplained mismatch with the workbook totals.

**How to apply:** For every new report loader or downstream analysis, retain the booking-versus-dispatch label, use the stored occurrence/hash identity, and make duplicate inclusion visible rather than silently de-duplicating.

Every real stable-ID upload must atomically commit its lines and a checksum-backed verification ledger entry. Compare it only with an earlier non-regressed upload, enforce absolute RET#/DIST#/person resolution floors, and keep its analytics status isolated regardless of a passing assessment.

**Why:** A line-only success without a ledger record breaks source provenance, while treating a previously flagged low-resolution upload as the next baseline can hide a persistent identity failure.

**How to apply:** Keep the upload transaction and comparison lock together; do not make CLI idempotency checks create artificial upload evidence. A future analytics integration needs its own explicit approval after multiple independently verified source reports.