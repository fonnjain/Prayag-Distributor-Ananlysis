# State Head and Sales People
## Glossary, calculations and logic — version 2

*Merged from the implementation documentation and the verified findings. Four contradictions are resolved and flagged. Verified 31 July 2026.*

---

# Corrections in this version

| # | Implementation doc said | Resolution |
|---|---|---|
| **1** | "Secondary is a subset of Primary"; Coverage = Secondary ÷ Primary | **Wrong — different populations.** See Part 3 |
| **4** | Sales Deep Dive: Green ≥100 / Yellow ≥80 / Red <80 | **Conflicts with the State Head bands.** See Part 8 |

---

# Part 1 — What each page answers

| Page | Question | Unit |
|---|---|---|
| **State Head** | how is the company or one territory performing? | State Head |
| **Sales People** | how is each individual performing? | salesperson |

---

# Part 2 — The measures

| Term | Definition |
|---|---|
| **Primary Sales (Dispatched)** | goods invoiced by Prayag to distributors. Daily, via the SAP register chain into `sale_line` |
| **Primary Order Booking** | committed orders from distributors to Prayag. Order Sheet |
| **Secondary Order Booked** | orders taken by salespeople from retailers. State Head Dashboard |
| **Sales Received** | value received against those secondary orders |
| **Plan / Target Secondary** | the Plan column in the dashboard; fallback is the Target Master sheet |

**NET is Sub Total, never Order Total.**

---

# Part 3 — Primary and secondary are NOT nested

> **CORRECTION 1.** The implementation doc states *"Secondary is a subset of Primary"* and defines Coverage as Secondary ÷ Primary. **That is not correct.**

| | Flow | Population |
|---|---|---|
| **Primary** | Prayag → distributor | **includes** project and institutional business |
| **Secondary** | retailer → distributor | **excludes** it |

**Project alone is 164 customers — 35% of the FY2026-27 population, ₹6.08 Cr.** Secondary covers retailers that primary never sees as a line; primary covers a channel secondary never touches.

**Consequences:**

- **Never sum them.** The doc's prohibition is right, but because they are different populations, not because one nests inside the other
- **Secondary ÷ Primary is not a coverage percentage.** It divides two different populations. If the ratio is retained, it must be computed **excluding project and institutional business from the primary side**, and labelled as an approximation
- Each figure must state its basis. Primary and secondary will never reconcile, and neither is wrong

---

# Part 4 — Achievement

## Definition

```
Achievement = Sales Received ÷ Plan
```

> The raw Google Sheet often computes OB ÷ Plan. **The app ignores and recomputes it.** A per-member assertion checks the recomputed value against dashboard column AO and fires on mismatch.

**Sales Received must have its own tile.** Without it the arithmetic on screen cannot be reproduced — the card beside Achievement shows Order Booking, which is a different numerator.

## The order-booking definition

```
total OB = old party (P) + new party (Q) + direct dealer (J)
         = column I + column J
```

**Column I already equals P + Q.** Omitting new-party understated **116 of 170 active members**, one by 60 points, and moved 15 out of the RED band when corrected.

## Monthly and YTD

| | Formula |
|---|---|
| Monthly | Sales Received (month) ÷ Plan (month) |
| **YTD** | Σ Sales Received ÷ Σ Plan, **closed months only** |

**In-progress and sales-lag months are excluded from both sides.**

## Sales-lag

A **calendar-closed** month with Secondary OB entered and Sales Received zero. This is a **data-entry delay, not zero performance.**

Its plan **and** its sales both leave the ratio — the denominator is symmetric with the numerator. Where the ratio plan differs from the displayed plan, the card shows the basis: **"2 of 3 months recorded"**.

## Anomaly flag

Triggered when `Sales Received > Ordered Amount × 1.5` for a member-month. **Displayed but excluded from rankings.**

## Zero-target members

Show **"no target recorded"**, never 0%. Report **two** figures — headline, and like-for-like over targeted members only.

| | Headline | Like-for-like |
|---|---|---|
| Sandeep Dadheech, team | 62.3% | **58.7%** |
| Odisha | **107.0%** | 66.8% |

Odisha reads above target purely because one member contributes booking and no target.

---

# Part 5 — Periods

## YTD belongs to the current fiscal year only

For a closed year, year-to-date **is** the full year. **Derive the current FY from today's date** — 1 April to 31 March — never from a config list, so the rule moves on its own when the year turns.

| FY | YTD returns |
|---|---|
| FY2023-24 | ₹349.02 Cr (= Full Year) |
| FY2024-25 | ₹341.14 Cr |
| FY2025-26 | **₹361.00 Cr** |
| FY2026-27 | April to latest data |

**"Last 7 days" and "Today" are meaningless on a closed year** and must be hidden.

## YTD resolves per source

