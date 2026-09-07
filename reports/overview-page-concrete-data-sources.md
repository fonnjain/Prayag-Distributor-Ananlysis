# Overview Page — Concrete Data Sources

**Report date:** 7 September 2026  
**Scope:** Read-only source-lineage review  
**Status:** No files, data, builds, or workflows were changed.

## A. Primary Sale and Dispatch

**Overview label:** “Primary sale & dispatch — Source: sale_line register (live YTD), through 07 Sept 2026, all channels incl. project & institutional.”

### Database origin

- **Read view:** sale_line
- **Physical table:** sale_line_all
- **Filter:** fy = '2026-27' and version_status = 'current'
- **Value:** sum of amount
- **Date coverage:** latest available invoice_date
- **Channels:** no project or institutional exclusion is applied in this Overview query

The sale_line view exposes current-version records from sale_line_all. The Overview aggregation groups those rows by month_label.

### Google Sheet feeder

- **Spreadsheet ID:** 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps
- **Register:** SALE SHEET 26-27
- **Monthly tabs through 7 September:** Apr, May, Jun, July, Aug, Sep
- **Amount source column:** Taxable Value, loaded into sale_line.amount

Each monthly tab is normalized and loaded into the database.

### Live or snapshot?

The underlying data consists of current production sale_line rows, but the Overview page does not execute this database query on every page request. The aggregation is materialized into the dashboard snapshot during dashboard synchronization.

The precise description is: current production sale_line data as of the most recent dashboard snapshot.

## B. Registered Retailer Count and ₹79.84 Cr Secondary OB

These are two different measures displayed on the same card.

### Registered retailer count

- **Google Sheet ID:** 1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc
- **Tab:** Retailer
- **Rows counted:** roster records identified by RET#
- **Purpose:** registered retailer/master-roster count

This is the concrete source called “Retailer-Distributor Data” for the retailer count.

### ₹79.84 Cr Secondary OB

The ₹79.84 Cr figure does not come from the Retailer tab.

- **Google Sheet ID:** 1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM
- **Tab:** SECONDARY ORDER BOOKING REPORT 2026-27
- **Source column:** M
- **Column meaning:** order-booked value
- **Calculation:** sum of column M across applicable member rows

This is secondary order booking, not secondary sales or dispatch.

### Live or snapshot?

Both figures are stored in the dashboard snapshot after the relevant sheets are read. They are not fetched live from Google Sheets when the Overview page opens.

## C. Distributors Only

**Overview label:** “Distributors only — Source: Retailer-Distributor Data — Direct commercial partners.”

It uses the same spreadsheet as the registered retailer count, but a different tab:

- **Google Sheet ID:** 1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc
- **Tab:** Distributor
- **Rows counted:** records whose column A begins with DIST#
- **Snapshot field:** distributor/channel-partner total

### Label caveat

“Direct commercial partners” is broader than the implemented calculation. The code counts DIST# distributor-roster rows. It does not separately identify or add direct dealers.

A more precise description is: registered distributors from the Distributor roster.

### Live or snapshot?

Dashboard snapshot, populated during synchronization.

## D. Secondary Retail Reach — 11,988

- **Google Sheet ID:** 1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM
- **Tab:** SECONDARY ORDER BOOKING REPORT 2026-27
- **Column:** K, Excel column number 11
- **Column heading/meaning:** Total Dealer 26-27
- **Calculation:** sum of column K across member rows
- **Deduplication:** none

Therefore, 11,988 is not a count of unique retailer identities. It is the sum of each member’s reported dealer or retailer reach. The same retailer can contribute more than once if represented under more than one member.

### Live or snapshot?

Dashboard snapshot. The figure is calculated while reading the Secondary Order Booking Report and saved into the snapshot payload.

### Stale-comment caveat

Some code comments still mention an older 11,338 figure or describe retailers not covered by a member. Those comments do not match the current implemented metric. The current card uses the column-K sum.

## E. FY26–27 Sales (Dispatch) Area Chart

### Database origin

- **Read view:** sale_line
- **Physical table:** sale_line_all
- **Filters:** FY2026–27 and current-version rows
- **Measure:** sum of amount
- **Grouping:** month_label
- **Month range:** through the latest loaded month and data date

### Google Sheet feeder

- **Spreadsheet ID:** 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps
- **Tabs through 7 September:** Apr, May, Jun, July, Aug, Sep
- **Sheet value column:** Taxable Value

The chart is primary sale or dispatch from sale_line. It is not secondary order booking.

### Live or snapshot?

The monthly database aggregation is materialized into the dashboard snapshot as fy2627_monthly_sales. The chart renders that snapshot array.

## F. FY26–27 Product Mix Doughnut

### Database origin

- **Read view:** sale_line
- **Physical table:** sale_line_all
- **Filters:** FY2026–27, current-version rows, and the same included months as the Sales area chart
- **Measure:** sum of amount
- **Grouping:** group_canon
- **Null or unmapped classification:** Unmapped

### Google Sheet feeder

- **Spreadsheet ID:** 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps
- **Monthly tabs:** Apr, May, Jun, July, Aug, Sep through the current loaded period
- **Raw classification column:** GROUP

### Product-group classification

The classification has two layers:

1. The register’s raw GROUP value.
2. Canonicalization using artifacts/api-server/config/item_group_map.json and the canonItemGroup mapping logic in the SKU catalogue module.

The normalized result is stored as sale_line.group_canon. Raw values without a recognized mapping appear under Unmapped.

### Live or snapshot?

The database grouping is calculated during dashboard synchronization and stored in the dashboard snapshot as fy2627_groups. The doughnut renders that snapshot rather than running a request-time database query.

## Consolidated Source Summary

| Overview measure | Immediate source | Original feeder |
|---|---|---|
| Primary sale and dispatch | sale_line view / sale_line_all table | Sheet 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps, monthly tabs |
| Registered retailer count | Dashboard snapshot | Sheet 1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc, Retailer tab |
| ₹79.84 Cr Secondary OB | Dashboard snapshot | Sheet 1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM, SECONDARY ORDER BOOKING REPORT 2026-27, column M |
| Distributors | Dashboard snapshot | Sheet 1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc, Distributor tab |
| Secondary Retail Reach | Dashboard snapshot | Sheet 1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM, SECONDARY ORDER BOOKING REPORT 2026-27, column K |
| Sales area chart | Snapshot of monthly sale_line.amount | Sheet 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps, monthly tabs |
| Product Mix doughnut | Snapshot of sale_line.amount by group_canon | Sheet 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps raw GROUP plus item_group_map.json |

## Final Status

This was a read-only lineage investigation. No files, source data, database data, builds, workflows, or deployment state were modified.
