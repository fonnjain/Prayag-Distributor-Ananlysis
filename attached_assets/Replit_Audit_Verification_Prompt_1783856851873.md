# Replit Agent Prompt — Full Audit & Verification, with an Excel audit report

> Paste below the line. Build an **Audit** engine that proves every number, and exports the results as
> a **downloadable Excel workbook**. Anchors come from the client's signed-off dashboards and from
> figures independently recomputed from the raw registers. **If a check fails, the app is wrong — do
> not loosen the tolerance or edit the anchor.**

---

## WHY THIS EXISTS
Numbers have silently broken five times on this project:
1. A head-name mismatch (`BIJJU` vs `Biju C.O`) dropped **₹10.2 Cr**.
2. Primary (dispatch) sales were fed into a secondary (order-booking) report — ₹361 Cr vs ₹240 Cr.
3. Quarterly targets were read as annual → achievement 4× wrong.
4. Sale and Order Booking showed the **same** value (₹217.50 Cr) — one source feeding both tiles.
5. Order Booking collapsed to **₹46.34 Cr** (19% of truth) — likely a truncated read.

Every one looked plausible on screen. The audit must be **automatic, itemised, and hard-failing**.

---

## BUILD

- `GET /api/audit?fy=<fy>` → runs all checks, returns
  `[{ id, group, check, expected, actual, delta, delta_pct, status, source_sheet, note }]`
  with `status ∈ pass | warn | fail | pending`.
- **Audit page**: grouped chips (green/amber/red/grey), each row showing *expected vs actual vs delta*
  and **which sheet the actual came from**.
- **"Download Audit (Excel)"** button → the workbook spec in §AUDIT WORKBOOK below.
- Anchors in `config/audit_anchors.json` (data, not code).
- Run automatically after every refresh; red banner on any `fail`; log every run with a timestamp.

---

## GROUP 1 — SOURCE HEALTH (run first; everything else depends on it)
For each configured source: probe with `spreadsheets.get`, then read and report **rows actually read**.

| Source | File ID | Expect |
|---|---|---|
| Roster (Team Member Details) | `1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2` | 182 people |
| Secondary Order Booking 25-26 | `1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80` | **full sheet (~8 MB)** |
| State Head Sale 2025-26 | `1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA` | 2 FYs |
| State Head Sale 2026-27 | `1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs` | 2 FYs |
| Order Sheet 26-27 | `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A` | FY26-27 lines |
| rate list | `1njO-srsS29qiE4t45-zr5njbB7R2Zb-oSnv2NL1ONY4` | Sheet1 + Sheet2 (~3,116 customers) |
| Target Master | `1ZLok3_8AZHdfrUm4T2lJmonAjngQFz4TuNLkHtU3p2I` | write-back only |
| Uploaded dashboards | 2025-26 / 2026-27 xlsx | 240 / 183 members |
| PARTY O/S & PAYMENT 26-27 | `1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok` | collection ledger |
| Secondary Order Booking **2026-27** | — | **`pending` — file does not exist (expected)** |