| Cards | Range | Reason |
|---|---|---|
| **Primary** | **Apr–Jul** | `sale_line` and the Order Sheet hold July |
| **Secondary** | **Apr–Jun** | last month with recorded actuals |

Adding July to the secondary side drops achievement from **76.2% to 57.6%** — a 19-point fall from a month with a ₹26.57 Cr plan and no actuals.

## Like-months

An apples-to-apples filter restricting primary sales to the same calendar months for which secondary sales exist. **Required for any primary-versus-secondary comparison.**

## Page capability

`FULL`, `FY_ONLY` or `NONE`. **Undeclared defaults to `NONE`.** A page whose source has no monthly breakdown shows its controls disabled **with the reason stated**.

**A period with a plan and no actuals reads "no actuals recorded yet"** — never 0%, and no low-performer count.

---

# Part 6 — Target splitting

| | Formula |
|---|---|
| With overrides | Period Target = Σ monthly overrides |
| Without | Period Target = Annual × Σ seasonal month weights |

Seasonal weights derive from **FY2025-26 actuals**.

> **Never pro-rate an annual target evenly.** Monthly plans differ genuinely — ₹24.94 Cr in April against ₹28.32 Cr in June.

---

# Part 7 — Sources and identity

## Monthly data

**Tab `SECONDARY ORDER BOOKING REPORT `** — note the **trailing space**. Members start row 7, 162 rows. **The TOTAL row is row 3, above the header**, and carries `#REF!` in K, L, M, O, P, Q, R, S — only I and J are valid.

```
7-column blocks, dated in row 4:
P Apr | W May | AD Jun | AK Jul | AR Aug | AY Sep | BF Oct | BM Nov | BT Dec | CA Jan
offsets: +0 Plan Amt  +1 Plan Cnt  +2 OB Amt  +3 OB Cnt  +4 % Ach  +5 Sales Amt  +6 Sales Cnt
```

**Locate blocks by the date in row 4**, never by hardcoded letters.

**The `Data` tab is cumulative-to-date only.** Any page reading it cannot produce a single-month figure and must say so.

## Member status

| Column | Holds |
|---|---|
| **BA** | **Active / Left** — 171 active, 12 LEFT company-wide |
| AZ | left date |
| **BD** | **elapsed months as a NUMBER** — 0.47 to 3.00. Read it, never derive it |
| AG | working days — 11 to 75 |

**LEFT members are excluded from current-period performance and low-performer counts, and never given a forward visit plan.** History is preserved.

> Excluding three departed members moved one team from **51.7% to 58.4%** — **organisational, not commercial.** Any report showing it must say so.

## Identity

- **`normSecKey`** — lowercase alphanumeric, **keeps** parentheticals. For database keys
- **`normName`** — **strips** parentheticals. For roster and HR joins

> **Mixing them is a live bug risk.** Stripping parentheticals merges *Ashutosh Kumar (Rudrapur)* under Anant Singh with *Ashutosh Kumar* under Sandeep Dadheech — **two different people.** Identity requires name **and** State Head **and** state **and** headquarter.

---

# Part 8 — Bands and thresholds

> **CORRECTION 4.** The Sales Deep Dive doc uses *Green ≥100 / Yellow ≥80 / Red <80*, which conflicts with the bands below. **A member at 60% would be Red on one page and Amber on the other.** Use one set across both pages — these, which are finer and match the low-performer threshold.

| Band | Range |
|---|---|
| Emerald | > 100% |
| Green | 90–100% |
| Yellow | 70–90% |
| Amber | 50–70% |
| Orange | 25–50% |
| Red | < 25% |
| **Muted** | **no target** — plan is null or zero |

**Low performer:** achievement < 50% (default) or < 25% (selectable). **Excludes primary-role and LEFT members.**

---

# Part 9 — Reading the page

**Check the data cutoff first**, not the sync time. *"Last synced 5:21 pm"* above data ending 30 June reads as current when it is not.

**Then the period label on each card.** Primary and secondary may legitimately differ.

**Then achievement with its denominator named.**

**Then Low Performers**, remembering it is period-scoped.

---

# Part 10 — Common misreadings

**"OB is ₹57.49 Cr and target ₹82.65 Cr, so achievement should be 69.6%."** Achievement uses **Sales Received** (₹62.95 Cr) → 76.2%.

**"Members is 181 in every period, so filtering is broken."** Headcount is not period-scoped. The *"no target"* count beside it does move.

**"Coverage is 65%, so a third of business bypasses the team."** Not necessarily — primary includes project and institutional business that secondary never covers.

**"This month shows 0.0%."** Check whether the month has actuals.

**"The two pages disagree."** Check measure and period.

**"Achievement jumped."** Check whether members left, or a calculation changed. Two such jumps in this project were organisational.

---

*Prayag Distributor Analysis · State Head and Sales People glossary v2 · verified 31 July 2026*
