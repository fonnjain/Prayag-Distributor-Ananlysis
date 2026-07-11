# Replit Agent Prompt — Add a "Sales People" deep-dive dashboard (with Claude)

> Paste below the line. New page in the existing app; do not touch the other dashboards.
> Live Google Sheets are the source. If a live sheet can't be read, fall back to an uploaded
> copy of the same file (see "Fallback").

---

## GOAL

A **Sales People** dashboard one level below the State Head dashboards: choose a State Head → see
their salespeople (with the shallow second tier) → drill into each person's **state / party / group /
segment** sales with **FY-vs-FY growth & share**, plus **Claude** for per-rep narrative and
comparative ranking. Same look/feel as the existing dashboards.

## HIERARCHY (build from the roster, generically — don't hardcode)

Roster = **Team Member Details** `1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2`
(cols `Name, Mobile No., Email Id, State, Reporting Manager, Headquarter`; 182 people).
- **State Head** = person with **blank Reporting Manager** (10 heads).
- **Second tier** = a salesperson whose Reporting Manager is another salesperson (not a head) —
  e.g. *Ritesh Thakur* → Sulinder Pal, and *Ritesh Thakur* manages *Jagdeep Singh*. Nest under them
  (tree can be Head → senior rep → junior rep, up to 3 deep). Resolve by following `Reporting Manager`
  links.
- A lead's view = **own book + rolled-up juniors**, shown as "Own" vs "Team".
- Normalise names (strip `(Off Roll)`, `(Faridabad)`, trailing dots; case/space-insensitive) before
  matching to Secondary Order Booking `Team Member Name`. Log unmatched (>95% target).

## SALES DATA = SECONDARY ORDER BOOKING (register has NO salesperson — verified)

Source: `Secondary Order Booking Segment Wise`, folder `1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ`, tab
`Data Sheet`. Read via chunked `values.get` (NO `files.export`; ~8 MB). Header names drift by year
(`Retailer Id`↔`ID`, `Team Member Name`↔`Team member`) — detect by content; forward-fill repeated
order header cells. Files:
```
files_by_year: { "2025-26":"1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80",
                 "2024-25":"1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g",
                 "2023-24":"1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY" }
```
**Use `Sub Total` (net after discount) for all value metrics** (targets are net). Never use the
primary register for the person view.

## PER-SALESPERSON DEEP-DIVE (mirror the State-Head Report 1–7 logic, per person)

For the selected rep + period, compute — each with **This FY / Last FY / Difference / Growth % /
Share %**:
- **By State**, **By Party/Retailer** (top & bottom; new vs old by first-order date; churned),
  **By Product Group** (canonical 7 via INDEX map `1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY`),
  **By Segment**.
- Headline tiles: Net order booked, No. of orders, Active retailers, New retailers, Avg order value,
  Business per retailer, Target & Achievement % (Target Master if present).
- Movers: top 5 growing / declining parties & segments.

## FY COVERAGE
Secondary exists only **up to FY2025-26** (no FY2026-27 file yet). Build FY2025-26 (vs FY2024-25) now;
auto-discover and fill FY2026-27 when its file appears in the folder. Do NOT substitute register
numbers for the person view.

## CLAUDE (both modes)

Add `POST /api/salesperson/analyze`:
- **narrative** `{ mode:"narrative", rep, fy }` → send that rep's deep-dive JSON; Claude returns
  what's working, what's slipping, likely cause, and 2–3 concrete coaching actions.
- **compare** `{ mode:"compare", stateHead, fy }` → send all reps under that head with net sale,
  growth %, achievement %, active retailers, new-party % ; Claude ranks them, flags under-performers
  **with the why**, and notes peer benchmarks within the head.
Ground every statement in the passed numbers; net-after-discount basis; no invented figures.
Reuse the existing Claude/Anthropic wrapper; keep the key server-side.

## UI
Route `/sales-people`. Left: State Head picker → collapsible rep tree (second tier nested). Main:
selected rep's tiles + the four growth tables (State/Party/Group/Segment) + movers; a "Own vs Team"
toggle for leads; an "Explain this rep" button (narrative) and, at head level, a "Rank my team"
button (compare). FY selector (default 2025-26). Build server-side; stream reads; no browser storage.

## VERIFICATION
Add `GET /api/salespeople/verify?fy=2025-26`: Σ(reps under a head)=head total (±₹1); head rollup
reconciles to the mgmt anchors (total ≈ ₹240 Cr; Sandeep ≈ ₹157 Cr; Rizvi ≈ ₹45 Cr; Lalan ≈ ₹13.25;
Anant ≈ ₹9.86; Biju ≈ ₹5.55). List unmatched Team Member names (roster ↔ secondary), match > 95%.
Surface as a small "Data health" panel.

## FALLBACK (if a live sheet can't be read)
If a Drive read fails (403/404/timeout), surface the real reason, and support an **uploaded copy** of
the same file (Secondary Order Booking / roster) placed in an `uploads/` folder or object storage —
read it with the same content-based parser so the dashboard still populates. Never silently blank.

## ACCEPTANCE
- [ ] Rep tree built from Reporting Manager, second tier nested, Own vs Team split correct.
- [ ] Per-rep State/Party/Group/Segment tables with FY-vs-FY growth & share populate from Secondary
      Order Booking (net) for FY2025-26.
- [ ] Claude narrative and compare endpoints return grounded, number-cited output.
- [ ] Verify endpoint reconciles head rollups to the anchors; >95% name match; unmatched listed.
- [ ] No `files.export`; chunked reads; net-after-discount basis; other dashboards untouched.
- [ ] FY2026-27 person view blank + noted until its secondary file exists (no register substitution).

## WHAT NOT TO DO
- Do not use the primary register for per-salesperson numbers (no salesperson column).
- Do not hardcode the hierarchy; resolve it from Reporting Manager.
- Do not mix gross MRP into value metrics; use Sub Total (net).
- Do not fabricate FY2026-27 secondary data.
