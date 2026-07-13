# Replit Agent Prompt — "Primary Performance vs History" (a SEPARATE dashboard)

> Paste below the line. This is a **second, separate** early-warning dashboard — for **PRIMARY**
> (Prayag → distributor). Keep the Secondary one intact. They measure different transactions and must
> never be merged.

---

## WHY A SEPARATE DASHBOARD

| | SECONDARY dashboard | **PRIMARY dashboard (this one)** |
|---|---|---|
| Transaction | Distributor → **Retailer** | Prayag → **Distributor / Direct Dealer** |
| Unit of analysis | retailer | **distributor** |
| Salesperson | in the file (`Team Member Name`) | **not in the file** → via the bridge |
| Unique metric | retailer churn | **PENDING ORDERS (booked − dispatched)** |

## ⭐ THE KEY FACT — PRIMARY ORDER DATES ARE ALREADY DAILY

There are **two** primary measures with **two different date types**. This distinction decides whether
run-rate works:

| Measure | Source | Date type | Daily? | Run-rate |
|---|---|---|---|---|
| **Order Booking** ≈ ₹96 Cr | **Order Sheet 26-27** `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A` | **order date** | ✅ **YES — spread across the month** (a daily order report is already emailed internally: 06-Mar 83,585 · 10-Mar 733,129 · 13-Mar 682,894 …, Sundays zero) | ✅ **WORKS TODAY** |
| **Sale / Dispatch** ≈ ₹73 Cr | SALE SHEET 26-27 `19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps` / State Head Sale `1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs` | **dispatch date** | ❌ clusters at month-end | build it, but see below |

**Therefore: build the run-rate/pace engine on ORDER DATES from the Order Sheet — it works now.**

For the **dispatch** measure, build the same capability but use a **separate dispatch pace curve**
derived from its own history. Because dispatch naturally back-loads, the engine must **not** raise a
"behind pace" warning early in the month on the dispatch measure — that is normal behaviour, not a
failing rep. Make the curve **data-driven and configurable**, so that when dispatch data starts being
updated daily, the same code becomes accurate with no rewrite. Show a small note on dispatch-based
figures: *"dispatch is currently back-loaded; pace is indicative only."*

## ATTRIBUTION — the primary register has no salesperson

Order Sheet carries `Customer` (the distributor) and `STATE HEAD`, but **no team member**. So:
- **State Head level:** works directly from the sheet.
- **Team Member level:** requires the **Distributor → Team Member bridge**, built from the ~180
  per-member working files in folder `1-guQptN9S4NrW024jGizKo0V4nFDtHMv` ("Distributor Visit Report"
  tab; its **Type** column also distinguishes `Distributor` vs `Direct Dealer`). Cache it.
- Distributors the bridge cannot map → **"Unassigned"** bucket under their State Head. Never drop
  revenue, never guess an owner.

## SEASONALITY (same rule as the secondary dashboard — do not skip)

Month as % of annual: Apr 4.2 · May 8.2 · Jun 8.3 · Jul 7.3 · Aug 7.0 · Sep 7.4 · Oct 7.1 · Nov 8.5 ·
Dec 10.1 · Jan 10.1 · Feb 9.6 · **Mar 12.3**. **March ≈ 2.9× April.** Never compare a month with the
preceding month. Compare with the **same month in prior years** and with the entity's own trend.
History available: Order Sheets back to **FY2020-21** (7 years) — use 3 years for baselines.

## THE THREE BASELINES (per distributor, per rep, per state head)
1. **Same month last year** (and the year before) — seasonality-honest, with growth %.
2. **Own trailing 3-month average**, seasonally normalised.
3. **Run-rate projection to month-end** — from the **order-date** pace curve — vs target.

## ⭐ PENDING ORDERS — the primary-only signal (build this properly)

`Pending = Order Booking (booked) − Sale (dispatched)` ≈ **₹23 Cr** for FY2026-27.

