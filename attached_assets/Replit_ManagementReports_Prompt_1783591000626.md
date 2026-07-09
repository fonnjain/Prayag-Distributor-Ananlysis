# Replit Agent Prompt — Add "Management Reports" page (change request)

> Paste below the line into the Replit agent. Attach the 7 dashboard Excel files as **format
> reference only** — they are NOT a data source and must not be ingested at runtime.
> This modifies the existing app; do not rebuild.

---

## GOAL

Add a new page **"Management Reports"** that generates the **STATE HEAD DASHBOARD** in Excel,
**matching the format of `STATE_HEAD_DASHBOARD_2026-27_.xlsx` exactly** (that file is the
approved template; the other six are prior-year examples of the same format in use).

Hard requirements:
- **Excel download only.** No on-screen table rendering of the report is required — the page is
  a filter panel + a "Generate & Download .xlsx" button. The output is a real `.xlsx` file.
- **Data comes from the live Google Sheets** the app already reads (sale registers + order book),
  plus the new source sheets listed in "DATA SOURCES" below. Never read the attached xlsx at runtime.
- **Filters:** (a) **Statewise** — multi-select any subset of the 25 states; (b) **Region** —
  North / West / South / East (mapping below), which pre-selects the member states. Region and
  state selections combine (region expands to its states; user can then add/remove states).
- Respect the existing **10 MB-safe** reader (chunked `values.get`, no `files.export`).

---

## CRITICAL — READ BEFORE BUILDING: this report is NOT a sales report

The template is a **per-Team-Member field-force scorecard**, not a sales cut. I mapped all ~55
columns to their sources. Only about **30%** come from the sales/order data the app has today.
The rest come from systems the app does **not** yet read:

| Block | Example columns | Source | Have it? |
|---|---|---|---|
| Sales / Orders | Order Booked, Sale Report 26-27, No of Orders, Q1–Q4 | sale register + order book | **YES** |
| Targets | Primary/Secondary/Monthly Target, Business Plan, all Achievement % | Target master | **NO** |
| HR / roster | Team Member, HQ, Contact, DOJ, CTC, Left Date | HR master | **NO** |
| Field visits (SFA) | Total/Old/New/Visited Retailers, Lead Counters, Visits, Working Days, GPS KM, Avg Distance | SFA app export | **NO** |
| Expenses | T.A. Bill Cost, Cost Ratio % | Finance/expense | **NO** |

**Therefore build this in two layers and DO NOT fabricate the missing columns:**
- **Layer 1 (now):** produce the full template with every column and every State Head / Team
  Member row. Fill the sales/order/target-achievement-where-target-exists columns from live data.
  For every column whose source sheet is not yet connected, **leave the cell blank and colour it
  light grey**, and add the column name to a **"Missing Data"** tab at the end of the workbook
  (so management sees exactly what is pending, not zeros pretending to be real).
- **Layer 2 (when sources arrive):** as each new source Sheet is connected (see DATA SOURCES),
  its columns populate automatically. No format change.

> Never write 0 where the true value is "unknown". A blank + Missing-Data listing is required.
> A zero in "Total Retailers" or "Target Achievement" would misinform management.

---

## TEMPLATE STRUCTURE (reproduce these tabs, in this order)

From `STATE_HEAD_DASHBOARD_2026-27_.xlsx`:

1. **`SECONDARY ORDER BOOKING REPORT`** — per Team Member. Fixed columns then a **repeating
   monthly block** Apr→Mar, each month = `[Plan Amount, Plan Count, Order Booked Amount,
   Order Booked Count, % of Achievement, Sales Received Amount, Sales Received Count]`.
   Fixed columns (B–N): `State Head, Team Member, H.Q, Contact Number, DOJ, Week Off,
   Market Hours, Monthly CTC 25-26, Monthly Target 26-27, Total Dealer 26-27, Business Plan 26-27,
   Order Booked 26-27, Final Achievement`. Row 3 is a **TOTAL** row across all members.
   Header is a 3-row band (group / sub / Amount-Count) — replicate the merged-cell layout.
2. **`Primary Team Members 2026-27`** — roster list (HR source).
3. **`Low Performers`** — filtered view of members below an achievement threshold
   (template uses a % cutoff; make the cutoff a parameter, default < 60%).
