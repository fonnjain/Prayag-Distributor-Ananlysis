# Replit Agent Prompt — State Head Dashboard (FY2026-27): live view + Excel export

> Paste below the line. Build the dashboard management already knows (`STATE HEAD DASHBOARD 2026-27`)
> as a **live page** in the app **and** as a **downloadable Excel** in the same layout. Live Google
> Sheets are the source. Do not disturb the other dashboards.

---

## 1. WHAT TO BUILD

A page **State Head Dashboard** with a FY selector (default 2026-27) and 5 views, mirroring the file
management uses:

| View | Content |
|---|---|
| **Data** | one row per team member (183 in FY26-27): identity, targets, order booking, achievement %, band, sale, retailers, visits, working days, CTC |
| **Low Performers** | members below the achievement threshold (see §3) — **threshold configurable** |
| **Summary by Head** | per State Head: members, target, order booking, achievement %, sale, retailers, # low performers, # no-target |
| **Secondary Order Booking Report** | members on Secondary basis with their order metrics |
| **Primary Team Members** | members on Primary basis (distributor/direct-dealer counts) |

Plus a **"Download Excel"** button producing one workbook with these tabs in the same layout
(server-side `exceljs`, streamed).

## 2. SOURCE MAP — where each column comes from (all live Sheets, chunked `values.get`, no `files.export`)

| Column group | Source | File ID |
|---|---|---|
| State Head, State, Name, HQ, D.O.J, Working State, hierarchy | **Team Member Details** (roster; `Reporting Manager` = head) | `1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2` |
| Primary / Secondary / Direct-Dealer / Monthly **targets** | **Prayag Target Master** | `1ZLok3_8AZHdfrUm4T2lJmonAjngQFz4TuNLkHtU3p2I` |
| **Sale Report 26-27** (primary dispatch) | **Order Sheet 26-27** — cols: Date, Document No., Location.Name, Customer.Name, GROUP, Old ERP Code, Qty, Rate, **Taxable Value**, Month, STATION, STATE, **STATE HEAD**, group bucket, channel(Retail/Govt) | `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A` |
| same, 2-yr combined (fallback/history) | State Head Sale 2026-27 / 2025-26 | `1QIpcfgO…` / `1RuXHIXf…` |
| **Order Booking**, Old/New party, Business Achieved By, No. of Orders | **Secondary Order Booking** (join on `Team Member Name`) | `1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80` (25-26) — **see §5** |
| GROUP / product classification | rate list **Sheet1** (Item Code → Item Group) | `1njO-srsS29qiE4t45-zr5njbB7R2Zb-oSnv2NL1ONY4` |
| STATE HEAD / STATE / channel per customer | rate list **Sheet2** (Customer → head) | same |
| Collection (Sale & Collection) | PARTY O/S & PAYMENT 26-27 | `1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok` |
| **Retailers** (Total/Old/New/Visited/Non-visited), **Visits, Working Days, Working Hours, GPS KM, Avg Distance**, **CTC, Designation, Emp Code, Active/Left** | **STATE HEAD DASHBOARD 2026-27** `Data` tab (header row **3**) — client is adding it to Drive | *(config `hr_sfa_dashboard.sheetId` — read live once present)* |
| T.A. Bill ST. Cost | no source | leave blank + Missing Data |

Apply the existing **head-name normalisation** (`BIJJU→Biju C.O`, `RIZVI JI→Syed Aqil Rizvi`,
`PAWAN KUMAR→Pawan Sharma`…) on every source; bucket `OTHER/PROJECT/GOVT/GEM/JJM` as
**Non-territory**, never a person.

## 3. ACHIEVEMENT + LOW-PERFORMER LOGIC (verified — follow exactly)

- **Achievement % = Order Booking ÷ Secondary Target.** (Verified: reproduces the dashboard's own
  percentages, e.g. Sujan Ghata 57.1%, Surojit Mondal 23.8%.)
- **⚠️ TARGETS ARE QUARTERLY (Q1: Apr–Jun), NOT ANNUAL.** Verified: `Total target ÷ Target monthly =
  3.0` for 126 of 133 members. Compute achievement against **Σ target months in the selected period**.
  Treating them as annual makes every % ~4× wrong. In the Target Master, FY26-27 rows carry
  `*_m_Apr/May/Jun` with `*_annual` **blank** — that is a valid target, **not** "No Target".
- **Bands:** `Below 25%` · `Below 50%` (25–50) · `50%-70%` · `70%-90%` · `90%-100%` · `Above 100%` ·
  `No Target`.
- **Low Performers = Achievement < 50%**, with a **Below 25%** sub-band highlighted.
  Make the threshold **configurable** (default 50%; also expose 25%).
  Members with **no target** show `No Target` — never `0%`, and are excluded from the low-performer list.

> **Known discrepancy — surface it, don't fake it.** The client's file lists **26** low performers,
> but applying the stated rule (<50%) to all 183 members yields **64**. All 26 are also `Old` +
> `Secondary`, yet 33 other members meet those same conditions and are not listed; CTC, target size,
> tenure, retailers, orders, visits and sale all overlap between the two groups, so **no deterministic
> rule exists in the data** — the 26-row list appears manually curated or snapshot-based. Implement the
> **stated rule** and show the count; add a note in the UI that the source file's list differs. Do not
> invent a filter to force the count to 26.

## 4. UI
- FY selector; State-Head filter; search by name.
- **Data** grid (sortable, band colour-coded: red <50%, green ≥90%, grey No Target).
- **Low Performers** view with the threshold control + band chips + counts.
- **Summary by Head** with achievement %, low-performer count, no-target count.
- KPI tiles: total secondary target, total order booking, company achievement %, members, low performers.
- "Download Excel" → workbook with the same 5 tabs.

## 5. THE ONE BLOCKER — handle gracefully
**Order Booking is the numerator of every achievement %, and it comes from Secondary Order Booking —
which has NO FY2026-27 file** (folder `1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ` holds only 23-24, 24-25,
25-26). So:
- Auto-discover the FY26-27 secondary file from that folder; the moment it exists, the page fills.
- Until then: render identity + targets + Sale Report (from Order Sheet 26-27), show Order Booking /
  Achievement as **"pending — FY2026-27 Secondary Order Booking not yet created"**, and list it in
  Missing Data. **Do NOT substitute primary/register sales into the Order Booking column** (different
  metric — that's the ₹73 Cr vs ₹240 Cr confusion).
- FY2025-26 works fully today — make it selectable so the page is usable now.

## 6. ACCEPTANCE
- [ ] Page renders Data / Low Performers / Summary / Secondary / Primary views + Excel download.
- [ ] Achievement computed vs **Σ target months in period** (quarterly-safe), not annual.
- [ ] FY2025-26 reconciles to the approved anchors (total ≈ ₹240 Cr; Sandeep ≈ ₹157 Cr; 240 members).
- [ ] Low-performer threshold configurable; Below-25% band shown; `No Target` never rendered as 0%.
- [ ] UI notes the 26-vs-64 discrepancy rather than hard-coding 26.
- [ ] FY26-27 shows targets + sale, with Order Booking marked pending until the secondary file exists.
- [ ] Head names normalised; institutional bucketed; no duplicate head rows.
- [ ] No `files.export`; chunked reads; other dashboards untouched.

## 7. WHAT NOT TO DO
- Do not treat Q1 targets as annual (4× error).
- Do not put primary/register sale into the Order Booking column.
- Do not fabricate FY26-27 secondary data, or write 0 for a missing target.
- Do not hard-code the low-performer list to 26.
