---
name: State Head pack release
description: Rules for safely assembling State Heads folder workbooks into a reconciled master pack.
---

Temporary copies and legacy feeder workbooks must be represented in an audit manifest, not silently included in folder totals. A canonical filename may establish identity only when its row label resolves through the person registry; competing canonical candidates need a manifest-level conflict, while unknown, mixed, and non-territory files require an explicit approved mapping. Released totals must compare to the matching territorial primary-register scope, including missing material heads. The workbook FY label selects its fiscal-year population; raw dates are quality evidence only, with rows later than the review date reported separately.

**Why:** Folder-level sums can double-count copied workbooks and can misattribute departed or project feeders while still looking numerically plausible. The current pack deliberately carries comparison-year rows, and its raw date-year component is known to be wrong for some legacy rows even when its FY labels are correct.

**How to apply:** Preserve file IDs, Report 1 totals, mappings, exclusions, raw-date/FY mismatch totals and ranges, future-dated totals, and material per-head discrepancies in the read-only release output. Treat unresolved feeder evidence, undated rows, and future dates as blockers until explicitly approved; report date/FY mismatches without excluding their correctly labelled rows.

For the FY2025-26 historical pack, all inspected workbooks use the same unbounded `QUERY(Sheet1!A1:M)` construction. The Report tabs are derived from that raw tab (with a calendar/FY helper sheet), so report totals cannot be treated as an independent source that repairs raw-row coverage.

**Why:** The date leak is a copied template defect rather than separate workbook mistakes; comparing report summaries to Sheet1 cannot explain a shortfall when they share the same source.

**How to apply:** Escalate the shared query/template for a one-time date-bound fix. Diagnose coverage gaps through raw-file-to-register `head_canon` reconciliation and explicit mapping of feeder/NULL-head buckets, not by summing overlapping Report tabs.

For a release requested for one specific FY, select the matching workbook FY label. Comparison-year rows bearing other valid labels are expected in the same workbook and must not block the requested FY. Cross-folder invoice-plus-normalized-party comparison is evidence of overlap only; a zero-overlap result still needs its deduplicated union reconciled to the register before it can be called complementary coverage.

**Why:** A live FY2026-27 folder legitimately carries an internally correctly labelled FY2025-26 population for business comparison. Its raw date-year is unreliable for that population, so using it as an exclusion rule created a false contamination finding.

**How to apply:** In targeted release checks, aggregate only the requested label and display other labels as comparison data. When comparing folders, key evidence on invoice plus normalized party, surface identity conflicts or blanks, and never infer “missing half recovered” from headline totals alone.

For the FY2026-27 multi-head pack, cross-head financial duplication can retain the same invoice number and line amount while carrying a different transaction date in each head workbook. Assess overlap in two stages: invoice+normalized-party+amount establishes the financial duplicate; date equality is a separate source-quality signal. The per-workbook Report tabs aggregate their own `Sheet1` with `QUERY`/`SUMIFS` and have no cross-head deduplication.

**Why:** Exact or near-2× customer totals can otherwise be misread as competing ownership or genuine additional business merely because copied source dates drift. Summing head reports carries the duplicate financial lines forward.

**How to apply:** For a multi-head customer, display matched rows side-by-side, flag date mismatches without treating them as new sales, and never sum per-head Report totals as a company/territory total until duplicate financial lines have been removed.