4. **`Summary 26-27`** — per State Head roll-up. Header row is row 6; ~56 columns (full list in
   the attached gap workbook). Row 5 is a company TOTAL band.
5. **`Data`** — per Team Member flat table, header row 3, ~55 columns. This is the calculation
   base that `Summary` and `SECONDARY` roll up from.

Match column order, header text, merged cells, number formats (₹ integers, % to 1–2 dp), and the
TOTAL rows. Use the attached files to copy exact labels — do not paraphrase headers.

---

## DATA SOURCES — verified Drive file IDs (nothing to re-upload)

All IDs below were confirmed present in the connected Drive (DEEPAKJ@prayagindia.com). Share each
with the service account; read via chunked `values.get`. Put them in `config/mgmt_sources.json`.

**CONFIRMED — wire these now:**
```json
{
  "hr_roster": {
    "sheetId": "1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2",
    "name": "Team Member Details.xlsx", "grain": "team_member",
    "cols": ["Name","Mobile No.","Email Id","State","Reporting Manager","Headquarter"],
    "note": "183 reps. 'Reporting Manager' = State Head. This is the row spine of the report (1 row per TM)."
  },
  "secondary_order_booking": {
    "folderId": "1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ",
    "files_by_year": {
      "2026-27": "",  
      "2025-26": "1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80",
      "2024-25": "1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g",
      "2023-24": "1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY",
      "2022-23": "1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c"
    },
    "grain": "order_line",
    "cols": ["Date","Retailer Id","Retailer","Order ID","Segment","Cat. No.","Qty","MRP",
             "Order Value","Distributor","Discount","Order Total","Team Member Name"],
    "note": "SFA/DMS app export (SORD/RET ids). This single source feeds: Order Booking per TM, retailer census (distinct Retailer Id per TM), new-vs-old party (first-order date), Distributor/Direct-Dealer split, and Segment-wise booking. Header names drift across years (Team member vs Team Member Name, ID vs Retailer Id) — detect by content. The 2026-27 file id is blank until the current-year file is created; auto-discover it from folderId."
  },
  "group_region_index": {
    "sheetId": "1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY",
    "tab": "INDEX", "name": "SALE COMPARISON SEGMENT 2023-24 / 2024-25",
    "note": "Authoritative GROUP -> canonical TYPE map (PTMT GROUP, CP GROUP, PLUMBING GROUP, SINK GROUP, SANITARYWARE GROUP, HDPE GROUP, OTHER GROUP) plus the full State-Head list. Reuse instead of hardcoding."
  }
}
```
Also reuse the app's existing `config/sources.json`: the **sale registers** (Sale Report by State
Head), **order book** (primary plan vs booked), and **rate list** (segment/MRP lookup).

**PARTIAL — data exists in Drive but scattered; consolidate or pick one canonical sheet:**
```json
{
  "target_master": {
    "candidates": {
      "state_head_wise_plan": "10LCcpyJc-jYCuAm4WUCG5sM5f-XgGxY7",
      "per_head_example_rizvi": "1fRLiVjON-PMEzgp4FhAeCe5MWfO7C5CPSH11j94t7OY",
      "per_tm_example_arjun":  "1YrKDauAqroKx3HcOempMBUgZ-FC_Pq28XEW1HoN6r0c"
    },
    "cols": ["Primary Target","Secondary Target","Direct Dealer Target","Business Plan"],
    "note": "Targets live in many per-head / per-TM plan sheets, not one master. Until a single Target Master exists, all 'Achievement %' columns render blank + go to Missing Data. RECOMMEND: one tab 'Target Master' keyed by Team Member + Month."
  },
  "field_tour_plan": {
    "sheetId": "12F2TaCqn1q6E3OpbbevAqEMccptv6PfZR0IqExXJy4o",
    "name": "VISIT REPORT 2026-27",
    "note": "This is a weekly tentative TOUR PLAN, not visit metrics. Use for planned coverage only; do NOT treat as actual visits/working-days."
  }
}
```

**NOT IN DRIVE — render blank + list in the Missing Data tab (do not fabricate):**
- SFA visit metrics (Total/Lead/Non-Lead Visits, Working Days, Avg Visit/Day, Business-Received Visits)
- GPS KM / Avg Distance
- CTC / payroll (the HR roster has no CTC column)
- T.A. Bill Cost / Cost Ratio % (also 0% filled in the template today)

