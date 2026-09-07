# FY2026–27 Sales (Dispatch) — Database vs Live Sheet

**Report date:** 7 September 2026  
**Scope:** Read-only discrepancy investigation  
**Status:** No changes, builds, writes, detector calls, or re-syncs were performed.

## Executive Summary

The Overview Sales (Dispatch) chart agrees with the live Google Sheet for April, May, and September. Production is ahead of the current sheet in June, July, and August:

| Month | Production minus live sheet rows | Production minus live sheet value |
|---|---:|---:|
| Jun-26 | +20 | +₹4,82,810.94 |
| Jul-26 | +36 | +₹5,61,852.00 |
| Aug-26 | +7 | +₹27,724.00 |

No discrepancy is caused by loader rejection, quarantine, non-current versions, date parsing, tab/month disagreement, or undated rows. June and July are frozen-source drift. August’s lower source was read but not adopted because the strict freeze-transition guard refuses any reduction from the last-good row count.

# A. Production Database

Source: production sale_line view and underlying sale_line_all table, filtered to:

- fy = '2026-27'
- version_status = 'current'

The view and table returned identical current-row figures.

| Month | Current rows | SUM(amount) | Minimum invoice date | Maximum invoice date |
|---|---:|---:|---|---|
| Apr-26 | 5,542 | ₹13,10,81,249.77 | 6 Apr 2026 | 30 Apr 2026 |
| May-26 | 11,812 | ₹28,27,83,021.58 | 3 May 2026 | 31 May 2026 |
| Jun-26 | 12,868 | ₹31,42,78,773.47 | 1 Jun 2026 | 30 Jun 2026 |
| Jul-26 | 13,803 | ₹32,10,28,904.63 | 2 Jul 2026 | 31 Jul 2026 |
| Aug-26 | 12,878 | ₹30,42,28,618.69 | 3 Aug 2026 | 31 Aug 2026 |
| Sep-26 | 122 | ₹69,00,063.28 | 2 Sep 2026 | 7 Sep 2026 |

# B. Direct Live Google Sheet Totals

Source spreadsheet:

**19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps**

Exact tabs:

- Apr
- May
- Jun
- July
- Aug
- Sep

Amount column:

- **Column:** M
- **Header:** Taxable Value
- **Normalized header:** TAXABLEVALUE

The following is a direct raw sheet measurement. Every post-header row was counted and every numeric column-M value was summed. No loader filtering, deduplication, month parsing, or date parsing was applied.

| Tab | Total populated rows | Header rows | Raw data rows | Raw SUM(M) |
|---|---:|---:|---:|---:|
| Apr | 5,543 | 1 | 5,542 | ₹13,10,81,249.77 |
| May | 11,813 | 1 | 11,812 | ₹28,27,83,021.58 |
| Jun | 12,849 | 1 | 12,848 | ₹31,37,95,962.53 |
| July | 13,768 | 1 | 13,767 | ₹32,04,67,052.63 |
| Aug | 12,872 | 1 | 12,871 | ₹30,42,00,894.69 |
| Sep | 123 | 1 | 122 | ₹69,00,063.28 |

There are no blank post-header rows, nonnumeric Taxable Value cells, or apparent total rows in these tabs.

# C. Database vs Live Sheet

Differences are production database minus live Google Sheet.

| Month | DB rows | Sheet rows | Row difference | DB amount | Sheet amount | Rupee difference |
|---|---:|---:|---:|---:|---:|---:|
| Apr-26 | 5,542 | 5,542 | 0 | ₹13,10,81,249.77 | ₹13,10,81,249.77 | ₹0.00 |
| May-26 | 11,812 | 11,812 | 0 | ₹28,27,83,021.58 | ₹28,27,83,021.58 | ₹0.00 |
| Jun-26 | 12,868 | 12,848 | +20 | ₹31,42,78,773.47 | ₹31,37,95,962.53 | +₹4,82,810.94 |
| Jul-26 | 13,803 | 13,767 | +36 | ₹32,10,28,904.63 | ₹32,04,67,052.63 | +₹5,61,852.00 |
| Aug-26 | 12,878 | 12,871 | +7 | ₹30,42,28,618.69 | ₹30,42,00,894.69 | +₹27,724.00 |
| Sep-26 | 122 | 122 | 0 | ₹69,00,063.28 | ₹69,00,063.28 | ₹0.00 |

# D. Why the Months Differ

## D1. Loader Rejection or Quarantine

The live rows were passed through the relevant parser logic in memory without writing them.

| Tab | Raw data rows | Valid parsed rows | Rejected rows |
|---|---:|---:|---:|
| Apr | 5,542 | 5,542 | 0 |
| May | 11,812 | 11,812 | 0 |
| Jun | 12,848 | 12,848 | 0 |
| July | 13,767 | 13,767 | 0 |
| Aug | 12,871 | 12,871 | 0 |
| Sep | 122 | 122 | 0 |

Diagnostics across all six tabs:

