# Replit Agent Prompt — Targets (period vs annual) + wire the HR/SFA source

> Paste below the line. Two corrections to the existing app. Both are based on the client's
> `STATE HEAD DASHBOARD 2026-27` (being added to Drive as a Google Sheet).

---

## FIX 1 — FY2026-27 targets are QUARTERLY (Q1), not annual. Treat targets as PERIOD targets.

The FY2026-27 targets that exist today cover **Q1 (Apr–Jun) only**, not the full year. Verified:
- `Total target ÷ Target monthly = 3.0` for 126 of 133 members (a 3-month target).
- `Direct Dealer Primary Target ÷ Monthly DD Target = 3.0` for all 17 members.
- Achievement is computed against the **quarterly** figure — e.g. Sujan Ghata `8,561,254 ÷ 15,000,000
  = 57.1%`, exactly matching the dashboard's stated 57.1%.
- Q1 secondary target ₹97.82 Cr × 4 ≈ ₹391 Cr annualised — consistent with FY2025-26's ₹365 Cr annual.

**If these are loaded as ANNUAL targets, every achievement % is ~4× wrong.** So:

- **Achievement % must be computed against the sum of the target months in the reporting period**,
  never against an annual figure divided by 12 when monthly values exist.
  `achievement% = actual(period) ÷ Σ target_m_<months in period>`
- In `Prayag Target Master` (`1ZLok3_8AZHdfrUm4T2lJmonAjngQFz4TuNLkHtU3p2I`), the FY2026-27 rows
  populate **`*_m_Apr`, `*_m_May`, `*_m_Jun` only**; the `*_annual` columns are intentionally
  **blank** because no full-year FY26-27 plan has been set.
- **Blank annual + partial months must NOT be treated as "no target".** If any target month in the
  period has a value, compute achievement from those months.
- Do **not** validate "monthly must sum to annual" when annual is blank. When annual IS set (e.g. the
  FY2025-26 backfill), keep that rule.
- Members with **no target at all** → show `No Target`, never `0%`.
- FY2025-26 rows in the Target Master carry **annual** targets (with monthly = annual/12). So the app
  must support both shapes: annual-driven (FY25-26) and month-driven (FY26-27). Decide per row:
  use monthly values when present; else fall back to annual ÷ 12.

## FIX 2 — Wire the HR / SFA source. These columns are NOT "missing" any more.

The client's `STATE HEAD DASHBOARD 2026-27` (Google Sheet, `Data` tab, header on **row 3**, 183
members) already contains what the app currently leaves blank. Add it as a live source
(`config/mgmt_sources.json` → `hr_sfa_dashboard`), read via chunked `values.get`, joined to the
roster on **Name** (normalised).

Available per member (column numbers on the `Data` tab):

| Field | Col | Coverage |
|---|---|---|
| CTC Monthly / CTC (period) | 36 / 37 | 183/183 |
| Designation / Emp Code | 75 / 76 | 123/183 |
| D.O.J / Active-Left / Left Date | 6 / 53 / 52 | 183/183 |
| Working Days | 33 | 182/183 |
| Total Visits | 32 | 182/183 |
| Total Working Hours | 44 | 181/183 |
| Total GPS KM | 45 | 181/183 |
| Avg Distance (KM) | 47 | 179/183 |
| Distributor / Direct-Dealer visits, Lead counters | 25–31 | mostly filled |
| Visited in a Month / Non-Visited Retailers | 12 / 15 | 180 / 165 |
| Cost Ratio (%) | 39 | 162/183 |
| **T.A. Bill ST. Cost** | 38 | **0/183 — genuinely empty** |

**Therefore the Missing Data tab must now list ONLY `T.A. Bill ST. Cost`.** Remove SFA visits, GPS,
working days, and CTC from the "no source" list — they have a source. If a value is blank for a
specific member, show blank for that member (not a global "source needed" note).

Note the dashboard's own header quirks: header row is **3**, `Target` (col 8) is the **secondary**
target, `Primary Target` is col 7, `Direct Dealer Primary Target` is col 64, `Total target` is col 65.
Detect columns by header text, not fixed index, since the sheet drifts.

## ACCEPTANCE
- [ ] FY2026-27 achievement % = actual(period) ÷ Σ(target months in period). Sujan Ghata reconciles to
      **57.1%** and Surojit Mondal to **23.8%** (the dashboard's own figures).
- [ ] FY2025-26 achievement still computes from annual targets (company ≈ **63.3%** overall).
- [ ] Blank `*_annual` + populated Apr/May/Jun is treated as a valid target, not "No Target".
- [ ] Members with genuinely no target show `No Target`, never `0%`.
- [ ] HR/SFA columns (CTC, designation, DOJ, working days, visits, GPS km, avg distance, working
      hours) populate from the dashboard source for ~180 members.
- [ ] Missing Data tab lists **only** `T.A. Bill ST. Cost`.
- [ ] Columns resolved by header text; no `files.export`; chunked reads; other dashboards untouched.

## WHAT NOT TO DO
- Do not treat the FY2026-27 quarterly targets as annual (4× error).
- Do not divide an annual target by 12 when explicit monthly targets exist — monthly wins.
- Do not write 0 for a missing target; show `No Target`.
- Do not keep SFA/GPS/CTC on the "no source" list — they are now sourced.