**Join model.** Spine = `hr_roster` (1 row per Team Member). Left-join `secondary_order_booking`
on **Team Member Name** (normalise casing/spelling), aggregate to per-TM and roll up to State Head
via `Reporting Manager`. This means the **retailer↔TM link already exists inside the order-booking
file** — no separate mapping sheet is needed. Register `Sale Report` attaches at **State Head**
grain (registers carry STATE HEAD, not Team Member), so per-TM *dispatched sale* stays blank unless
a retailer→TM bridge is later supplied; per-TM *order booking* is fully available now.

---

## STATE → REGION MAP (for the Region filter)

```json
{
  "North": ["Delhi","Delhi NCR","Haryana","Punjab","Himachal Pradesh","JAMMU AND KASHMIR",
            "Uttarakhand","West U.P","East U.P","Rajasthan"],
  "West":  ["Gujarat","Maharashtra","Maharashtra 2","Madhya Pradesh","Chattisgarh"],
  "South": ["Andhra Pradesh","Telangana","Karnataka","Kerala","Tamil Nadu"],
  "East":  ["Bihar","Jharkhand","Odisha","West Bengal","North East"]
}
```
Put this in `config/region_map.json`. Flag for the client to confirm: Rajasthan (N vs W),
MP & Chattisgarh (W vs Central). The state filter must accept the register's dirty variants
(`W-BENGAL`, `MAHARASTRA L`, `UP ( R )`) via the existing normalisation before matching regions.
For the **GROUP→canonical-segment** map, do not hardcode — read the **INDEX** tab of
`1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY` (SALE COMPARISON), which is the company's own
authoritative mapping and already covers all 30 group values. (No confirmed N/S/E/W master file
exists in Drive, so the region map above stays a config file until the client confirms it.)

---

## PAGE UX

- Route `/management-reports`. Left: filter panel — Region chips (N/W/S/E, multi), State
  multi-select (searchable), FY selector (default 2026-27), optional month range, Low-Performer
  threshold. Right: a short "what's included / what's pending" note driven by which source Sheets
  are connected.
- Primary action: **"Generate & Download Excel"** → server builds the `.xlsx` with `exceljs`
  (streaming write) honouring the filters, returns it as a download. Filename:
  `StateHeadDashboard_<FY>_<scope>_<yyyymmdd>.xlsx`.
- The generated file always includes the **Missing Data** tab listing every column left blank and
  the source Sheet that would fill it.
- Build server-side; stream the workbook; keep peak memory < 512 MB; do not hold all rows in RAM.

---

## ENDPOINTS
- `GET /api/mgmt/options` → states, regions, connected-sources status.
- `POST /api/mgmt/report` `{ fy, states[], regions[], monthFrom, monthTo, lowPerfPct }` →
  streams the `.xlsx`.

---

## ACCEPTANCE
- [ ] Output opens in Excel and visually matches `STATE_HEAD_DASHBOARD_2026-27_.xlsx` tab-for-tab,
      header-for-header (same labels, merged header band, TOTAL rows, monthly Apr→Mar blocks).
- [ ] Report spine = 183 team members from `hr_roster` (1Nb8g…), each rolled to its State Head via
      `Reporting Manager`.
- [ ] Order-booking, retailer census, new/old split, dealer flag, and segment all populate from the
      `secondary_order_booking` files (1aNQ2…, etc.) for the selected scope and FY.
- [ ] Segment→canonical group uses the live INDEX tab (1g-4_…), not a hardcoded map.
- [ ] Region filter expands to states; statewise multi-select works; dirty state variants match.
- [ ] Every not-in-Drive column (SFA visits, GPS, CTC, T.A.) is **blank + grey**, never 0, and is
      listed in the Missing Data tab.
- [ ] No `files.export`; xlsx generated by streaming; the reference dashboards are never read at runtime.
- [ ] Dropping in a consolidated `target_master` Sheet later fills all Achievement-% columns with no
      code change.

## WHAT NOT TO DO
- Do not render zeros for unknown field-force/target/HR values.
- Do not ingest the attached example workbooks as data.
- Do not drop any template column even when its source is missing — keep it, blank it, list it.
- Do not read whole sheets/files into memory.
```
