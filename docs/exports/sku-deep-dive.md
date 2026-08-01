## SKU DEEP DIVE GLOSSARY

### K1: Catalogue & Facts
- **Segment**: Highest-level SKU grouping. Derived from `group_canon` (curated) or `group_raw` (ERP) from `sale_line_current`. "Unmapped" if both are null.
- **Item Code / SKU**: The unique product identifier.
- **Net Value**: Primary sales metric (`amount`) after returns/discounts.
- **SKU Breadth**: Count of distinct item codes bought by a customer in a period.
- **Segment Breadth**: Count of distinct segments bought by a customer.
- **Ever Sold**: Denominator for segment penetration; count of unique SKUs within a segment sold to any customer in the selected FY.

### K3: Review + Push Lists
- **Peer Cohort**: A group of distributors in the same Net Value quintile.
- **Quintile**: Distributors ranked by total Net Value in FY2025-26 (`COHORT_FY`). 1 = Top 20%, 5 = Bottom 20%.
- **State Cohort**: Peers within the same `state_canon` (normalised to handle splits like "DELHI A" and "DELHI NCR").
- **National Cohort**: Fallback used if a state has <8 distributors.
- **Peer Count (Signal)**: Number of cohort peers buying a specific SKU that the target distributor does not buy.
- **Recommendation Tiers**: 
  - **Tier 1 (Range)**: Filling a gap in an `item_group` the distributor already buys.
  - **Tier 2 (Lapsed)**: SKU bought in `COHORT_FY` but not in the current period.
  - **Tier 3 (Active)**: SKU in a segment where the distributor is currently active.
  - **Tier 4 (New)**: SKU in a segment where the distributor has zero current purchases.

### K4: Discounts & Trends
- **Primary MRP Discount**: `1 - (Net / (MRP * Qty))`. Calculated per row using `item_master.mrp`.
- **Secondary Register Discount**: The `discount_pct` column from `secondary_sku_line` (retailer level).
- **Norm Discount**: The average territory-wide discount for a SKU across closed FYs (23-24, 24-25, 25-26).
- **Above-Norm Flag**: Highlighted if a SKU's current period discount is ≥5 percentage points higher than its `Norm Discount`.
- **First Order**: A SKU purchase where the (Customer, Code) pair has no history in any prior FY.
- **Lost Code**: A SKU bought by an active customer in the prior FY but missing in the current FY.
- **Breadth Narrower**: A customer whose distinct SKU count has dropped vs the prior FY.

---

## CALCULATIONS & LOGIC

### 1. Peer Cohort Logic (K3)
- **Membership**: Peers = Same Quintile ± 1 (e.g., Quintile 2 sees peers in Q1, Q2, Q3).
- **Territory Only**: Project/Govt entities (identified via `head_canon = 'Non-territory / Project / Govt'`) are strictly excluded from cohorts.
- **Min Thresholds**: Minimum 3 peers must buy a code for it to appear on the Push List.
- **Season-Aware Banding**: Peer Net and Peer Count signals are filtered by the specific fiscal months selected in the UI (e.g., if Apr-Jun is selected, signals only reflect Apr-Jun peer activity).

### 2. Discount Logic (K4)
- **MRP Discount Formula**: `sum(disc * net) / sum(net)` where `disc = 1 - (net / (mrp * qty))`.
- **Secondary Reconciliation (Population Gate)**: The Secondary Register Discount is only shown if ≥99% of lines in the source sheet satisfy: `abs(gross * (1 - disc_pct/100) - net) < 1`. If failed, the measure is blocked.
- **Project Exclusion**: A "Customer Bridge" is used for FYs without `head_canon` data. Customers ever attributed to the project channel in any attributed FY (23-24, 26-27) are excluded from "Territory" views.

### 3. Seasonality & Trends
- **Seasonality Basis**: Computed over All Channels (Project + Territory) using pooled data from closed FYs.
- **Consistency**: A segment is marked "Consistent" if the Peak Month is the same across all 3 closed FYs.
- **Breadth Trend**: `Dropped Value` = sum of prior-FY net for codes NOT bought in the current FY by a customer who is still active.

### 4. Blocked Measures
- **Margin per Code**: Blocked if `cost_master` is empty or unverified. MRP discount is explicitly NOT treated as margin.
- **Live Year Retailer**: Secondary SKU facts are blocked for FY2026-27 as register data is not yet backfilled.