# Prayag Management Report — How It's Actually Built (data-flow recipe)

*Reverse-engineered from `CRM_Working_Sheets` (the process map), the live State-Head workbook
`Anant Singh JI 2026-27`, and the Secondary Order Booking + roster sources. This is the recipe the
Replit engine must follow. It is why the engine's first output was ~90% empty: it wired only the
roster and skipped every other source.*

---

## 1. The report is built PER TEAM MEMBER, then rolled up

Hierarchy: **Company → 12 State Heads → ~180 Team Members**. The report's calculation base is the
**Data** tab (1 row per team member). `Summary` rolls Data up to State Head; `SECONDARY ORDER
BOOKING REPORT`, `Primary Team Members`, and `Low Performers` are re-cuts of the same per-member base.

The CRM process map spells out the pipeline per State Head (example: Anant Singh):

```
State Head workbook           per-member working file        report tabs
"Anant Singh JI 2026-27"  →   "Copy of Tarun Giri"       →   STATE HEAD DASHBOARD (2026-27)
(dispatched-sale register     ├ PLAN 26-27  (targets)        ├ SECONDARY ORDER BOOKING REPORT
 filtered to this head)       ├ Sale Report 26-27            ├ Primary Team Members
                              ├ <NAME> - 2026-27  (summary)  ├ Low Performers
Secondary Order Booking   →   └ <NAME> - SUMMARY 25-26       ├ Summary 26-27
(SFA app, per-member order)                                  └ Data      →  FINAL FOLDER:
Team Member Details (roster)                                              "STATE HEAD (Team Member Report)"
```

## 2. The four real sources (all live Google Sheets)

| Source | What it is | Grain | Feeds |
|---|---|---|---|
| **State-Head workbook** e.g. `Anant Singh JI 2026-27` (`1G3z_gOk5JR8yFmcVCadFCgpltjY1y0pI4ZBmGwrF2pU`) | the dispatched-**sale register** filtered to one head; 2 fiscal years; cols = Invoice, Date, **Customer(party)**, Code, Month, Qty, Rate, **Amount**, Group, Station, State, **State Head**, Type(group bucket), FY | invoice line | Sale Report, by-group, by-month |
| **Secondary Order Booking Segment Wise** (`1aNQ2Tcz…`, per year, one folder) | SFA/DMS app **order** export; cols = Date, **Retailer Id**, Segment, Cat No, Qty, Order Value, Distributor, **Team Member Name** | order line (per **retailer**, per **team member**) | Order Booking, retailer census, new/old party, segment |
| **Per-member working file** e.g. `Copy of Tarun Giri` | member's **Plan/Target** + their **Sale Report** (their owned parties) | per member | Targets, and the **party→member ownership** |
| **Team Member Details** (`1Nb8gRcdzY…`) | roster: Name, State, **Reporting Manager (=State Head)**, HQ | per member | identity/spine (12 heads, ~180 members) |

## 3. The join problem that makes or breaks the report

Two different grains must both attach to a **team member**:

- **Order Booking** already carries `Team Member Name` → attaches directly. ✅ Easy.
- **Dispatched Sale** (the State-Head workbook / register) is tagged only to **State Head** and to a
  **Customer/party** (a distributor, e.g. `LOHIA & SONS`, `MANOJ ENTERPRISES`), **not** to a team
  member. To put each member's *Sale Report* on their row, you need a **Party → Team Member map**.

Today that map is implicit: each member's working file manually lists the parties they own. To
**automate** this in the app (instead of maintaining ~180 hand-built member sheets), Prayag needs
**one consolidated bridge sheet**:

```
Party (Customer name / code) | Team Member | State Head
```
This is the single most important artifact to create. With it, register sales split cleanly to
members; without it, the app can only fill Sale columns at **State-Head** grain and per-member Sale
stays blank. (Order columns still work per member from the Secondary Order Booking.)

> Note the grain mismatch: register `Customer` = **distributor** (primary sale); Secondary Order
> Booking `Retailer` = **retailer** (secondary/onward). The bridge must therefore map the
> **distributor/party** in the register to the owning team member — not the retailer.

## 4. Column → source map (the essential rows)

**From the State-Head workbook (register), per member via the Party→TM bridge:**
`Sale Report 26-27` = Σ Amount · `by group / segment` split · `Q1–Q4` from Date · prior-year `Sale
25-26` from the FY-2025-26 block in the same file.

**From Secondary Order Booking, per member (Team Member Name):**
`Order Booked` (Σ Order Value) + monthly split · `No of Orders` (distinct Order ID) · `Total /
New / Old Retailers` (distinct Retailer Id; new = first-ever order in this FY) · `Old/New Party
Order Booking` · `Business Achieved By (No. of) Old/New Parties` · `Business Per Retailer` ·
`Direct Dealer` split (via Distributor/dealer flag).

**From per-member working file (or one consolidated Target Master):**
`Primary Target`, `Secondary Target`, `Monthly Target`, `Business Plan` → and every `Achievement %`
= actual ÷ target.

**From roster:** `State Head`, `Name`, `State/Working State`, `HQ`, `DOJ`, `Active/Left`.

**Not in any Sheet (leave blank + list in Missing Data):** SFA visit metrics (visits, working days,
lead counters, GPS km, avg distance), `CTC`, `T.A. Bill / Cost Ratio`.

## 5. Verified anchor — Anant Singh, FY2026-27 (from the live register)

Use these to validate the build (State-Head totals, before per-member split):

| Metric | Value |
|---|---|
| Dispatched Sale (Apr–Jul, Jul partial) | **₹2.57 Cr** |
| Invoices / distinct parties | 245 / **29** |
| Apr / May / Jun / Jul | ₹0.07 / 1.30 / 1.18 / 0.02 Cr |
| Top groups | PTMT ₹0.68 Cr · CPVC ₹0.55 · Garden Pipe ₹0.21 · Sanitaryware ₹0.19 · UPVC ₹0.19 |
| Top parties | NITIN TRADERS ₹0.30 · Vidhya Sales ₹0.25 · LOHIA & SONS ₹0.25 · AVANTI ₹0.23 |
| States covered | Delhi, Delhi NCR, UP (rural), Uttarakhand |

The sum of Anant Singh's team members' Sale Report on the Data tab **must reconcile to ₹2.57 Cr**.
That single cross-foot is the acceptance test for the Party→TM bridge.

## 6. Why the engine's first run was empty — and the fix order

The engine filled only roster identity columns. To fill the rest, wire sources in this order:
1. **State-Head workbooks** (per-head registers) → Sale side at State-Head grain (works immediately).
2. **Secondary Order Booking** → all order/retailer columns per member (works immediately).
3. **Party→TM bridge** (new consolidated sheet) → splits Sale side to members.
4. **Target Master** (consolidated) → all Achievement %.
5. Leave SFA/CTC/T.A. blank + listed.

Steps 1–2 alone move the report from ~10% to ~60% filled with no new artifacts from the user.
