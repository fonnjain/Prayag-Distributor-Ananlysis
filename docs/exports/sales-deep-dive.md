## Sales Deep Dive Glossary

### Member KPIs (Headline Metrics)
*   **Primary Target (YTD):** The target assigned for direct billing from company to distributor/dealer up to the current date.
*   **Secondary Target (YTD):** The target for orders booked by the sales rep from retailers to distributors up to the current date.
*   **Order Booking (Secondary OB):** Total value of secondary orders booked from retailers/parties (Net = Sub Total, excluding taxes).
*   **Direct Dealers Order (Primary OB):** Value of orders booked directly from dealers, kept separate from retailer secondary OB.
*   **Sale (YTD Sales Received):** Actual secondary sales revenue received/confirmed.
*   **Achievement %:** Calculated as (Actual / Target). Several variants exist: Secondary (OB/Target), Direct Dealer (OB/Primary Target), and Sale (Sale/Total Target).
*   **CTC (Monthly/Annual):** "Cost to Company" - the salary cost of the team member.
*   **T.A. Bill + Station Cost:** YTD cumulative travel allowance and station expenses.
*   **Cost Ratio:** The rep's total cost (Salary + TA) as a percentage of their Sales received.
*   **Total Visits (YTD):** Cumulative count of all visits (retailer, distributor, direct dealer, leads) performed by the rep.

### Retailer & Spread Metrics
*   **Active Retailer:** A retailer who has placed at least one order (OB > 0) in the current fiscal year.
*   **Dormant Retailer:** A retailer listed in the rep's working sheet who has zero orders (OB = 0) in the current fiscal year.
*   **Business Per Retailer:** Average OB value per active retailer.
*   **Top 5/10 OB Share:** The percentage of total OB contributed by the top 5 or 10 retailers (concentration measure).
*   **Concentration Index (HHI):** Herfindahl-Hirschman Index for retailer OB; indicates how dependent a rep is on a few large customers.
*   **Cross-Sell Depth:** Average number of distinct SKU segments (brands) sold per customer.

### Visit Plan & Capacity
*   **Demonstrated Visits Per Day:** Total visits done divided by working days elapsed in the data period.
*   **Annual Capacity Anchor:** The total number of visits the rep successfully performed in the most recent closed fiscal year. Used as the realistic upper limit for future planning.
*   **Feasible Remaining Visits:** (Annual Capacity Anchor) - (Visits Done YTD). The number of visits the rep is realistically capable of doing in the rest of the year.
*   **Visit Gap:** (Feasible Remaining Visits) - (Remaining Visits Required to meet frequency targets). A negative gap indicates a capacity shortfall.

### ROI & SKU Analysis
*   **Revenue-to-Cost Multiple:** Total OB (or Sale) divided by Total Cost (CTC + TA). Indicates how many rupees of revenue are generated for every 1 rupee spent on the rep.
*   **Segment Coverage %:** The percentage of all available product segments (brands) that the rep has successfully sold to at least one customer.
*   **Win-Back Lead:** A retailer who did business in a prior FY but has no orders in the current FY and is missing from the current working sheet.

---

## Calculations & Logic

### Data Sources
1.  **State Head Dashboard ('Data' tab):** Source for headline KPIs (Targets, CTC, TA, YTD Visits).
2.  **Secondary Order Booking Report (SOBR):** Authority for the **Sale** figure, re-read directly to bypass Google Sheets ArrayFormula spill-cell lag.
3.  **Member Working Sheet ('Summary Report FY' tab):** Source for retailer-level detail, business plans per retailer, and visit counts.
4.  **Secondary Register Line (DB Table):** Source for historical performance, SKU/Segment spread (Phase 5), and win-back identification (Phase 6).

### Key Formulas & Logic
*   **Net Value:** All OB and Sale figures use **Sub Total** (net of taxes).
*   **Achievement %:** `(Actual / Target) * 100`. Never read from sheet % cells; always recomputed using raw numerators and denominators.
*   **Cost Ratio %:** `((Monthly CTC * Elapsed Complete Months) + YTD TA Bill) / YTD Sale * 100`.
*   **Elapsed Months:** For Salary/Target pro-rating, only **complete fiscal months** are counted (e.g., if today is July 23, elapsed = 3: April, May, June).
*   **Visit Capacity Anchor:** Priority is given to the **most recent closed FY total visits**. If no history exists, it projects the current `Demonstrated Rate * 304` (total FY working days).
*   **Visit Gap:** `(Annual Anchor - Visits Done) - (Total Required - Visits Done)`.
*   **Forward Visit Plan:**
    *   **Priority 1 (Maintain):** Active retailers, sorted by OB.
    *   **Priority 2 (Develop):** Dormant retailers with a distributor, sorted by `Business Plan / Max(Distance KM, 5)`.
    *   **Priority 3 (Reduce):** Retailers visited multiple times with zero OB (surfaced for frequency reduction).
*   **SKU Concentration (HHI):** Sum of squares of segment share percentages. `Sum((Segment Net / Total Net * 100)^2)`.
*   **Win-Back Logic:** Identifies customers in `secondary_register_line` (FY24-25, FY25-26) associated with the rep's `normKey` who are absent from the `Summary Report` tab of the rep's current working sheet.

### Thresholds & Color Bands
*   **Achievement:** Green >= 100%, Yellow >= 80%, Red < 80%.
*   **Cost Ratio:** Rep-specific, but generally flagged if exceeding 15% (sector dependent).
*   **Visit Gap:** Red if negative (shortfall), Green if positive (surplus capacity).
*   **Concentration (HHI):** > 2500 indicates high concentration (dependency risk).
