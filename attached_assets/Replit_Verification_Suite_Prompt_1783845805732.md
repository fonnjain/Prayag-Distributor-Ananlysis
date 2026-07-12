# Replit Agent Prompt — Verification suite: prove the numbers are right

> Paste below the line. Build a **Data Health / Verify** page + `/api/verify` endpoint that reconciles
> every dashboard against known-good anchors. These anchors come from the client's **approved,
> signed-off** files and from figures independently recomputed from the raw registers. If the app
> can't hit them, the app is wrong — not the anchors.

---

## WHY
Numbers have silently broken three times in this project: a name-mismatch dropped ₹10.2 Cr, primary
(dispatch) sales were fed into a secondary (order-booking) report, and quarterly targets were read as
annual. Each looked "fine" on screen. Verification must be **automatic, visible, and hard-failing** —
not a manual eyeball.

## BUILD
- `GET /api/verify?fy=<fy>` → runs every check below, returns `{check, expected, actual, delta, status}`
  where status ∈ `pass | warn | fail`.
- A **Data Health** page: green/amber/red chips per check, grouped by dashboard. Show `actual vs
  expected vs delta%`.
- Store anchors in `config/verify_anchors.json` (editable, not hard-coded in logic).
- Run automatically after every data refresh; surface a red banner in the app if any **fail**.
- Block the "final"/export action on a hard fail (allow override with a logged confirmation).

---

## ANCHOR SET 1 — SECONDARY (management report / Sales page), FY2025-26
Source of truth: the approved `STATE HEAD DASHBOARD 2025-26`. **Basis: net order booking (Sub Total).**

| Check | Expected | Tol |
|---|---|---|
| Total Sale Report 25-26 | **₹240.14 Cr** | ±1% |
| Team members | **240** | ±2 |
| Total orders | **52,515** | ±2% |
| Registered retailers | **15,809** | ±2% |
| Active retailers (≥1 order in FY) | **≈8,467** | ±3% |
| Sandeep Dadheech | **₹157.39 Cr** | ±1% |
| Syed Aqil Rizvi | **₹45.23 Cr** | ±1% |
| Lalan Kumar | **₹13.25 Cr** | ±1% |
| Anant Singh | **₹9.86 Cr** | ±1% |
| Biju C.O | **₹5.55 Cr** | ±1% |
| Company achievement % (vs ₹365 Cr secondary target) | **≈63.3%** | ±2pp |

> Note: Registered (15,809) and Active (≈8,467) are **different** numbers — check each against its own
> anchor. Do not force one to match the other.

## ANCHOR SET 2 — PRIMARY (register / dispatch)
Source: State Head Sale registers, independently recomputed.

| Check | Expected | Tol |
|---|---|---|
| FY2026-27 total (YTD) | **₹73.22 Cr** | ±2% |
| FY2025-26 total (full year) | **₹361.14 Cr** | ±1% |
| FY2024-25 total (full year) | **₹341.14 Cr** | ±1% |
| FY2025-26 vs FY2024-25 growth | **+5.9%** | ±0.5pp |

**FY2026-27 by head** (₹Cr): Sandeep 32.77 · Rizvi 13.04 · **Biju C.O 5.82** · Suresh Nair 2.91 ·
Non-territory ≈5.42 · Anant 2.57 · Babu 2.35 · Sulinder 2.12 · Pawan 1.90 · Lalan 1.80 · Nasir 0.99 ·
Sunil Patel 0.80 · Anuj 0.73. **Total ₹73.22 Cr.**

> **Biju C.O = ₹5.82 Cr is the canary.** It previously showed ₹0.00 because the register says `BIJJU`
> and the roster says `Biju C.O`. If this check fails, head-name normalisation is broken.

## ANCHOR SET 3 — TARGETS (quarterly-vs-annual trap)
| Check | Expected | Tol |
|---|---|---|
| FY2026-27 achievement — Sujan Ghata | **57.1%** | ±0.5pp |
| FY2026-27 achievement — Surojit Mondal | **23.8%** | ±0.5pp |
| FY2026-27 Q1 secondary target (all members) | **≈₹97.82 Cr** | ±2% |
| FY2025-26 company achievement | **≈63.3%** | ±2pp |

