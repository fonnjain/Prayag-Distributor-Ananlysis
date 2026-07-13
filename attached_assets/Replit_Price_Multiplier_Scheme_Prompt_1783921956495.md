# Replit Agent Prompt — PRICE MULTIPLIER: set scheme targets on real growth, not price inflation

> Paste below the line. This extends the Customer Performance / Scheme engine. It is the mechanism that
> stops value-based scheme targets from rewarding price rises.

---

## THE PROBLEM (verified on the client's own data)

Scheme targets are set on **order value**. Prices rose ~10.7% this year. So a distributor buying
**exactly the same pieces** automatically books ~10.7% more value — and collects the benefit for zero
extra volume.

**Measured: at a naive "+10% value" target, 135 of 250 customers (54%) would hit it buying ZERO extra
pieces.** The scheme pays for nothing.

## THE INSTRUMENT — a LASPEYRES price multiplier (NOT value ÷ qty)

```
multiplier = Σ( qty_LY × price_CY )  /  Σ( qty_LY × price_LY )
```

Hold **last year's quantity basket** fixed, reprice it at **this year's** realised prices. Anything left
is **pure price** — mix shift removed.

- **realised price = Taxable Value ÷ Quantity.** Never the rate-list MRP (unreliable, frequently 0).
- ⚠️ **Do NOT use naive value÷qty.** It is contaminated by mix. Measured company-wide: naive **1.1563**
  vs true Laspeyres **1.1072** — **4.9pp of the apparent "price rise" was mix, not price.** Using the
  naive figure would over-tax every target.

## MEASURED VALUES (FY2026-27 vs FY2025-26, like-for-like months)

- **Company multiplier = 1.1072** (prices +10.7%)
- Reported value growth −27.6% · actual units −37.3% · **real growth (deflated) −34.6%**
- **Per category** (they differ a lot — a single company multiplier over-taxes some and under-taxes
  others): HDPE 1.3195 · C P 1.2298 · Water Tank 1.1901 · Cabinet 1.1857 · Seat Cover 1.1730 ·
  Floor Trap 1.1611 · Cistern 1.1436 · Connection 1.1215 · Garden Pipe 1.1088 · Waste Pipe 1.1077 ·
  Sanitaryware 1.0924 · CP Access 1.0918 · Sink 1.0828 · PTMT 1.0801 · SWR 1.0696 · UPVC 1.0559 ·
  AGRI 1.0532 · Teflon 1.0408 · CPVC 1.0103 · **WT Lid 0.9936 · Hardware 0.9819 (prices FELL)**
- **Per customer**: 250 computed, range 0.966 – 1.334, median 1.105.

## THE FORMULAS (implement exactly)

```
scheme_target   = value_LY × multiplier × (1 + desired_real_growth)
deflated_actual = actual_value / multiplier
achievement %   = deflated_actual / value_LY
flat_target     = value_LY × multiplier      # what they'd hit with ZERO growth
```

**Worked example** (distributor did ₹1,00,00,000 last year, we want +10% *real* growth):

| Method | Target | Reality |
|---|---|---|
| Flat (same pieces) | ₹1,10,71,591 | zero growth |
| **Naive "+10% value"** | ₹1,10,00,000 | ❌ **below the flat target — they can buy FEWER pcs and still win** |
| **Correct "+10% real"** | **₹1,21,78,750** | ✅ demands 10% more pieces |

## MULTIPLIER RESOLUTION ORDER (per customer, per scheme)

1. **Customer multiplier** — their own LY basket repriced. Most accurate. Use when they have enough
   items in common between the two years (set a minimum, e.g. ≥10 shared items and ≥₹2 L of LY value).
2. **Category multiplier** — when the scheme is category-specific, or the customer's own basket is too
   thin/unstable.
3. **Company multiplier** — fallback.

**Always display which level was used**, and the multiplier value, next to every target. A target nobody
can explain will not be trusted.

## AUTO-UPDATE FOR COMING YEARS

- At each FY close, **recompute** the Laspeyres multiplier (company / category / customer), **store it
  against that FY, and freeze it** — it is the audit trail. Never retro-edit a closed year.
- **Setting next year's target before the year happens** — two inputs, take whichever exists:
  - **(a) Announced price rise** (management approves, say, a 6% list increase) → forward multiplier
    = 1.06. **This overrides.** Provide an admin field for it, per category.
  - **(b) Trailing estimate** — no announcement → use the trailing measured multiplier, optionally
    smoothed over the last 2–3 years.
- **True-up at year end:** recompute the actual multiplier and **restate achievement**, so nobody is
  rewarded or penalised for a price move they didn't control. Show provisional vs final.

## GUARDRAILS
- Cap the multiplier to a sane band (e.g. **0.8 – 1.5**); anything outside → flag for review, don't apply.
- **If prices FELL (multiplier < 1), the target must fall too.** Do not silently floor it at 1.0 —
  Hardware (0.9819) and WT Lid (0.9936) are real cases.
- A customer with too few shared items → fall back up the resolution order; never emit a wild multiplier.
- Store multipliers as data (config/table), not code. Adding a year must need no code change.

## UI
- **Scheme setup:** the admin sets the **desired REAL growth %** (e.g. +10%), not a rupee number. The app
  computes each customer's rupee target = `LY × multiplier × 1.10`.
- Show, per customer: LY value · multiplier (and its source level) · **flat target** · **scheme target** ·
  current actual · **deflated actual** · real achievement % · distance to the next slab.
- **A "price-only progress" warning:** if a customer's value achievement is running ahead of their
  *deflated* achievement, show *"₹X of this progress is price, not volume."*
- Toggle: **value-based** vs **pieces-based** slabs.

## ⭐ THE RECOMMENDATION TO SURFACE IN THE UI
**Setting scheme slabs in PIECES removes the problem entirely** — no multiplier, no price distortion,
and it rewards exactly what the business wants: more product sold. Support both, and recommend running
a **pcs-based slab as primary with a value slab as a secondary check.**

## VERIFICATION
- Company Laspeyres = **1.1072**; naive value/qty = **1.1563** (must differ — if equal, mix isn't being
  removed and the implementation is wrong).
- 250 customer multipliers computed; range ≈ 0.966–1.334.
- At a naive +10% value target, **135 of 250 customers** are shown as reachable with zero volume growth.
- Hardware and WT Lid produce multipliers **below 1.0** and their targets go **down**, not up.

## WHAT NOT TO DO
- Do not use value÷qty as the multiplier (mix contamination).
- Do not take price from the rate list.
- Do not floor the multiplier at 1.0 when prices fell.
- Do not retro-edit a frozen FY multiplier.
- Do not show a rupee target without showing the multiplier and its source level.
