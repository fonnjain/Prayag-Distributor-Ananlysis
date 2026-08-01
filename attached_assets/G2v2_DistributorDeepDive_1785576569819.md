# Distributor Deep Dive
## Glossary, calculations and logic — version 2

*Merged from the implementation documentation and the verified findings. Verified 31 July 2026.*

---

# Read this first

**`customer_master` holds zero rows.** D1 requires a Confirmed-versus-Guessed split beside every distributor total. **That split has no source.** The grouping itself comes from the member sheets and is sound; the confidence guard around it does not exist.

**The direct-dealer entity filter is inoperative.** It matches `type_raw ILIKE '%direct%'`, but `type_raw` holds **product groups** — PTMT, C P, SINK. It returns zero for every fiscal year, silently. Direct dealers come from a **blank Assigned Distributor** on the member sheet.

---

# Part 1 — D1: retailer classification

| Field value | Term | Handling |
|---|---|---|
| a named distributor | normal supply route | group under `normDistKey` |
| **blank** | **Direct Dealer** | **parallel branch** under the State Head, never beneath a distributor |
| `--`, `-`, `–`, `—` | **None-Assigned** | a mapping failure — see Part 2 |
| comma-separated | **Shared Distributor** | a distinct relation to both, not a third distributor |
| numeric | malformed | exclude |

## `normDistKey`

```
.toUpperCase()
TRADERS      -> TRADE
ENTERPRISES  -> ENTERPRISE
remove non-alphanumeric
collapse spaces
```

A stable grouping key joining member sheets to primary sales data.

## Reconcile before aggregating

The blank group **must equal** that member's Direct Dealers Order on the dashboard. For Sandeep Dadheech's 71 active members that is **₹1,40,628, carried by one member.** A large blank group means the classification is wrong — not that undiscovered direct-dealer business exists.

## Distributor identity

Distributor names are **free text, typed independently by every salesperson.** Two records are the same only if the name matches **and** the state agrees **and** they do not appear as separate rows for the same period.

> **Never auto-merge on similarity.** Report candidates for confirmation. **A wrongly merged distributor produces a concentration figure that is simply false, and the numeric guard cannot catch it** — every individual number would be correct. Nine near-duplicate pairs were found in one territory.

---

# Part 2 — Assignment and activity

| | Anant Singh | Sandeep Dadheech |
|---|---|---|
| **With** a distributor, active | **96.0%** | 100% |
| **Without** one, active | **5.0%** | 16% |
| Ratio | **19×** | — |

**Unassigned correlation** — Pearson r between a member's unassigned share and their achievement:

| Territory | Members | r |
|---|---|---|
| Anant Singh | 10 | **−0.90** |
| Sandeep Dadheech | 66 | **−0.33** |

> **The retailer-level gap replicates. The member-level correlation does not.** −0.33 over 66 members is the more trustworthy estimate; −0.90 was likely overfit to ten points.

## Two readings — carry both

- **A retailer with no distributor has no route to order through** — the dormancy is a supply-mapping failure, not an effort failure
- **`--` may be written *when* a retailer goes dormant** — which reverses the causation

**The data cannot distinguish them.** Nineteen unassigned retailers did order, so this is a strong relationship rather than an impossibility.

> **100% named-active across seven states is too clean to accept.** Zero exceptions in 1,883 retailers suggests the variables are linked by construction. Find the exceptions or prove there are none.

---

# Part 3 — D2: flows

| Term | Definition |
|---|---|
| **Primary In-Flow** | goods Prayag sells to the distributor. `SUM(sale_line.amount)` where `version_status = 'current'` |
| **Secondary Out-Flow** | goods the distributor sells to retailers. Member sheets, or `secondary_register_line` for closed years |
| **Flow Gap** | primary dispatch − secondary out |
| **Primary OB** | `SUM(primary_order_line.taxable_value)`, **excluding Govt institutional orders** |
| **Pending** | primary OB − primary dispatch |
| **Fill Rate** | dispatch ÷ OB × 100 |
| **Days since last order** | today − `MAX(sale_line.invoiceDate)` |
| **YoY growth** | current closed months versus the **same calendar months** in the prior FY |

> **The flow gap has two readings and both must be stated:** stock building at the distributor, **or** business moving outside the attributed channel. **No distributor stock statements exist**, so they cannot be distinguished. **Never phrase it as an accusation.**

---

# Part 4 — Project exclusion

**Exclude `Non-territory / Project / Govt` from every territory baseline, gap and opportunity figure.**

| Segment | Gap before | After | Project share |
|---|---|---|---|
| HDPE | ₹32.65 Cr | ₹0.01 Cr | **100%** |
| PTMT | ₹6.14 Cr | ₹1.03 Cr | **83.2%** |
| CP | ₹7.73 Cr | ₹4.61 Cr | 40.4% |

**Project was 6% of revenue and 78% of apparent opportunity.**

## The signatures to recognise

**A gap concentrated in very few customers is not a territory opportunity.** HDPE's Q1 FY2023-24 was ₹25.40 Cr from **five** infrastructure contractors, all party type `HDPE PIPE`, all since exited.