> FY26-27 targets are **Q1 (Apr–Jun)**, not annual: `Total target ÷ Target monthly = 3.0`. If achievement
> comes out ~4× off, the app is treating a quarterly target as annual.

## ANCHOR SET 4 — REPORT LOGIC (State-Head report tabs)
Reconcile a generated report against the client's own file (**Sunil Patel 2026-27**):

| Check | Expected | Tol |
|---|---|---|
| Report 1 — State CY total | **₹7,978,394.92** | ±₹1 |
| Report 3 — PTMT LY / CY | **₹4,410,108.22 / ₹4,552,383.34** | ±₹1 |
| Report 3 — CISTERN LY | **₹134,414.17** | ±₹1 |
| Report 3B — Perfect Sanitary (Surat) CY total | **₹996,625** | ±₹1 |
| Report 3C — Gujarat AGRI LY / CY | **₹118,230.26 / ₹411,501.80** | ±₹1 |
| Report 4 — Universal Pipe / PTMT **QTY** LY / CY | **5,006 / 7,107** | exact |

> **Like-months window:** "last year" = the **same calendar months present in the current year**
> (Sunil Patel FY26-27 = Apr+May+Jun → LY = Apr+May+Jun 2025 = ₹6,683,930.80, **not** full FY25-26
> ₹31.6M). If Report 1/3 come out ~4–5× high, the app is comparing against the full prior year.
> **Report 4 uses QUANTITY**, all others use value.

## ANCHOR SET 5 — INTERNAL CROSS-FOOTS (must always hold)
- Σ(member sale) = Σ(head sale) = company total (± ₹1), every FY, every basis.
- Σ(by group) = Σ(by state) = Σ(by head) = grand total (± ₹1).
- No duplicate head rows anywhere; every roster head appears exactly once.
- Every roster head appears in output (a head with ₹0 is a **fail**, not a blank).
- Unmatched names (roster ↔ secondary ↔ register) < 5% of rows **and** < 5% of revenue — list them.
- Unmapped customers / item groups listed with their revenue (never silently dropped).
- Basis label present on every figure (`Primary (dispatch)` vs `Secondary (net)`) — never mixed.

## ANCHOR SET 6 — SOURCE HEALTH
Probe each configured source with `spreadsheets.get` (cheap) and report per-source:
`ok | not_shared(403) | not_found(404) | empty | error`. Include:
roster · target master · rate list · Order Sheet 26-27 · State Head Sale (24-25/25-26/26-27) ·
Secondary Order Booking (23-24/24-25/25-26) · PARTY O/S & PAYMENT · group index.
Explicitly report **"Secondary Order Booking 2026-27: not found"** as an expected, known gap — not an error.

## ACCEPTANCE
- [ ] `/api/verify?fy=2025-26` passes Anchor Sets 1, 3(FY25-26), 5, 6.
- [ ] `/api/verify?fy=2026-27` passes Anchor Sets 2, 3(FY26-27), 5, 6; Order Booking checks report
      **"pending — source not created"**, not fail.
- [ ] Biju C.O = ₹5.82 Cr (FY26-27 primary) passes — the name-normalisation canary.
- [ ] A generated Sunil Patel report reconciles to Anchor Set 4 **to the rupee**.
- [ ] Data Health page shows every check with actual vs expected vs delta; red banner on any fail.
- [ ] Anchors live in `config/verify_anchors.json`; adding an anchor requires no code change.

## WHAT NOT TO DO
- Do not "fix" a failing check by loosening a tolerance or editing an anchor — investigate the data.
- Do not treat a legitimately absent source (FY26-27 secondary) as a failure; mark it pending.
- Do not compare a Secondary figure to a Primary anchor (₹240 Cr vs ₹361 Cr are different metrics).
