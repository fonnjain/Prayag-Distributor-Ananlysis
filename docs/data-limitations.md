# Data limitations

## FY2023–24 primary register is month-only

FY2023–24 is a known source-granularity limitation, not a data defect. The
source workbook uses a 10-column monthly schema and contains **137,619 rows**.
It has no `invoice_date` and no invoice identifier (`invoice_no`).

The data is correct at the monthly granularity provided. Day-level dates,
weekly analysis, and invoice-count analysis are not possible for FY2023–24 and
will not be inferred, backfilled, reloaded, or reconstructed. FY2023–24 remains
frozen.

Register-based surfaces that ask for a distinct invoice count read the nullable
invoice identifier and therefore return **0**, without an error, for this FY.
Company Reports Report 7 is the exception: its existing fallback counts
`line_uid` values so the as-of total remains usable. When FY2023–24 is selected,
the page labels and caveat make clear that this is a line-based fallback, not a
distinct invoice count.

No frozen-year data or ingestion logic should be changed to address this
limitation. A dated historical SAP/ERP export would be a separate source, not a
backfill of this register.