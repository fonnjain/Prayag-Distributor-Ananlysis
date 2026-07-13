# Replit Agent Prompt — NEW page: **Customer Performance** (Distributor · Dealer · Retailer)

> Paste below the line. A new top-level page, separate from the Sales / State Head / Performance pages.
> Its subject is the **customer** (who buys), not the salesperson.

---

## ⭐ RULE ZERO — **UNITS FIRST, VALUE SECOND**

Revenue can rise while the customer actually shrinks, because the **price** went up. This is real and
verified in the client's own data (Sunil Patel's book, like-for-like months):

| | Change |
|---|---|
| **Value** | **+19.4%** ← what today's reports show |
| **Units (pcs)** | **+7.0%** ← the real demand signal |
| **Price effect** | **+12.3 pp of the "growth" was price, not volume** |

Item `WT-3LL-10`: **volume −10%**, **value +12%**, because the realized price rose **25%**. Today that
customer looks like they're growing. They are **shrinking**.

**Therefore: every screen leads with QUANTITY (pcs). Value is shown alongside, never instead.** Every
growth figure must be split into **volume growth** and **price effect**.

## THE THREE ENTITY TYPES (one page, a selector at the top)

| Entity | Source | Grain |
|---|---|---|
| **Distributor** | Order Sheet (primary) — `Customer` | invoice/order lines |
| **Direct Dealer** | same primary register, filtered to customers whose **Type = Direct Dealer** (flag from the per-member "Distributor Visit Report" tab, folder `1-guQptN9S4NrW024jGizKo0V4nFDtHMv`) | invoice/order lines |
| **Retailer** | Secondary Order Booking — `Retailer` / `Retailer Id` | order lines |

**Order Sheet history goes back 7 years** — 26-27 `1HFBAtvb…`, 25-26 `1Xzq-gmB…`, 24-25 `1cT6lWRP…`,
23-24 `1jtSUGE6…`, 22-23 `10NQiwrL…`, 21-22 `12GUYE6a…`, 20-21 `1F6tQ5Fr…`.
Secondary: 25-26 `1aNQ2Tcz…`, 24-25 `1sejEhXC…`, 23-24 `1c5ZmmcK…` (26-27 = manual upload).

Load **as many prior years as exist** — don't cap at 3.

## THE COMPARISON SET (show all, for units AND value)

For every entity:
1. **This period vs the SAME period last year** — the like-for-like view. *"Last year" = the same
   calendar months present in the current year* (FY26-27 = Apr+May+Jun → LY = Apr+May+Jun 2025).
2. **This year (YTD) vs last FULL year**
3. **vs the full year before that** — and further back while data exists (up to 7 years for primary)
4. **Seasonality warning:** month-on-month is meaningless (Mar ≈ 2.9× Apr). Never compare consecutive
   months; compare same-month-prior-year.

## THE DRILL: Category → Product, in PIECES

`Entity → Category (GROUP) → Product (item code)` — at every level show:

| Column | |
|---|---|
| **Qty LY / Qty CY / Δ qty / qty growth %** | ⭐ the headline |
| Value LY / Value CY / Δ value / value growth % | secondary |
| **Realized price LY / CY / price change %** | = Value ÷ Qty |
| **Price effect (pp)** | value growth % − qty growth % |

Group = from rate list Sheet1 (`1njO-srsS29qiE4t45-zr5njbB7R2Zb-oSnv2NL1ONY4`, Item Code → Item Group).

## ⭐ PRICE-CHANGE TRACKING

**Realized price = Taxable Value ÷ Quantity** (do **not** use the rate list's MRP — it's unreliable and
often 0). Show, per product:
- realized price by month/year, and the % change over the year
- **price vs volume scatter**: did a price rise cost us volume? (elasticity signal)
- **Flag list — "revenue up, volume down"**: every entity/product where value grew but units fell.
  These are the hidden shrinkers. This list is the single most valuable output of the page.
- Company view: price change by category, and how much of total growth is volume vs price.

## ⭐ SCHEME ENGINE (build the framework now; the client will supply the actual schemes)

Schemes reward customers for hitting order thresholds. Build a **configurable engine** — do **not**
hardcode any scheme.

**Scheme definition** (stored in config / an editable admin screen):
- name, description
- **applies to**: Distributor / Direct Dealer / Retailer (any combination); optionally a named list
- **period**: month / quarter / financial year / custom date range
- **basis**: **order value** OR **quantity (pcs)** — support both, since the client cares about pcs
- **scope**: all products, or a specific category/group, or a named product list
- **slabs**: an ordered list of `threshold → benefit` (e.g. ≥ ₹5,00,000 → 2%; ≥ ₹10,00,000 → 3.5%;
  ≥ ₹20,00,000 → 5%). Support both % and flat-amount benefits.

**Per-entity tracking (the useful part):**
- **Current achievement** in the scheme's period, on the scheme's basis
- **Current slab** reached, and **the next slab**
- ⭐ **"Distance to next slab"** — exactly how much more (₹ or pcs) is needed
- **Days left** in the period
- **Run-rate projection**: at their current pace, will they reach the next slab? (Yes / No / Borderline)
- **Value of the benefit** they'd unlock — so the push can be justified commercially

**⭐ THE PUSH LIST — this is what drives revenue.**
Rank entities that are **close to a slab but not there yet** (e.g. within 20% of the threshold, or
within reach at their run-rate). For each, show: *"Distributor X is **₹2.4 L short** of the 5% slab with
**12 days left** — at their current pace they'll finish ₹1.1 L short. Unlocking it is worth ₹X to them."*
Sort by **effort-to-reward** (smallest gap × largest benefit first). This is the highest-ROI call list
a sales team can have.
Also flag: entities who **just missed** a slab last period (chase them earlier this time), and entities
**already past the top slab** (no more incentive — don't waste the call).

## ADDITIONAL VIEWS
- **Churn**: entities that ordered last period/year but not this one — **listed by name**, with last
  order date, last value, and units.
- **New entities** added this period.
- **Category mix shift** per entity (in pcs): are they buying more pipe, less PTMT?
- **Concentration**: an entity dependent on one category is fragile.
- **Frequency**: order count and typical interval; days since last order.
- **Ranking/leaderboard** — sortable by **units** growth, value growth, or scheme progress.
- **Export to Excel** for any view.

## VERIFICATION
- Realized price = value ÷ qty; never the rate list's MRP.
- Reproduce the known case: **Sunil Patel like-months = value +19.4%, units +7.0%**; item `WT-3LL-10`
  = qty −10%, value +12%, price +25%.
- Report 4 in the existing State-Head reports uses **quantity** — this page's item-level numbers must
  agree with it (Universal Pipe / PTMT: 5,006 → 7,107 pcs).
- Like-months window applied (not full prior year) for the "same period" comparison.
- Direct Dealer figures must come from the primary register filtered by customer type — **not** a
  separate file (none exists).

## WHAT NOT TO DO
- Do **not** lead with value. Units first, always, with the price effect separated out.
- Do not take price from the rate list (unreliable, often 0) — derive it from value ÷ qty.
- Do not hardcode schemes — build the configurable engine.
- Do not compare consecutive months without seasonality adjustment.
- Do not mix primary (distributor/dealer) and secondary (retailer) figures in one total.
