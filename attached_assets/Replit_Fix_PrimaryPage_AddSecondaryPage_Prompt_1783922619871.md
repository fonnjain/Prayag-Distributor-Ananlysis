# Replit Agent Prompt — Fix Primary Performance (₹0.00) + add the missing Secondary Performance page

> Paste below the line. Two bugs.

---

# BUG 1 — Primary Performance shows ₹0.00 Cr. The data EXISTS.

The page currently says *"No primary attribution data available for FY 2026-27 — primary attribution
requires the distributor bridge to be built"* and shows **₹0.00 Cr** on all three tiles.

**This is wrong.** The page is gating **everything** on the Distributor→Team-Member bridge. But the
bridge is **only** needed for the **per-salesperson** split. It is **not** needed for company or
state-head totals, because **Order Sheet 26-27 already contains a `STATE HEAD` column.**

## What must show RIGHT NOW, with no bridge at all:

| Tile | Value | Source |
|---|---|---|
| **Order Booking (booked)** | **≈ ₹96 Cr** | Order Sheet 26-27 `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A` — sum `Taxable Value` |
| **Sale / Dispatch** | **≈ ₹73 Cr** | State Head Sale 2026-27 `1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs` (or SALE SHEET 26-27 `19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps`) |
| **Pending (booked − dispatched)** | **≈ ₹23 Cr** | derived |

## Fix: make the bridge affect ONLY the per-member level

Build the page in **three tiers**, each degrading independently:

1. **Company total** — works from the sheets alone. **Never blocked.**
2. **By State Head** — works from the sheets alone (`STATE HEAD` column is in Order Sheet).
   **Never blocked.** Apply the existing alias map (`BIJJU→Biju C.O`, `RIZVI JI→Syed Aqil Rizvi`,
   `PAWAN KUMAR→Pawan Sharma`, …); bucket `OTHER/PROJECT/GOVT/GEM/JJM` as **Non-territory**.
3. **By Team Member** — **this** is the only tier that needs the bridge. If the bridge isn't built,
   show *only this section* as "Distributor bridge not built — per-salesperson split unavailable",
   with a **"Build bridge"** action. Everything above it still renders.

**Also: by Distributor** works with no bridge at all (`Customer` is in the sheet) — show it.

**Never render ₹0.00 for data that exists.** If a figure genuinely can't be computed, show
"unavailable" with the reason — never a zero.

## Also check the period filter
The screenshot shows FY 2026-27 + "Full year" → ₹0.00. Full-year must return **all** FY26-27 rows to
date (≈₹96 Cr). If a period filter returns nothing, that's a bug, not an empty dataset.

## Expected per-head (FY2026-27 primary, ₹Cr) — use to verify
Sandeep 32.77 · Rizvi 13.04 · **Biju C.O 5.82** · Suresh Nair 2.91 · Non-territory 5.42 · Anant 2.57 ·
Babu 2.35 · Sulinder 2.12 · Pawan 1.90 · Lalan 1.80 · Nasir 0.99 · Sunil 0.80 · Anuj 0.73 → **₹73.22 Cr**
(that's the *dispatch* total; Order Booking is ≈₹96 Cr).
**Biju C.O must NOT be ₹0.00** — if it is, name normalisation is broken.

---

# BUG 2 — There is no **Secondary Performance** page

The sidebar has: State Head · Sales People · **Primary Performance** · Combined.
**A separate "Secondary Performance" page is missing.** Add it, between Primary Performance and Combined.

## Secondary Performance — its own page

**Transaction:** Distributor → **Retailer** (sell-out). **Unit: the retailer.**
**Source:** Secondary Order Booking — 25-26 `1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80` ·
24-25 `1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g` · 23-24 `1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY`
**Value column = `Sub Total`** (net). **Salesperson = `Team Member Name`** — already in the file, so
**no bridge is needed** for the per-person split here.

**FY2026-27: no file exists yet** → show "awaiting upload" (the upload feature handles it). **Default
the FY selector to 2025-26**, which is complete and works fully today.

**Content** (mirrors Primary, but retailer-centric):
- Tiles: Order Booking (net) · Retailers active · Orders · Achievement vs target
- **Baselines:** same month last year · own trailing 3-month avg · run-rate projection
  ⭐ The intra-month **pace curve comes from these daily order dates** (they're real order dates).
- **Leading indicators:** retailer churn (**list them by name**) · new retailers added · active retailers
  vs normal · order count · average order value · days since last order · retailer concentration
- Traffic light + ranked watchlist + alert feed
- Drill: State Head → Team Member → Retailer

**Verify FY2025-26 against:** total **₹240.14 Cr** · **240 members** · ~52,515 orders · 15,809 registered
/ ~8,467 active retailers · Sandeep **₹157.39 Cr** · **Biju C.O ₹5.55 Cr** · Sujan Ghata ₹4.72 Cr.

---

# SEASONALITY (both pages)
Apr 4.2 · May 8.2 · Jun 8.3 · Jul 7.3 · Aug 7.0 · Sep 7.4 · Oct 7.1 · Nov 8.5 · Dec 10.1 · Jan 10.1 ·
Feb 9.6 · **Mar 12.3** (% of annual). **March ≈ 2.9× April** — never compare consecutive months.

# ACCEPTANCE
- [ ] Primary Performance FY2026-27 shows **₹96 Cr / ₹73 Cr / ₹23 Cr** — **not ₹0.00** — with no bridge.
- [ ] By State Head and By Distributor render without the bridge. Only **By Team Member** is gated,
      and only that section.
- [ ] Biju C.O ≠ ₹0.00 on the primary state-head breakdown.
- [ ] A new **Secondary Performance** page exists, defaulting to FY2025-26, reconciling to ₹240.14 Cr /
      240 members.
- [ ] Nowhere does a real figure render as ₹0.00; unavailable data says why.

# WHAT NOT TO DO
- Do not block company/state-head primary figures on the bridge — the STATE HEAD column is in the sheet.
- Do not show ₹0.00 for data that exists.
- Do not merge Primary and Secondary into one page or one total (that's the Combined page's job, and
  even there they are never added).
