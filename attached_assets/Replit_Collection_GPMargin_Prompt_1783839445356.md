# Replit Agent Prompt — Wire the Collection source + add a GP Margin view

> Paste below the line. Two new live Google Sheets sources, both verified. They unlock the
> **Sale & Collection** report (previously impossible) and a **new Margin view** (cost data exists
> after all). Other dashboards untouched.

---

## SOURCE 1 — COLLECTION / DEBTORS  → completes the "Sale & Collection" report

**`PARTY O/S & PAYMENT`** — a daily payment ledger. This is the collection feed that was missing.

```
files_by_year: {
  "2026-27": "1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok",
  "2025-26": "1por9tFeT4jeRFc16rRW_S4z3Hk00t6zvlr840246zpA"
}
```

**Verified layout** (first tab; header on row 1, data from row 2):

| Col | Field | Example |
|---|---|---|
| A | DATE | `01-Apr-26` |
| B | PARTY NAME | `SAJAN TRADING COMPANY` |
| C | **AMOUNT** (payment received) | `100000` |
| D | Month | `Apr-26` |
| E | Type | `Pymt` |
| F | STATE (with area code) | `UP ( R )`, `MAHARASTRA L` |
| G | **STATE HEAD** | `RIZVI JI`, `SANDEEP JI`, `LALAN` |
| H | flag | `1` |

Notes: the sheet has **side blocks to the right** (a per-party detail block and a State-Head→email
contact table) — **ignore anything past column H**; only the A–H ledger is data. Filter to `Type =
Pymt`. State Head values use the register's short names (`BIJJU`, `RIZVI JI`, `PAWAN KUMAR`) → apply
the existing `head_alias.json` normalisation. `GOVT / GEM / JJM / PROJECT / OTHER` appear as heads →
bucket as **Non-territory**, as elsewhere.

**Use it for:**
- **Sale & Collection report** (the tab that was blank): monthly rows = **Sale (with GST)** vs
  **Collection**. Collection = Σ AMOUNT by month (and by State Head / party as drilled).
  *Sale-with-GST* = the register's taxable value **× (1 + GST)** — verified: Sunil Patel Apr register
  taxable ₹1,075,897 vs the file's Sale-with-GST ₹1,269,558.46 (≈18%). Prefer a real GST-inclusive
  figure if one exists; otherwise compute taxable × 1.18 and **label it "computed"**.
- New **Collections / Receivables** tiles: collection by month, by State Head, by party; collection
  vs sale (collection efficiency %); top overdue parties.

## SOURCE 2 — GP MARGIN sheets  → new Margin view

~40 monthly sheets named **`<GROUP> SALE GP MARGIN <Month> <FY>`** (PTMT, CP, PLUMBING, GARDEN PIPE,
WASTE PIPE & CONNECTION). Examples: `PTMT SALE GP MARGIN APR 25-26` =
`1cp-VO_VkPovrCPW5UCgi4aKLhniQEsu7CzXwdQJ9yE0`; `PTMT SALE GP MARGIN MAY 25-26` =
`1kKI8J0YO316N4XIFpcGA2s_s9MDcx_6glZgTBuQQw6M`; `CP SALE GP MARGIN Apr25-26` =
`1JcT5ykcrlefG6fytXNKFmUgHRJiyRPyHspdz95CcmxI`; `PLUMBING SALE GP Margin Apr 25-26` =
`1GS-M-k8hvrSKJKG372eZXy8J-nhfpc6ny94DRNRJs9g`.

**Do not hardcode 40 ids.** Discover them: Drive `files.list` with
`name contains 'GP MARGIN' or name contains 'GP Margin'`, then parse **group** and **month/FY** from
the title (handle the messy spacing/case in the real names).

**Verified layout** (header ≈ row 4; a totals row sits *above* it — skip it):

`S.NO · CODE · QTY · WEIGHT · TOTAL WEIGHT · MRP · Discount · AVG SALE · BOM COST ·
Sale Value As Per Avg Sale Rate <FY> · Sale Value As Per Bom <FY> · Avg Sale Rate <prevFY> ·
Bom Cost <prevFY> · Growth % New Bom Cost VS Old Bom Cost · Growth % Avg Rate <prevFY> VS <FY>`

**Derive:**
- `Gross Profit = Sale Value (Avg Sale Rate) − Sale Value (BOM)`
- `Margin % = GP ÷ Sale Value (Avg Sale Rate)`
- Join on **`CODE`** (item code) — same key as the register/rate list, so margin can be attached to
  item, group, and (via the register) to state/party/State Head.
- Also expose: Discount %, Avg Sale Rate vs prior FY, BOM cost vs prior FY (cost inflation).

### ⚠️ LABEL THIS CORRECTLY — it is NOT net profit
`BOM COST` is the **bill-of-materials (raw-material) cost only** — not fully loaded (no labour,
overhead, freight, or discount-to-trade). PTMT Apr 25-26 computes to ≈**81% margin**, which is a
**contribution margin**, not profitability. In the UI call it **"Gross Margin (BOM basis)"** with a
tooltip stating it excludes overheads. Never present it as net profit or company profitability.

## UI
- **Sale & Collection**: complete the existing report tab per State Head / salesperson — monthly Sale
  (with GST) vs Collection, plus collection-efficiency %.
- **New "Margin" view** (under Products or its own page): margin by product group × month; item-level
  table (Qty, MRP, Discount %, Avg Sale, BOM cost, GP, Margin %); cost-inflation flags (BOM cost up
  YoY); lowest-margin / highest-discount items. Basis label on every figure.

## ACCEPTANCE
- [ ] Collection reads from `PARTY O/S & PAYMENT` (A–H only, `Type=Pymt`), head names normalised,
      institutional bucketed; Sale & Collection tab populates monthly for FY2026-27 and FY2025-26.
- [ ] Sale-with-GST clearly labelled if computed (taxable × 1.18) rather than sourced.
- [ ] GP Margin sheets auto-discovered by title (not hardcoded); group + month parsed; header row
      detected by content (totals row above it skipped).
- [ ] Margin view shows GP and Margin % by group/month/item, joined on CODE.
- [ ] Margin is labelled **"Gross Margin (BOM basis) — excludes overheads"**, never "profit".
- [ ] No `files.export`; chunked `values.get`; other dashboards untouched.

## WHAT NOT TO DO
- Do not read past column H in the collection sheet (side blocks are not data).
- Do not treat BOM-basis margin as net profit, and do not blend it into the sales dashboards as
  "profitability".
- Do not hardcode the ~40 GP Margin file ids — discover them.
- Do not use the rate list for cost (it's unreliable); BOM COST in these sheets is the cost source.