**1.1 — TRUNCATION CHECK (catches defect #5).** For every source, report
`rows_read`, `last_row_date`, `bytes/chunks fetched`. **Fail** if `rows_read` is a suspiciously round
number (1000 / 5000 / 10000) or if `last_row_date` is far before the FY end — that means the read
stopped early. Order Booking = ₹46 Cr (19% of ₹240 Cr) is exactly this signature.

## GROUP 2 — SECONDARY (order booking), FY2025-26 · basis: net `Sub Total`
| id | Check | Expected | Tol |
|---|---|---|---|
| 2.1 | Total Order Booking | **₹240.14 Cr** | ±1% |
| 2.2 | Team members | **240** | ±2 |
| 2.3 | Total orders | **52,515** | ±2% |
| 2.4 | Registered retailers | **15,809** | ±2% |
| 2.5 | Active retailers (≥1 order) | **≈8,467** | ±3% |
| 2.6 | Sandeep Dadheech | **₹157.39 Cr** | ±1% |
| 2.7 | Syed Aqil Rizvi | **₹45.23 Cr** | ±1% |
| 2.8 | Lalan Kumar | **₹13.25 Cr** | ±1% |
| 2.9 | Anant Singh | **₹9.86 Cr** | ±1% |
| 2.10 | **Biju C.O** | **₹5.55 Cr** | ±1% |
| 2.11 | Sujan Ghata (member spot-check) | **₹4.72 Cr** | ±1% |

> Registered (15,809) and Active (≈8,467) are **different** — check each against its own anchor.

## GROUP 3 — PRIMARY (register / dispatch)
| id | Check | Expected | Tol |
|---|---|---|---|
| 3.1 | FY2025-26 total | **₹361.14 Cr** | ±1% |
| 3.2 | FY2024-25 total | **₹341.14 Cr** | ±1% |
| 3.3 | FY2025-26 vs FY2024-25 growth | **+5.9%** | ±0.5pp |
| 3.4 | FY2026-27 YTD total | **₹73.22 Cr** | ±2% |

**FY2026-27 by head (₹Cr):** Sandeep 32.77 · Rizvi 13.04 · **Biju C.O 5.82** · Suresh Nair 2.91 ·
Non-territory ≈5.42 · Anant 2.57 · Babu 2.35 · Sulinder 2.12 · Pawan 1.90 · Lalan 1.80 · Nasir 0.99 ·
Sunil Patel 0.80 · Anuj 0.73 → **₹73.22 Cr**.

> **3.5 — THE CANARY: Biju C.O = ₹5.82 Cr.** He showed ₹0.00 for weeks because the register says
> `BIJJU` and the roster says `Biju C.O`. **A zero here = head-name normalisation is broken and ~₹10 Cr
> is being dropped.** This single check is the most important in the suite.

## GROUP 4 — SALE ≠ ORDER BOOKING (catches defects #2 and #4)
| id | Check | Expected | Status rule |
|---|---|---|---|
| 4.1 | FY25-26 Sale (primary) | ₹361.14 Cr | from State Head Sale 25-26 |
| 4.2 | FY25-26 Order Booking (secondary) | ₹240.14 Cr | from Secondary Order Booking |
| 4.3 | **Sale ≠ Order Booking** | differ by > 30% | **HARD FAIL if equal** |
| 4.4 | Neither tile is blank | both populated | **fail if blank** |
| 4.5 | Each tile reports its **source sheet id** | present | fail if absent |

## GROUP 5 — TARGETS & ACHIEVEMENT (catches defect #3)
| id | Check | Expected | Tol |
|---|---|---|---|
| 5.1 | FY25-26 members with a target | **194** | ±2 |
| 5.2 | FY25-26 total secondary target | **₹365.08 Cr** | ±1% |
| 5.3 | FY25-26 company achievement | **≈63.3%** | ±2pp |
| 5.4 | FY26-27 members with a target | **154** | ±2 |
| 5.5 | FY26-27 **Q1** total secondary target | **₹97.82 Cr** | ±1% |
| 5.6 | FY26-27 Sujan Ghata achievement | **57.1%** | ±0.5pp |
| 5.7 | FY26-27 Surojit Mondal achievement | **23.8%** | ±0.5pp |
| 5.8 | "No Target" count FY25-26 / FY26-27 | **≈46 / ≈29** (not 180) | ±3 |
| 5.9 | No member renders `0%` where target is absent | 0 violations | exact |

> FY25-26 targets are **ANNUAL**; FY26-27 targets are **QUARTERLY (Q1)**
> (`Total target ÷ Target monthly = 3.0`). If 5.6/5.7 come out ~4× off, the app is treating a
> quarterly target as annual.

## GROUP 6 — REPORT LOGIC (State-Head report tabs; verified vs `Sunil Patel 2026-27`)
| id | Check | Expected | Tol |
|---|---|---|---|
| 6.1 | Report 1 — State CY total | **₹7,978,394.92** | ±₹1 |
| 6.2 | Report 3 — PTMT LY / CY | **₹4,410,108.22 / ₹4,552,383.34** | ±₹1 |
| 6.3 | Report 3 — CISTERN LY | **₹134,414.17** | ±₹1 |
| 6.4 | Report 3B — Perfect Sanitary (Surat) CY | **₹996,625** | ±₹1 |
| 6.5 | Report 3C — Gujarat AGRI LY / CY | **₹118,230.26 / ₹411,501.80** | ±₹1 |
| 6.6 | Report 4 — Universal Pipe/PTMT **QTY** LY / CY | **5,006 / 7,107** | exact |

> **Like-months window:** "last year" = the **same calendar months present in the current year**
> (FY26-27 Apr+May+Jun → LY = Apr+May+Jun 2025 = ₹6,683,930.80, **not** full FY25-26 ₹31.6M).
> If Reports 1/3 come out 4–5× high, the app is comparing against the full prior year.
> **Report 4 uses QUANTITY**; all others use value.

## GROUP 7 — CROSS-FOOTS (must always hold, every FY, every basis)
- 7.1 Σ(member) = Σ(head) = company total (± ₹1)
- 7.2 Σ(by group) = Σ(by state) = Σ(by head) = grand total (± ₹1)
- 7.3 No duplicate head rows anywhere
- 7.4 Every roster head appears exactly once — **a head with ₹0 is a FAIL, not a blank**
- 7.5 Institutional (`OTHER/PROJECT/GOVT/GEM/JJM`) bucketed as Non-territory, never a person
- 7.6 Basis label present on every figure (`Primary (dispatch)` / `Secondary (net)`) — never mixed

## GROUP 8 — NAME MATCHING (the silent killer)
- 8.1 Secondary `Team Member Name` ↔ roster: **> 95%** match, by rows **and** by revenue
- 8.2 Register `STATE HEAD` ↔ roster (after alias map): **100%** — list any unmapped
- 8.3 Register `Customer` ↔ rate list Sheet2: **> 95%** by revenue; list unmatched with revenue
- 8.4 Dashboard `Name` ↔ roster: **> 95%**; list unmatched **with their target/CTC** (an unmatched name
      = a silently lost target)
- 8.5 Flag duplicate rows (e.g. the leftover `curl-test` rows for K.V. Thamizhselvan / Pratheesh CC)

---

## AUDIT WORKBOOK (the Excel export)

`Audit_<FY>_<yyyymmdd-HHMM>.xlsx`, built server-side with `exceljs` (streamed):

| Tab | Contents |
|---|---|
| **Summary** | run timestamp, FY, counts of pass/warn/fail/pending, overall verdict (PASS/FAIL), app version |
| **Checks** | every check: `id · group · check · expected · actual · delta · delta% · status · source_sheet · note` — conditional-formatted green/amber/red/grey |
| **Failures** | only `fail` rows, with a `probable_cause` column (e.g. "truncated read", "name mismatch", "wrong basis", "quarterly target read as annual") |
| **Source Health** | per source: id, title, status, rows_read, last_row_date, truncation_flag |
| **Unmatched Names** | every unmatched name, its source, its value (₹ / target / CTC), and the join it failed |
| **Head Reconciliation** | per head: expected vs actual, primary and secondary side by side, delta |
| **Cross-foots** | member→head→company sums, group/state/head sums, with deltas |
| **Anchors** | the anchor set used, so the run is reproducible and auditable |

Number formats: ₹ as `#,##0`; % as `0.0%`; deltas signed. Freeze header rows. Autofilter on **Checks**.

---

## ACCEPTANCE
- [ ] `/api/audit?fy=2025-26` → Groups 1,2,4,5,7,8 all **pass**; Excel downloads with all 8 tabs.
- [ ] `/api/audit?fy=2026-27` → Groups 1,3,5,6,7,8 **pass**; secondary-order-booking checks = **pending**
      (not fail).
- [ ] **3.5 Biju C.O = ₹5.82 Cr passes** (the name-normalisation canary).
- [ ] **4.3 passes** — Sale and Order Booking are different, each reconciling to its own anchor.
- [ ] **1.1 truncation check** would have caught the ₹46.34 Cr Order-Booking bug — demonstrate it.
- [ ] Failures tab names a probable cause for each failure, not just "mismatch".
- [ ] Anchors read from `config/audit_anchors.json`; adding one needs no code change.

## WHAT NOT TO DO
- Do not make a check pass by widening a tolerance or editing an anchor — fix the data flow.
- Do not treat the absent FY2026-27 secondary file as a failure (`pending`).
- Do not compare a Secondary actual to a Primary anchor (₹240 Cr vs ₹361 Cr are different metrics).
- Do not report "pass" for a check whose source read was truncated — truncation invalidates the check.
