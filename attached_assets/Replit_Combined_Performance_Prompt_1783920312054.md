# Replit Agent Prompt — "Combined Performance" dashboard (Primary + Secondary, one view)

> Paste below the line. A **third** dashboard, alongside the Primary and Secondary ones. It shows the
> whole channel per salesperson. Do not disturb the other two.

---

## ⛔ RULE ZERO — "COMBINED" NEVER MEANS "ADDED"

Primary (₹361 Cr FY25-26) and Secondary (₹240 Cr FY25-26) are **the same goods at two stages of the
same channel**:

`Prayag → [PRIMARY] → Distributor → [SECONDARY] → Retailer`

**Adding them is double-counting.** ₹361 Cr + ₹240 Cr is not ₹601 Cr of anything. There must be **no
tile anywhere on this page that sums primary and secondary.** Combined means: shown **side by side**,
with the **relationship between them** derived.

## THE FOUR MEASURES (keep them distinct and labelled)

| # | Measure | Source | FY26-27 |
|---|---|---|---|
| 1 | **Primary Order Booking** (booked) | Order Sheet 26-27 `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A` | ₹96 Cr |
| 2 | **Primary Sale** (dispatched) | SALE SHEET / State Head Sale `1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs` | ₹73 Cr |
| 3 | **Pending Orders** = 1 − 2 | derived | ≈ ₹23 Cr |
| 4 | **Secondary Order Booking** (sell-out) | Secondary Order Booking (upload / Drive) | pending file |

## ⭐ THE POINT OF THIS PAGE — THE FUNNEL, PER SALESPERSON

For each rep, show the full channel as a funnel:

`Orders booked → Dispatched → Sold on to retailers → Retailers reached`

and derive the two numbers that **neither** other dashboard can produce:

### A. Sell-through ratio = Secondary ÷ Primary Sale
How much of what we shipped them did the distributor actually sell onward?

### B. Channel stock = cumulative Primary Sale − cumulative Secondary
How much stock is sitting in the channel, per distributor and per rep. *(Company-wide FY25-26:
₹361 Cr shipped vs ₹240 Cr sold onward — a large channel-stock position. Per rep, this separates a
genuinely strong performer from one who has borrowed from next quarter.)*

## ⭐ THE SIGNAL MATRIX (the core insight — implement exactly)

Classify every rep (and distributor) each period:

| Primary (sell-in) | Secondary (sell-out) | Verdict | Colour |
|---|---|---|---|
| ↑ up | → flat / ↓ down | **CHANNEL STUFFING** — stock piling at the distributor. Rep looks strong now, will crash when distributors stop reordering. | 🔴 red — **warn even though revenue looks good** |
| → flat / ↓ down | ↑ up | **DESTOCKING** — channel is clearing; a reorder is due. | 🟢 green — opportunity, flag it |
| ↓ down | ↓ down | **REAL DEMAND PROBLEM** — not a stock artefact. | 🔴 red |
| ↑ up | ↑ up | **HEALTHY GROWTH** | 🟢 green |

**This is the whole reason the page exists.** A rep with rising primary and flat secondary currently
looks like a star on the Primary dashboard. Here they show as **red**. Say so plainly in the UI.

Add: **rising channel stock + falling secondary → a correction is coming** (predict the drop before it
lands).

## COMPOSITE HEALTH SCORE (show reasons, never a bare number)
Blend: sell-through ratio · channel-stock trend · secondary growth vs own history · retailer coverage
& churn · distributor churn · pending-order ageing · target achievement. Always display the
contributing reasons alongside the score.

## PENDING ORDERS — keep it an OPS signal, not a sales signal
Booked but undispatched (≈₹23 Cr) is a **stock / credit-hold / logistics** issue. Show it in the funnel
(between "booked" and "dispatched") and in a **separate Fulfilment alert stream**. **Never** penalise
the salesperson's traffic light for it.

## SEASONALITY (same rule as the other two dashboards)
Month as % of annual: Apr 4.2 · May 8.2 · Jun 8.3 · Jul 7.3 · Aug 7.0 · Sep 7.4 · Oct 7.1 · Nov 8.5 ·
Dec 10.1 · Jan 10.1 · Feb 9.6 · **Mar 12.3**. **March ≈ 2.9× April.** Never compare a month with the
preceding month — compare with the **same month in prior years** and with the entity's own trend.

## ATTRIBUTION
- **Secondary** carries `Team Member Name` → direct.
- **Primary** carries only `Customer` (distributor) + `STATE HEAD` → needs the **Distributor → Team
  Member bridge** (folder `1-guQptN9S4NrW024jGizKo0V4nFDtHMv`, "Distributor Visit Report" tab).
- Both sides must be attributed to the **same** person for the ratios to mean anything. Where the
  bridge can't map a distributor, put it in **"Unassigned"** under its State Head and **exclude it from
  that rep's ratio** (rather than distorting it). Report the coverage %: *"sell-through computed on X%
  of this rep's primary."*

## DATA AVAILABILITY — be honest on screen
- **Primary FY2026-27: live** (₹96 Cr booked / ₹73 Cr dispatched).
- **Secondary FY2026-27: not yet uploaded.** Until it is, the sell-through and channel-stock metrics
  **cannot** be computed for the current year — show **"awaiting secondary data"**, not a zero, and
  **never** estimate it.
- **FY2025-26 has both** → the page works fully for that year today. Default to it so the logic can be
  validated now.

## LAYOUT
- **Company view:** funnel (booked → dispatched → sold-on → retailers), the signal-matrix quadrant with
  reps plotted, channel-stock trend, alert feed, ranked watchlist.
- **Drill:** State Head → Team Member → Distributor.
- **Per-rep:** their funnel, sell-through ratio vs their own history, channel-stock trend, signal-matrix
  verdict **in words**, composite score with reasons, recommendations.
- **Leaderboard** ranked by *channel health*, not raw revenue — so a channel-stuffer doesn't top it.
- Claude narrative per rep — grounded strictly in displayed numbers.

## VERIFICATION
- FY2025-26: Primary **₹361.14 Cr**, Secondary **₹240.14 Cr**, company sell-through ≈ **66%**.
- FY2026-27: Booking ₹96 Cr − Sale ₹73 Cr = Pending ₹23 Cr (must reconcile).
- **No tile anywhere sums primary + secondary.**
- A rep with no bridge coverage → "insufficient primary attribution", not a wrong ratio.

## WHAT NOT TO DO
- **Do not add primary and secondary together, anywhere, ever.**
- Do not show a sell-through ratio when secondary data for the period is missing — show "awaiting data".
- Do not rank reps by raw revenue on this page (that's what hides channel stuffing).
- Do not blame a rep for pending orders (fulfilment issue).
- Do not compare month-on-month without seasonality adjustment.
