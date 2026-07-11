# Prayag — Sales People Dashboard (spec)

A level below the State Head dashboards: pick a State Head → see their salespeople (with the shallow
second tier) → drill into each person's state / party / group / segment sales with FY-vs-FY growth &
share, plus Claude for per-rep narrative and comparative ranking. Live from Google Sheets.

---

## 1. Hierarchy (from the roster, resolved generically)

Source: **Team Member Details** (`1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2`) — 182 people, columns
`Name, Mobile, Email, State, Reporting Manager, Headquarter`.

Build the tree from `Reporting Manager`, don't hardcode:
- **State Head** = a person whose `Reporting Manager` is **blank** (the 10 field heads: Sandeep
  Dadheech ~70 reps, Aqil Rizvi ~33, Lalan Kumar ~14, Suresh Kumar Nair ~11, Pawan Kumar Sharma ~11,
  Biju C.O ~10, Anant Singh ~9, Sulinder Pal ~7, Nasir Hussain Khan ~4, Sunil Patel ~4).
- **Second tier** = a salesperson whose `Reporting Manager` is **another salesperson, not a head**
  (e.g. *Ritesh Thakur* reports to Sulinder Pal **and** manages *Jagdeep Singh*). Nest under them, so
  a branch can be **Head → senior rep → junior rep** (max 3 deep observed).
- Roll a rep's numbers **up** through their chain so a senior lead's view includes their own book +
  their juniors' (show "own" vs "team" split).
- Normalise names: strip `(Off Roll)`, `(Faridabad)`, trailing dots; case/space-insensitive match to
  Secondary Order Booking's `Team Member Name`. Log unmatched (target > 95%).

## 2. The person-level numbers come from SECONDARY (verified: register has no salesperson)

Source: **Secondary Order Booking Segment Wise** (folder `1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ`, tab
`Data Sheet`), which carries `Team Member Name` on every order line. Read via chunked `values.get`.
Columns (drift by year — detect by content): `Date, Retailer Id, Retailer, Order ID, Segment,
Cat. No., Qty, MRP, Order Value, Distributor, Discount, Sub Total, Order Total, Team Member Name`.

> Use **Sub Total (net after discount)** for all value metrics — same basis as targets (decided).
> Register (primary) is NOT used here; it has no salesperson.

## 3. Per-salesperson deep-dive (mirror the State-Head Report 1–7 logic, per person)

For each rep, and for a chosen period, compute (each with **This FY, Last FY, Difference, Growth %,
Share %**):
- **By State** — their working states.
- **By Party / Retailer** — top & bottom retailers; new vs old (first-order date); churned (ordered
  last FY, not this FY).
- **By Product Group** — canonical 7 groups via the INDEX map (`1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY`).
- **By Segment** — raw Segment values.
Plus headline tiles: Order booked (net), No. of orders, Active retailers, New retailers, Avg order
value, Business per retailer, Target & Achievement % (from Target Master when available).
Movers: top 5 growing / declining parties & segments (₹ and %).

## 4. FY coverage (same constraint as the mgmt report)

Secondary Order Booking exists **up to FY2025-26 only** — no FY2026-27 secondary file yet. So:
- FY2025-26 per-rep view is complete now (incl. vs FY2024-25).
- FY2025-26-vs-FY2026-27 per-rep comparison fills automatically once the 2026-27 secondary file is
  created (auto-discover from the folder). Do **not** substitute register numbers for the person view.

## 5. Claude analysis hooks

- **Per-rep narrative** ("explain this person's performance / coaching points"): send that rep's
  computed deep-dive JSON (states, parties, groups, segments, movers, targets) → Claude returns a
  short read: what's working, what's slipping, likely cause, 2–3 concrete coaching actions.
- **Comparative** ("rank & compare all reps under a head"): send the head's roster of reps with their
  key metrics (net sale, growth %, achievement %, active retailers, new-party %) → Claude ranks them,
  flags under-performers with the *why* (e.g. "high orders but low new-party acquisition"), and
  surfaces peer benchmarks within the same head/region.
- Ground every claim in the passed numbers; never invent. Net-after-discount basis throughout.

## 6. Verification

Reconcile per-head rollup of rep sales to the management dashboard anchors (same secondary source):
total FY25-26 ≈ **₹240 Cr**, Sandeep ≈ ₹157 Cr, Rizvi ≈ ₹45 Cr, etc. Σ(reps under a head) = head
total (± ₹1). Unmatched `Team Member Name` between secondary and roster listed, match > 95%.
