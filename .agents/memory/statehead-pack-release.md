---
name: State Head pack release
description: Rules for safely assembling State Heads folder workbooks into a reconciled master pack.
---

Temporary copies and legacy feeder workbooks must be represented in an audit manifest, not silently included in folder totals. A canonical filename may establish identity only when its row label resolves through the person registry; competing canonical candidates need a manifest-level conflict, while unknown, mixed, and non-territory files require an explicit approved mapping. Released totals must compare to the matching territorial primary-register scope, including missing material heads. A workbook's FY label is never sufficient on its own: raw transaction dates must sit within that FY, and rows later than the review date must be reported separately.

**Why:** Folder-level sums can double-count copied workbooks and can misattribute departed or project feeders while still looking numerically plausible. FY2025-26 State Head workbooks also carried FY-labelled lines dated in FY2026-27, so large date leaks can cancel unrelated scope gaps and create a false reconciliation.

**How to apply:** Preserve file IDs, Report 1 totals, mappings, exclusions, raw-date/FY mismatch totals and ranges, future-dated totals, and material per-head discrepancies in the read-only release output. Treat unresolved feeder evidence or any material date/FY mismatch as a release blocker until explicitly approved.

For the FY2025-26 historical pack, all inspected workbooks use the same unbounded `QUERY(Sheet1!A1:M)` construction. The Report tabs are derived from that raw tab (with a calendar/FY helper sheet), so report totals cannot be treated as an independent source that repairs raw-row coverage.

**Why:** The date leak is a copied template defect rather than separate workbook mistakes; comparing report summaries to Sheet1 cannot explain a shortfall when they share the same source.

**How to apply:** Escalate the shared query/template for a one-time date-bound fix. Diagnose coverage gaps through raw-file-to-register `head_canon` reconciliation and explicit mapping of feeder/NULL-head buckets, not by summing overlapping Report tabs.

For a release requested for one specific FY, reject any date-valid raw rows from every other FY too. The row-level date check alone only validates a row against its own label and can otherwise let a correctly labelled carry-forward year pass a targeted pack gate. Cross-folder invoice-plus-normalized-party comparison is evidence of overlap only; a zero-overlap result still needs its deduplicated union reconciled to the register before it can be called complementary coverage.

**Why:** A live FY2026-27 folder carried a complete, internally correctly labelled FY2025-26 population. It evaded a targeted check until the requested-year rule was explicit, while its identity-disjoint union with the historical folder far exceeded the FY2025-26 register.

**How to apply:** In targeted release checks, block every non-requested FY with date-valid rows and print the file, row count, and amount. When comparing folders, key evidence on invoice plus normalized party, surface identity conflicts or blanks, and never infer “missing half recovered” from headline totals alone.