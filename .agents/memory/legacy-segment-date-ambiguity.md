---
name: Legacy Segment date ambiguity
description: Evidence boundary for interpreting numeric dates in historical Segment Wise order workbooks.
---

**Rule:** Do not transpose day and month on historical Segment Wise numeric date cells merely because the literal Excel date falls outside the workbook's declared fiscal year. Keep the literal source interpretation until an independent business control proves another date.

**Why:** The proposed out-of-FY transpose rule always manufactures an in-FY answer and cannot resolve the many numeric rows for which both readings are valid and inside the same FY. Google Sheets supplies these cells as unformatted Excel serials, and the reader consumes those serials literally; a different interpretation is therefore a source-data assertion, not a parser correction. Independent PSCode archive-to-database monthly reconciliation shows no transpose in that source.

**How to apply:** Before changing historical monthly or quarterly reporting, obtain an independent monthly control or original CRM evidence for the Segment Wise dates. Preserve raw serials and do not rewrite closed-year dates based only on workbook naming or FY bounds.