## Distributor Deep Dive Glossary

### General & D1 (Retailer Lists)
*   **Direct Dealer**: A retailer classified as a parallel branch in the supply chain, operating without a parent distributor. Distinguished by a blank 'Assigned Distributor' field in member working sheets.
*   **Shared Distributor**: A retailer relationship where multiple distributors are assigned (comma-separated in the source). Modeled as a distinct relation.
*   **None-Assigned (Mapping Problem)**: Retailers with '--', '-', '—', or '–' in the distributor field. Indicates a failure to map the retailer to a supply route.
*   **NormKey**: A stable grouping key (e.g., 'TRADERS' → 'TRADE') used to join member sheets and primary sales data.
*   **Confirmed vs. Guessed**: Quality split for distributor totals based on name matching confidence.
*   **Unassigned Correlation**: Pearson r correlation between a member's % of unassigned retailers and their achievement total.

### D2 Flows (Primary vs. Secondary)
*   **Primary In-Flow**: Goods Prayag sells to the distributor. Source: `sale_line` table (Net Amount).
*   **Secondary Out-Flow**: Goods the distributor sells to retailers. Source: `member_sheets` (Order Booking) or `secondary_register_line` for closed years.
*   **Flow Gap**: Primary Dispatch minus Secondary Out. A positive gap suggests stock building or outside-channel sales.
*   **Primary OB**: Sum of `primary_order_line.taxable_value`, excluding 'Govt' channel institutional orders.
*   **Pending Value**: Primary OB minus Primary Dispatch.
*   **Fill Rate**: Primary Dispatch / Primary OB × 100.
*   **YoY Growth**: Comparison of primary dispatch in closed months of the current FY vs. the same calendar months in the prior FY.

### D3 SKU Spread
*   **Brand Canon**: The finest product granularity (e.g., "CPVC DURALIFE").
*   **Broad Segment**: One of 17 high-level categories (e.g., "WATER TANK", "CPVC").
*   **Concentration HHI**: Herfindahl-Hirschman Index (0–10000) measuring brand diversity.
*   **Cross-Sell Depth**: Average number of distinct brand canons sold per retailer.
*   **Range Depth Whitespace**: Brands sold by peers in segments this distributor already operates in, but does not yet stock.
*   **Lost Brand Whitespace**: Brands sold in the prior FY but absent in the current recent FY.
*   **Peer Whitespace**: Brands sold by peers (same State Head) that this distributor does not sell.

### D4 Investment, ROI & Tiering
*   **Effective Discount**: Weighted average calculated as `(1 - netTotal / grossTotal) * 100`.
*   **Anomalous Discount**: Lines where `discount_pct > 100`. These are excluded from weighted averages but flagged.
*   **Cost to Serve**: `Distributor Visits * Member Cost Per Visit`.
*   **Net-to-Cost Multiple**: `Secondary Net Revenue / Visit Cost to Serve`.
*   **Tier (A/B/C)**: Composite score (0-100) based on Net (30pts), Growth (25pts), Active Ratio (25pts), and Discount (20pts).
*   **Visit Cadence**: Recommended frequency (A=Weekly, B=Fortnightly, C=Monthly).

### D5 Whitespace & D7 Capacity
*   **Coverage Gap**: District has retailers but NO distributor. Fix: Strategic appointment.
*   **Assignment Gap**: District has a distributor but some retailers are unassigned. Fix: Admin mapping.
*   **Channel Conflict**: Presence of Direct Dealers in a district that has a named Distributor.
*   **Capacity Shortfall**: When `Demanded Visits > Available Visits` per month in a territory.

---

## Calculations & Logic

### D1: Retailer Aggregation
*   **Groupings**: Retailers are grouped by `normDistKey(Assigned_Distributor)`.
*   **Direct Dealer Logic**: If field is empty → `directDealer`. If field is `--`/- → `noneAssigned`.
*   **Normalization**: `.toUpperCase()`, replace `TRADERS` → `TRADE`, `ENTERPRISES` → `ENTERPRISE`, remove non-alphanumeric, collapse spaces.

### D2: Flow Calculations
*   **Primary Dispatch**: `SUM(sale_line.amount)` where `version_status='current'`.
*   **Secondary Out**: `SUM(RetailerRow.orderBooking)` from working sheets.
*   **Days Since Last Order**: `Today - MAX(sale_line.invoiceDate)`.
*   **Growth %**: `((Current Closed Months Dispatch - Prior Year Same Months Dispatch) / Prior) * 100`.

### D3: SKU Spread & Whitespace
*   **HHI**: `SUM((brand_net / total_net * 100)^2)`.
*   **Broad Segment Mapping**: Keyword-based lookup (e.g., "TANK" → "WATER TANK").
*   **Whitespace Ranking**: `range_depth` (0) > `lost_brand` (1) > `peer_whitespace` (2). Within types, sorted by `peerNet` descending.

### D4: Investment & Tiering
*   **Effective Discount**: `SUM(net_clean) / SUM(gross_total)`. `net_clean` uses `net_amount` if `discount_pct <= 100`, else `gross_amount`.
*   **Tier Scoring Rules**:
    *   **Net**: Top 40% (30), Mid (18), Bottom (8), None (8).
    *   **Growth**: >5% (25), 0-5% (18), -10-0% (10), <-10% (5).
    *   **Active Ratio**: >60% (25), 40-60% (18), <40% (8).
    *   **Discount**: <40% (20), 40-50% (12), >50% (5).
*   **Tier Thresholds**: A (>=70), B (45-69), C (<45).

### D6: Customer Concentration
*   **Retained**: `This Year OB > 0` AND `Last Year Sale > 0`.
*   **Reactivated**: `This Year OB > 0` AND `Last Year Sale = 0`.
*   **At Risk**: `This Year OB = 0` AND `Last Year Sale > 0`.
*   **Never**: `This Year OB = 0` AND `Last Year Sale = 0`.

### D7: Capacity Check
*   **Demanded Per Month**: `SUM(DistributorTier.cadenceRetailerPerMonth)` where `cadenceRetailerPerMonth = activeCount * TierRate`.
*   **Tier Rates**: A (2.0/mo), B (1.0/mo), C (0.5/mo).
*   **Available Per Month**: `Total YTD Member Visits / Months Elapsed`.
*   **Shortfall**: `Demanded - Available` (if > 0).