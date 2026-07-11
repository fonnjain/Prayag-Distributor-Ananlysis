# Replit Agent Prompt — "Sales" page with per-salesperson Reports (Excel-downloadable)

> Paste below the line. Promote Sales People to its own top-level **Sales** page, and add a **Reports**
> view that replicates the State-Head report tabs (from `Sunil Patel 2026-27`) **per salesperson**,
> downloadable as one Excel workbook. Don't disturb other dashboards.

---

## 1. Make "Sales" a separate top-level page

Rename/promote the current Sales People page to **Sales** (top-level nav). Keep the existing person
picker + reporting tree (State Head → salespeople, shallow second tier, Own vs Team). Add a sub-nav
inside Sales: **Overview** (current tiles/movers) and **Reports** (new, below).

## 2. Reports view — replicate these 9 tabs, PER SALESPERSON

Mirror the layouts management already knows from the State-Head workbooks (verified in
`Sunil Patel 2026-27`). Every report is **FY-vs-FY (2025-26 vs 2026-27)** with **Difference,
Growth %, Share %**, but scoped to the selected **salesperson** (not the head):

| Report | Layout |
|---|---|
| **Report 1** | Sale by **State** (left block) and by **Party** (right block), FY-vs-FY + growth + share |
| **Report 2** | **Growth of sale**: State totals + **month-by-month** columns (Apr, May, …), each with growth % |
| **Report 3** | **Group-wise** (PTMT, CISTERN, CP, …) overall — growth & share, with a Grand Total row |
| **Report 3A** | Report 3 **filtered by State** (State selector) |
| **Report 3B** | **Party → Segment**: pick State + Party → their segments, FY-vs-FY |
| **Report 3C** | **Segment-wise for a selected State** (all parties) |
| **Report 4** | Deep drill **State → Party → Segment → Item Code**, FY-vs-FY |
| **Report 7** | **Party × Group matrix**: rows = station/party, cols = PTMT/PLUMBING/WATER TANK/CP/SINK group sale |
| **Sale & Collection** | Monthly **Sale (with GST)** vs **Collection** |

Match the column order, headers, Grand-Total rows, %/₹ formats, and the State/Party/Segment selectors
of the originals so it reads identically to what management signs off.

## 3. Data basis — TOGGLE (Secondary default, Primary where the bridge resolves)

Add a **Secondary / Primary** toggle on the Reports view:

- **Secondary (default)** — from Secondary Order Booking (net Sub Total), joined on **Team Member
  Name**. This is consistent with the rest of the Sales page. Segment/party/state come from the
  order lines; group via the INDEX map.
- **Primary** — from the primary sale register, attributed to the salesperson via the
  **Party → Salesperson bridge** (`Party TM Map`). Use only rows the bridge resolves; show a coverage
  note ("Primary shown for X% of this rep's parties; Y parties unbridged"). This matches the
  State-Head report numbers where the bridge is complete.
- The toggle only swaps the data source; the report layouts are identical. Label each report/workbook
  with the basis used ("Basis: Secondary (net)" / "Basis: Primary (dispatch)").
- Never silently mix bases in one number. If Primary is chosen and the bridge doesn't cover a party,
  that party is listed as unbridged — not dropped, not filled from secondary.

## 4. FY coverage
Secondary exists **up to FY2025-26** only; the FY25-26-vs-FY26-27 comparison on **Secondary** fills
when the 26-27 secondary file appears. **Primary** has FY26-27 (SAP register) — so a rep's FY-vs-FY on
Primary works now where the bridge resolves. Make each report state its period + basis clearly.

## 5. Excel download — ONE workbook per person (like the State Head file)

A **"Download Excel"** button builds a single `.xlsx` for the selected salesperson containing **all 9
report tabs** in the same order and layout as the State-Head workbook, generated server-side with
`exceljs` (stream). Filename: `SalesReports_<Person>_<FY>_<basis>_<yyyymmdd>.xlsx`. Include a cover
tab: person, State Head, period, basis, coverage %, generated-at. Number formats and Grand-Total rows
must match the on-screen reports.

## 6. Claude (already on this page)
Keep the **Explain** (per-rep narrative) and head-level **compare** actions. When Reports are open,
let Explain reference the report breakdowns (top movers by segment/party/state) — grounded in the
displayed numbers, on the selected basis.

## 7. Verification
Reuse the Sales verify: Σ(reps under a head) = head total; head rollup reconciles to anchors
(Secondary FY25-26 ≈ ₹240 Cr; Sandeep ≈ ₹157 Cr…). For Primary basis, Σ(bridged rep sale) ≤ head
register total, with the unbridged remainder reported. Name match > 95%.

## ACCEPTANCE
- [ ] "Sales" is a top-level page; Reports sub-view renders all 9 report layouts per salesperson.
- [ ] Report layouts match the State-Head originals (columns, totals, selectors, formats).
- [ ] Secondary/Primary toggle works; each report labels its basis; Primary shows bridge coverage;
      no cross-basis mixing.
- [ ] "Download Excel" produces one workbook with all 9 tabs for the selected person.
- [ ] Reports reconcile (Secondary to anchors; Primary to bridged register share).
- [ ] Other dashboards untouched; no `files.export`; chunked reads.

## WHAT NOT TO DO
- Do not mix Secondary and Primary within a single figure or report.
- Do not drop unbridged parties on Primary basis — list them.
- Do not change the report layouts management already knows; replicate them faithfully.
