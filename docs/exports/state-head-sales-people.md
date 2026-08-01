## GLOSSARY

*   **Primary Sales (Dispatched):** Revenue from goods invoiced by Prayag to Distributors. Tracked daily via SAP register chain (API `sale_line`).
*   **Primary Order Booking:** Committed orders from Distributors to Prayag. Sourced from the "Order Sheet" (FY26-27).
*   **Secondary Sales (Received):** The salesperson-attributed portion of primary sales. Salespeople take orders from retailers and give them to distributors. Tracked monthly via the authoritative **STATE HEAD DASHBOARD** Google Sheet.
*   **Secondary Order Booked (OB):** Orders taken by salespeople from retailers. Recorded in the State Head Dashboard.
*   **Plan / Target Secondary:** Monthly/Annual sales targets for salespeople. Primary source is the "Plan" column in the State Head Dashboard; fallback is the "Target Master" sheet.
*   **Achievement %:** Defined as **Sales Received ÷ Plan**. Note: The raw Google Sheet often calculates this as *OB ÷ Plan*, which the app explicitly ignores/recomputes.
*   **Coverage:** The ratio of Secondary Sales to Primary Sales (**Secondary ÷ Primary**). Indicates the share of business directly driven by the sales team.
*   **Coverage Gap:** The absolute difference (**Primary Sales - Secondary Sales**). Represents business arriving without direct salesperson touch (e.g., direct distributor reorders).
*   **Like-Months:** An "apples-to-apples" comparison filter that restricts Primary Sales to the same set of calendar months for which Secondary Sales (recorded only at month-end) are available.
*   **Sales-Lag (Not Yet Recorded):** A status for calendar-closed months where Secondary OB is entered but Sales Received is zero. This signals a data-entry delay rather than zero performance.
*   **Anomaly:** A per-member, per-month flag triggered when **Sales Received > (Ordered Amount × 1.5)**. Such values are displayed but excluded from rankings.

## CALCULATIONS & LOGIC

### 1. Achievement Formulas
*   **Monthly Achievement:** `Secondary Sales Received (Month) ÷ Secondary Plan (Month)`.
*   **YTD Achievement:** `Σ(Secondary Sales Received) ÷ Σ(Secondary Plan)` for **closed months only**.
*   **In-Progress Handling:** Current open months or "Sales-Lag" months (closed with OB > 0 but Sales = 0) are excluded from the achievement denominator to avoid understating performance.

### 2. Primary vs. Secondary Relationship
*   **Logic:** `Secondary ⊂ Primary`. They are part of the same transaction flow, not separate revenue streams.
*   **Prohibition:** Never sum Primary and Secondary figures (double-counting).
*   **Coverage Calculation:** `Secondary Sales (Closed Months) ÷ Primary Sales (Same Closed Months)`.

### 3. Target Splitting & Seasonality
*   **Annual to Period:** Annual targets from Target Master or DB are split using seasonal weights derived from FY2025-26 actuals.
*   **Formulas:**
    *   `Period Target = Σ(Monthly Overrides)` if provided.
    *   `Period Target = Annual Target × Σ(Seasonal Month Weights)` if no overrides.

### 4. Data Sources & Filters
*   **Secondary Data:** Google Sheet `1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM` (FY26-27), tab `SECONDARY ORDER BOOKING REPORT`.
*   **Primary Data:** `sale_line` table (Backend DB) and `Order Sheet` (FY26-27).
*   **Identity Resolution:** `normSecKey` (lowercase alphanumeric, keeps parentheticals) for unique database keys; `normName` (strips parentheticals) for roster/HR joins.
*   **Low Performer Logic:** Achievement < 50% (default) or < 25% (selectable). Excludes "Primary-role" members and "Left" members.

### 5. Color Bands & Thresholds
*   **>100%:** Emerald (above100)
*   **90-100%:** Green (90to100)
*   **70-90%:** Yellow (70to90)
*   **50-70%:** Amber (50to70)
*   **25-50%:** Orange (below50)
*   **<25%:** Red (below25)
*   **No Target:** Muted (noTarget) - applied when plan is null or 0.