- Show **pending by distributor, by state head, by rep**, and **pending ageing buckets**
  (0–15 / 16–30 / 31–60 / 60+ days since booking).
- **This is an OPS signal, not a sales signal.** A distributor whose orders are booked but not shipping
  has a stock / credit-hold / logistics problem. **Do not penalise the salesperson for it.** Route these
  to a separate **"Pending / Fulfilment"** alert stream, clearly labelled as not a rep-performance issue.
- Flag: pending rising while booking is flat (fulfilment bottleneck), or a distributor with large
  ageing pending (credit hold?).

## LEADING INDICATORS (distributor-level — these move before revenue)

Per rep / state head, versus their own trailing baseline:
- **Distributor churn** — distributors who ordered last period but not this one → **list them by name**,
  with last order date and value
- **Days since last order**, per distributor
- **Order frequency drop** — a distributor that ordered fortnightly now orders monthly
- **Active distributors** vs their normal count
- **New distributors / direct dealers** added (zero = warning)
- **Average order value** trend, and **order count** (a falling count with steady value hides a problem)
- **Distributor concentration** — a rep carried by 1–2 large parties is fragile
- **Channel mix** — Retail vs Govt / GeM / JJM / Project (the daily order report already splits these);
  keep institutional channels in company totals but **never attribute them to a person**
- **Pending ageing** (see above — routed separately)

Combine into a risk score, but **always show the reasons**. Never a bare score.

## WARNING SURFACES (same three as the secondary dashboard)
- Traffic light per rep / state head (green / amber / red) — based on projected month-end vs target
  **and** vs own history, not raw revenue
- Ranked watchlist — most urgent first, each with a plain-language reason
- Alert feed — e.g. *"Sandeep Dadheech: 4 distributors have not ordered in 45 days (₹1.2 Cr last year)"*,
  *"₹3.4 Cr of orders booked >30 days ago still undispatched — fulfilment, not sales"*

## RECOMMENDATIONS (specific, named)
- **Distributors gone quiet** — with last order date, last value, and typical order interval → "call these 6"
- **Under-indexed product groups** vs peers under the same State Head (join GROUP via rate list Sheet1)
- **Peer benchmark** — comparable reps/heads: more distributors? more orders? higher AOV?
- **If behind pace:** required run-rate for the remaining days, and roughly how many orders at their
  typical order value.

## PAGE LAYOUT
- **Toggle at the top: Order Booking (booked) | Sale (dispatched) | Pending** — three views of primary.
  Default to **Order Booking**, because it's the daily, leading, actionable one.
- Company summary: green/amber/red counts, alert feed, ranked watchlist, **pending ageing** panel.
- Drill: State Head → Team Member (via bridge) → Distributor.
- Per-entity view: traffic light + reasons, 3-year monthly chart with current period highlighted, the
  three baselines, leading indicators vs own normal, recommendations.
- Claude narrative per entity — grounded strictly in the displayed numbers, no invented figures.

## VERIFICATION
- FY2026-27 Order Booking ≈ **₹96 Cr**; Sale ≈ **₹73 Cr**; Pending ≈ **₹23 Cr**. These three must
  reconcile: Booking − Sale = Pending.
- Order-date pace curve must show orders spread across working days (Sundays ≈ 0) — **not** clustered
  at month-end. If it clusters, the wrong date column is being used.
- Entities with **no history** → "insufficient history", not a warning. No target → "No Target", not 0%.
- Every figure labelled with its basis: **Primary — Order Booking / Sale / Pending**.

## WHAT NOT TO DO
- Do not merge this with the Secondary dashboard, or compare a primary figure to a secondary one.
- Do not build the order pace curve from dispatch dates — use the **Order Sheet's order dates**.
- Do not raise rep-performance warnings from **pending** — that's a fulfilment issue.
- Do not attribute institutional channels (Govt / GeM / JJM / Project / Other) to a salesperson.
- Do not drop distributors the bridge can't map — bucket them as "Unassigned" under their State Head.