**Rising customer count with falling volume per customer** means a product moved from stocked to spot — HDPE went from 5 distributors at ₹5.08 Cr each to 11 at ₹0.02 Cr. **A review signature, not a push one.**

---

# Part 5 — D3: SKU spread

| Term | Definition |
|---|---|
| **Brand canon** | finest granularity — e.g. `CPVC DURALIFE` |
| **Broad segment** | one of 17 categories, keyword-mapped (`TANK` → `WATER TANK`) |
| **HHI** | `Σ (brand_net ÷ total_net × 100)²`, 0–10,000 |
| **Cross-sell depth** | average distinct brand canons per retailer |
| **Range depth whitespace** | brands peers sell in segments this distributor already operates in |
| **Lost brand whitespace** | sold in the prior FY, absent in the current |
| **Peer whitespace** | brands peers sell that this distributor does not |

**Whitespace ranking:** range depth → lost brand → peer whitespace. Within a type, by peer net descending. **The same ease-of-execution logic as the SKU push list.**

---

# Part 6 — D4: investment, ROI and tiering

| Term | Definition |
|---|---|
| **Effective discount** | `(1 − netTotal ÷ grossTotal) × 100`, weighted |
| **Anomalous discount** | `discount_pct > 100` — **excluded from averages, flagged** |
| **Cost to serve** | distributor visits × member cost per visit |
| **Net-to-cost multiple** | secondary net ÷ visit cost to serve |

## Tier scoring — 100 points

| Component | Bands | Points |
|---|---|---|
| **Net** (30) | top 40% / mid / bottom / none | 30 / 18 / 8 / 8 |
| **Growth** (25) | >5% / 0–5% / −10–0% / <−10% | 25 / 18 / 10 / 5 |
| **Active ratio** (25) | >60% / 40–60% / <40% | 25 / 18 / 8 |
| **Discount** (20) | <40% / 40–50% / >50% | 20 / 12 / 5 |

| Tier | Score | Visit cadence |
|---|---|---|
| **A** | ≥ 70 | weekly |
| **B** | 45–69 | fortnightly |
| **C** | < 45 | monthly |

> **Net-to-cost is revenue efficiency, not profit.** Margin needs a finished-goods cost master that does not exist.

---

# Part 7 — D5: whitespace, and channel conflict

| Gap | Definition | Fix | Nature |
|---|---|---|---|
| **Coverage** | district has retailers, **no distributor at all** | strategic appointment | slow |
| **Assignment** | district has a distributor, some retailers unassigned | admin mapping | immediate |
| **Channel conflict** | direct dealers in a district that **has** a named distributor | commercial decision | — |

**Never merge coverage and assignment** — completely different fixes. Size both by prior-year booking, and report per state.

---

# Part 8 — D6: customer states

| State | This year OB | Last year sale |
|---|---|---|
| **Retained** | > 0 | > 0 |
| **Reactivated** | > 0 | = 0 |
| **At risk** | = 0 | > 0 |
| **Never** | = 0 | = 0 |

**At risk is not churn on a partial year.** The live year runs only to the cutoff.

---

# Part 9 — D7: capacity

```
Demanded per month = Σ (active count × tier rate)
   tier rates:  A 2.0/mo   B 1.0/mo   C 0.5/mo
Available per month = total YTD member visits ÷ months elapsed
Shortfall = demanded − available, when positive
```

**Use each member's own working days**, which range 11 to 75 — never a team average.

---

# Part 10 — Company-wide coverage

| State Head | Distributors | Retailers | Per distributor |
|---|---|---|---|
| Sandeep Dadheech | 63 | 4,804 | 76.3 |
| Syed Aqil Rizvi | 46 | 2,555 | 55.5 |
| Lalan Kumar | 10 | 1,114 | 111.4 |
| Biju C.O | 69 | 976 | 14.1 |
| Anant Singh | 22 | 790 | 35.9 |
| **Nasir Hussain Khan** | **0** | 139 | **no distributors** |
| **Prashant Onam Naik** | 23 | **0** | **no secondary coverage** |
| **Total** | **269** | **11,338** | 42.1 |

## Three populations — never added together

| Card | Counts | Value |
|---|---|---|
| **Channel Partners** | distributors only | **269** |
| **Secondary Retail Reach** | column K per member | **11,338 — a sum, NOT deduplicated** |
| **Retailers** | registered master | **18,117** |

**At least 6,779 registered retailers — 37.4% — have no secondary coverage.** Because 11,338 is not deduplicated, the true figure is higher.

> **269 against 318 transacting distributors.** The gap is concentrated, not spread — Sulinder Pal alone shows 3 against 27. That points at master maintenance, not a definitional difference.

The spread of **14 to 111 retailers per distributor** is an eight-fold range — establish whether the counts measure the same thing before any tiering work.

---

# Part 11 — Blocked

| Blocked | Reason |
|---|---|
| Confirmed-versus-Guessed mapping | **`customer_master` holds zero rows** |
| Direct-dealer entity filter | **`type_raw` holds product groups** — returns zero every FY |
| Live-year retailer SKU and discount | no FY2026-27 secondary register |
| Margin per distributor | no finished-goods cost master |

**State the reason. Never show zeros.**

---

*Prayag Distributor Analysis · Distributor Deep Dive glossary v2 · verified 31 July 2026*