| Condition | Rows |
|---|---:|
| Missing item code | 0 |
| Missing or nonnumeric Taxable Value | 0 |
| Unlabelled month | 0 |
| Parsed month differs from tab | 0 |
| MONTH column differs from tab | 0 |
| Undated or unparseable date | 0 |

The June, July, and August differences are not caused by loader rejection or quarantine.

## D2. Non-Current Database Versions

Production sale_line_all contains no superseded or other non-current rows for the six FY2026–27 month labels.

| Month | Non-current rows |
|---|---:|
| Apr-26 | 0 |
| May-26 | 0 |
| Jun-26 | 0 |
| Jul-26 | 0 |
| Aug-26 | 0 |
| Sep-26 | 0 |

The discrepancies exist between current production and the current source. They are not hidden superseded duplicates.

## D3. Date Parsing and Tab/Month Mismatch

The live sheet invoice dates are numeric Google Sheets or Excel date serials in column C. They are not text dates such as 01-06-2026.

Therefore:

- there are no DD-MM versus MM-DD textual ambiguities;
- no day-1-to-12 locale swaps are present;
- every row parses into the month represented by its source tab;
- every populated MONTH value agrees with the tab;
- no row is undated or unparseable.

The project’s historical DD-MM/MM-DD problem is not involved here.

## D4. June and July

June and July are confirmed frozen-source drift.

### June

- **Production:** 12,868 rows and ₹31,42,78,773.47
- **Live sheet:** 12,848 rows and ₹31,37,95,962.53
- **Difference:** +20 rows and +₹4,82,810.94
- **Frozen-drift status:** drift
- **Production frozen anchor:** 1 Aug 2026, 07:46:31 UTC

### July

- **Production:** 13,803 rows and ₹32,10,28,904.63
- **Live sheet:** 13,767 rows and ₹32,04,67,052.63
- **Difference:** +36 rows and +₹5,61,852.00
- **Frozen-drift status:** drift
- **Production frozen anchor:** 8 Aug 2026, 04:17:32 UTC

The current sheet contains fewer rows than the production state that was frozen. Ordinary monthly replacement deliberately refuses to overwrite anchored months. This is source drift after database settlement, not parser loss.

## D5. August

Current production state:

- **Rows:** 12,878
- **Value:** ₹30,42,28,618.69
- **Last replaced:** 6 Sep 2026, 09:33:08 UTC

Current live source:

- **Rows:** 12,871
- **Value:** ₹30,42,00,894.69

Difference:

- **Rows:** production ahead by 7
- **Value:** production ahead by ₹27,724.00

The latest register run read and parsed all 12,871 current August rows and recorded zero skipped rows. The difference is not a parsing or rejection issue.

August was not replaced because its source was below its last-good production baseline at the freeze transition. The strict freeze-transition guard refuses even a one-row reduction. Only September’s 122 rows were written during the latest run.

Unlike June and July, August has no persisted frozen anchor and no frozen-drift-check record. It is calendar-frozen but unanchored. Its source difference was observed but not adopted.

# E. Last FY2026–27 Register Sync

Latest successful durable register run:

- **Source:** production ingest_run
- **Run ID:** 369
- **Source type:** register_sheets_sync
- **Started:** 7 Sep 2026, 09:32:44.793 UTC
- **Status:** ok
- **Rows read:** 56,962
- **Rows skipped:** 0

Per-month source observations:

| Month | Rows read |
|---|---:|
| Apr-26 | 5,542 |
| May-26 | 11,812 |
| Jun-26 | 12,848 |
| Jul-26 | 13,767 |
| Aug-26 | 12,871 |
| Sep-26 | 122 |

Per-month result:

- **Jun-26:** frozen; subsequent source edits are not reflected automatically.
- **Jul-26:** frozen; subsequent source edits are not reflected automatically.
- **Aug-26:** last successfully replaced on 6 Sep 2026 at 09:33:08 UTC; the latest lower source was read but not adopted.
- **Sep-26:** replaced on 7 Sep 2026 at 09:32:52.482 UTC with 122 rows and ₹69,00,063.28.

Any sheet edit after the 7 September 09:32:44 UTC read is not represented by that run. Even an edit observed during a later read is not necessarily written if the month is frozen or fails the strict freeze-transition guard.

# F. Column Summed by the Chart

The chart sums only sale_line.amount.

For this register, amount comes from:

- **Google Sheet column:** M
- **Header:** Taxable Value

Loading chain:

1. The column mapper recognizes TAXABLEVALUE as the amount column.
2. The parser converts the cell to a number.
3. The loader stores it as sale_line_all.amount.
4. The sale_line view exposes current-version rows.
5. The dashboard calculates SUM(amount) by month_label.
6. The monthly result is saved in the dashboard snapshot and rendered by the area chart.

No other field contributes to the chart:

- not Sale Rate;
- not MRP;
- not quantity;
- not gross value;
- not Secondary Order Booking;
- not a Google Sheet chart total.

The chart is exclusively the sum of persisted Taxable Value amounts from current sale_line rows.

# Final Status

This investigation was read-only. No source data, production data, files, builds, workflows, detector state, sync state, or deployment state was modified.
