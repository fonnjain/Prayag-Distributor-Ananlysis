# Replit Agent Prompt — FIX: Management Report is empty because the Secondary Order Booking source isn't being read

> Paste below the line into the Replit agent. This is a bug fix on the existing Management Report
> engine. Do not rebuild the report; keep every tab, header, and layout exactly as they are now.

---

## SYMPTOM

The engine-generated `StateHeadDashboard_2026-27` is structurally correct (all 6 tabs, 180 team
members, identity columns 100% filled) but ~15 columns that should have data are blank. The engine's
own **Missing Data** tab lists **"Source needed: Secondary Order Booking Segment Wise workbook"** —
i.e. it is NOT reading that file. That single miss empties Order Booking, retailer counts, order
counts, and all the business-achieved columns.

**This is a source-connection bug, not a design problem.** The HR roster join already works
(State Head, Name, State, HQ, DOJ, Active/Left all populate). Fix ONLY the Secondary Order Booking
read + mapping. Do not touch the roster logic or the tab layout.

## ROOT-CAUSE CHECKLIST (do all four, in order, and log each)

1. **Access.** The file is owned by DEEPAKJ@prayagindia.com but may not be shared with the service
   account. On read failure, surface the exact Google error (403 = not shared, 404 = wrong id) in the
   run log and in the Missing Data note, instead of silently marking "source needed". If 403/404,
   stop and tell the user to share these ids with the service-account email — don't fail silently.

2. **Size / read method.** The 2025-26 file is ~8.3 MB. Do NOT use `drive.files.export` (10 MB cap
   and it will eventually fail). Read the **Data Sheet** tab via `spreadsheets.values.get` in chunked
   A1 ranges (e.g. 20,000 rows per call) until a chunk returns < chunk size. `values.get` has no
   export cap.

3. **Header drift across years — detect by content, not position.** Column names differ per file:
   - 2025-26 / 2024-25: `Retailer Id`, `Team Member Name` (2024-25 uses `TEAM MEMBER`)
   - 2023-24 / 2022-23: `ID`, `Team member`, `Retailers` (not `Retailer`)
   Also the first row can be a totals/ids row, and multi-line orders repeat the same `Order ID` across
   rows with the header fields blank (forward-fill Date/Retailer/Order ID/Team Member down the block).
   Build a synonym map and locate the header row by scanning for a row containing
   `(RETAILER or RETAILERID) AND (TEAMMEMBER... ) AND SEGMENT AND ORDERVALUE` after
   `upper().replace(/[^A-Z0-9]/g,'')`.

4. **Join key.** Join order-booking rows to the report roster on **Team Member Name**, normalised:
   trim, collapse spaces, case-insensitive. Log any order-booking `Team Member Name` that does NOT
   match a roster name (and vice-versa) to the Missing Data tab as "unmatched team member: X" — do not
   drop silently. Expect near-100% match; a large mismatch means the normaliser is wrong.

## SOURCE (confirmed ids — already verified present in Drive)

```json
"secondary_order_booking": {
  "folderId": "1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ",
  "tab": "Data Sheet",
  "files_by_year": {
    "2026-27": "",  
    "2025-26": "1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80",
    "2024-25": "1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g",
    "2023-24": "1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY",
    "2022-23": "1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c"
  }
}
```
Report FY = 2026-27. If the 2026-27 file id is blank, **auto-discover** it from `folderId` (a file
whose title contains "2026" / "26-27"). If none exists yet, write a clear Missing Data note
("2026-27 Secondary Order Booking file not found in folder") and fill FY26-27 order columns blank —
but STILL read 2025-26 for the prior-year comparison columns. Do not blank the whole report.

## COLUMNS THIS SOURCE MUST FILL (exact `Data` tab headers)

Per team member, for the selected FY, aggregated from that member's order-booking rows:

