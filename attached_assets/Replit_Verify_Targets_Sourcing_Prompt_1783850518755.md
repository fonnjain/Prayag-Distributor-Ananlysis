# Replit Agent Prompt — VERIFY: targets loaded + Sale/Order-Booking correctly sourced

> Paste below the line. Run this **after** the target backfill is pasted into `Prayag Target Master`.
> It proves the numbers are right rather than merely present. Any FAIL means the app is wrong —
> investigate the data flow, do not loosen the check.

---

## CONTEXT — two known defects this must catch

1. **"180 no target"** — the Target Master previously held only 2 `curl-test` rows. 348 real rows have
   now been pasted (194 × FY2025-26 annual + 154 × FY2026-27 Q1-monthly).
2. **Sale = Order Booking = ₹217.50 Cr** on the FY2025-26 dashboard. These are **different metrics from
   different sources and must never be equal.** ₹217.50 Cr matches neither expected value.

## BUILD
`GET /api/verify/targets?fy=<fy>` + a **Data Health** panel. Each check returns
`{check, expected, actual, delta, status}` with `status ∈ pass | warn | fail`. Red banner on any fail.

---

## CHECK GROUP A — Target load (run for both FYs)

| # | Check | Expected | Tol |
|---|---|---|---|
| A1 | Target Master rows read | **348** (+2 legacy test rows if not deleted) | exact |
| A2 | FY2025-26 members **with** a target | **194** | ±2 |
| A3 | FY2026-27 members **with** a target | **154** | ±2 |
| A4 | FY2025-26 total secondary target | **≈ ₹365.08 Cr** | ±1% |
| A5 | FY2026-27 **Q1** total secondary target | **≈ ₹97.82 Cr** | ±1% |
| A6 | FY2025-26 members with **no** target | **≈ 46** | ±3 |
| A7 | FY2026-27 members with **no** target | **≈ 29** | ±3 |
| A8 | Spot-check: Sujan Ghata FY2025-26 secondary target | **₹6,06,00,000** | exact |

**A9 — the critical one.** FY2026-27 rows have **blank `*_annual` columns** and only
`*_m_Apr / *_m_May / *_m_Jun` populated (they are **Q1** targets). The app must treat this as a
**valid target**, not "No Target".
→ **FAIL if any FY2026-27 member with populated monthly targets is reported as "No Target".**
Expected FY26-27 "no target" count is ~29 — **not 180**.

## CHECK GROUP B — Achievement maths (the quarterly trap)

`achievement % = actual(period) ÷ Σ target_m_<months in the selected period>`
Never `annual ÷ 12` when explicit monthly values exist.

| # | Check | Expected | Tol |
|---|---|---|---|
| B1 | FY2025-26 company achievement | **≈ 63.3%** | ±2pp |
| B2 | FY2026-27 Q1 — Sujan Ghata achievement | **57.1%** | ±0.5pp |
| B3 | FY2026-27 Q1 — Surojit Mondal achievement | **23.8%** | ±0.5pp |
| B4 | No member shows `0%` where the target is absent — must render `No Target` | 0 violations | exact |

> If B2/B3 come out ~4× off, the app is treating the **Q1** target as **annual**. That is the bug.

## CHECK GROUP C — Sale vs Order Booking (must NOT be equal)

| # | Check | Expected | Source | Tol |
|---|---|---|---|---|
| C1 | FY2025-26 **Order Booking** (secondary, net Sub Total) | **≈ ₹240.14 Cr** | Secondary Order Booking `1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80` | ±1% |
| C2 | FY2025-26 **Sale** (primary dispatch, Taxable Value) | **≈ ₹361.14 Cr** | State Head Sale 2025-26 `1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA` | ±1% |
| C3 | **Sale ≠ Order Booking** | difference > 30% | — | **hard fail if equal** |
| C4 | FY2026-27 **Sale** | **≈ ₹73.22 Cr** | Order Sheet 26-27 `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A` | ±2% |
| C5 | FY2026-27 Order Booking | **"pending"** (no FY26-27 secondary file exists) | — | pending ≠ fail |

**C6 — source attribution.** Every KPI tile must log/display **which sheet ID + FY** it read from.
A tile sourced from the wrong sheet is the root cause of C3; make it visible.

## CHECK GROUP D — Per-head reconciliation (FY2025-26, secondary)

| Head | Expected |
|---|---|
| Sandeep Dadheech | ₹157.39 Cr |
| Syed Aqil Rizvi | ₹45.23 Cr |
| Lalan Kumar | ₹13.25 Cr |
| Anant Singh | ₹9.86 Cr |
| **Biju C.O** | **₹5.55 Cr** |

**Biju C.O is the canary** — he previously showed ₹0.00 because the register says `BIJJU` and the
roster says `Biju C.O`. A zero here means head-name normalisation is broken and ~₹10 Cr is being
dropped silently.

Also: Σ(members) = Σ(heads) = company total (± ₹1). No duplicate head rows. Every roster head appears
exactly once — a head missing from output is a **fail**, not a blank.

## CHECK GROUP E — Name matching
- Target Master `team_member` ↔ roster `Name`: **> 95% match**. List unmatched names with their target
  value (a mismatched name = a silently lost target).
- Watch for `(Off Roll)` / `(city)` suffixes and case differences; normalise before matching.
- Duplicate FY26-27 rows for `K.V.THAMIZHSELVAN` and `PRATHEESH CC` (the old `curl-test` rows) →
  flag as duplicates so they aren't double-counted.

## ACCEPTANCE
- [ ] `/api/verify/targets?fy=2025-26` → A1–A8, B1, B4, C1–C3, D all **pass**.
- [ ] `/api/verify/targets?fy=2026-27` → A1, A3, A5, A7, **A9**, B2, B3, C4 **pass**; C5 = pending.
- [ ] "no target" count drops from **180** to **≈46 (FY25-26)** and **≈29 (FY26-27)**.
- [ ] Sale and Order Booking show **different** values, each reconciling to its own anchor.
- [ ] Data Health panel shows actual vs expected vs delta for every check; red banner on any fail.

## WHAT NOT TO DO
- Do not make a check pass by widening a tolerance or editing an anchor — fix the data flow.
- Do not treat FY26-27's blank `*_annual` as "No Target" when monthly values exist.
- Do not report the absent FY26-27 secondary file as a failure — it is a known gap (`pending`).
- Do not let Sale and Order Booking read from the same sheet.