| Data-tab column | Derivation from Secondary Order Booking |
|---|---|
| `No of Orders` | count of distinct `Order ID` |
| `Total Retailers` | count of distinct `Retailer Id` this FY |
| `Total Old Retailers` | distinct retailers whose **first-ever** order (across all years) is before this FY |
| `New Retailers` | distinct retailers whose first-ever order falls in this FY |
| `Old Party Business Order Booking` | Σ `Order Value` from old retailers |
| `New Party Order Booking` | Σ `Order Value` from new retailers |
| `Business Achived By No. of Old Parties` | count of old retailers that ordered this FY |
| `Business Achived By No. of New Parties` | count of new retailers that ordered this FY |
| `Business Achieved By` | Σ `Order Value` (total secondary order booked this FY) |
| `Direct Dealers order` / `Business Achieved By Direct Dealer` | Σ `Order Value` where `Distributor` marks a direct dealer (see note) |
| `New Party Orders` | count of distinct `Order ID` from new retailers |
| `Business Per Retailer` | `Business Achieved By` ÷ `Total Retailers` (blank if 0 retailers) |
| `Segment` splits (feeds Summary/Primary tabs) | group `Order Value` by `Segment` → canonical group via the INDEX map (`1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY`) |

Also fill the matching columns on **`SECONDARY ORDER BOOKING REPORT`** (`Order Booked 26-27`,
`Total Dealer 26-27`, and the monthly `Order Booked Amount/Count` blocks — split `Order Value` by
month from `Date`) and **`Primary Team Members 2026-27`** (`Secondary Order Booked 26-27`,
`Retailers 26-27`, `Distributor 26-27`, `Direct Dealers 26-27`), and roll all of the above up to
State Head on **`Summary 26-27`**.

**Direct-dealer flag:** if there's no explicit dealer/distributor type column, treat `Distributor`
value as the distributor name and leave the direct-dealer split blank + noted, rather than guessing.
(If a dealer master is later provided, wire it here.)

## LEAVE ALONE (still legitimately blank — keep them in Missing Data, do NOT fabricate)

`Primary Target / Target / Achievement / Target Achievement (%)` (Targets tab, separate build) ·
`Sale Report 26-27` (per-member dispatched sale — needs retailer→TM bridge; keep blank) ·
`Total/Lead/Non-Lead Visits, Working Days, Total Working Hours, Average Visit Per Day,
Active Parties Visits, Business Received Parties Visits, Visited But No Business` (SFA app) ·
`Total GPS KM / Avg Distance (KM)` (SFA app) · `CTC Monthly / CTC` (payroll) ·
`T.A. Bill ST. Cost / Cost Ratio (%)` (finance).

## MONTHS / PARTIAL-DATA GUARD

Split `Order Value` into months from `Date`. FY2026-27 is partial (data ends early July) — populate
the months that exist; do not back-fill or annualise. Any month with no rows stays 0/blank per the
existing layout.

## ACCEPTANCE (must all pass)

- [ ] Run log shows the Secondary Order Booking file opened and **N rows read > 0** for FY2026-27
      (and for 2025-26 prior-year), with the chunked-range method — no `files.export`.
- [ ] On the `Data` tab, these columns are now populated for members who have orders:
      `No of Orders, Total Retailers, Total Old Retailers, New Retailers, Business Achieved By,
      Old/New Party Order Booking, Business Per Retailer`.
- [ ] `Business Achieved By` per State Head on `Summary 26-27` equals the sum of its members (± ₹1),
      and equals the total `Order Value` read for that head (cross-foot check in the log).
- [ ] `SECONDARY ORDER BOOKING REPORT` monthly Order-Booked blocks show Apr–Jun (Jul partial) numbers.
- [ ] Segment splits map through the INDEX file with **zero unmapped segments** (unmapped → logged).
- [ ] Missing Data tab NO LONGER lists Secondary Order Booking as "source needed"; it now lists only
      the genuinely-absent sources (Targets, SFA visits/GPS, CTC, T.A., retailer→TM bridge).
- [ ] Any unmatched Team Member Name (order-booking ↔ roster) is listed, and the match rate is > 95%.
- [ ] No tab, header, column order, merged cell, or TOTAL row changed from the current output.

## WHAT NOT TO DO

- Do not mark a source "needed" without first logging the real reason (403/404/parse) it failed.
- Do not use `files.export`; read via chunked `values.get`.
- Do not parse by fixed column position — headers drift across years.
- Do not write 0 into visit/GPS/CTC/T.A./Target columns — those stay blank + listed.
- Do not change the report layout; this fix only fills existing cells.
