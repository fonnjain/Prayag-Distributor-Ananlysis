# Prompt 107 — Finish what Drive cannot answer

**Run date:** 18 September 2026  
**Scope:** Read-only. No source, database, MRP-resolution logic, or Resolution-register row was changed.  
**Standing rule:** every figure below identifies its database or source.

## Executive conclusions

1. **Colour prices are held, and `sale_line_current` already carries colour.** No invoice/item join is required.
2. **The reviewed 118-code master cohort is reproduced exactly from the attached authoritative workbook.** Production contains 107 of those codes with FY2026–27 sales.
3. **There are no IVORY sale rows among those 118 codes.** The 107 selling codes total ₹5.56 Cr in production through 17 September, but ₹5.54 Cr is explicitly WHITE and ₹2.10 lakh is one unknown-colour row (`.`). The current measurable colour-price correction is therefore ₹0, not a positive rupee amount.
4. **The colour issue remains a real structural risk.** At least one live discount surface resolves one MRP per code and is not colour-aware. If IVORY rows are later captured, that surface would use the wrong list value unless the resolver changes.
5. **The frozen 58-name and historic 130-name distributor annexes are not retained in held evidence.** Current populations have changed and must not be substituted.
6. **WCT and WT are distinct concurrent SKUs, not a rename.** The three WCT codes sold ₹1.22 Cr from June through 16 September while matching WT codes continued selling.
7. **The 31 post-discontinuation sellers are reproduced exactly for FY2026–27:** ₹11.38 lakh. Only three continue into July/August; the other 28 stop by June.

---

## Section A — colour-price gap

### A1. Does `sale_line` carry colour?

Yes.

- `sale_line_current.color` is populated from the Sale register.
- The current view contains only `version_status='current'` rows.
- Because colour is on the sale row itself, no separate invoice/item join is required.

**Source:** production and development PostgreSQL `sale_line_current`; schema source `lib/db/src/schema/salesRegister.ts`.

### A2. Exact 118-code cohort and FY2026–27 colour split

The exact cohort was rebuilt from:

`attached_assets/Prayag_MRP_Authoritative_v2_01Sep2026_1788848674782.xlsx`, sheet `products`

Rule: `mrp_ivory > mrp`. This returns exactly **118 products**, with ivory premiums from **10.0% to 48.1%**, matching Prompt 107.

Production sales for these exact 118 codes:

| Recorded colour | Selling codes | Lines | Quantity | Net sale value |
|---|---:|---:|---:|---:|
| WHITE | 106 | 1,789 | 44,044 | ₹5,53,74,850.39 |
| IVORY | 0 | 0 | 0 | ₹0 |
| Other/unknown | 1 | 1 | 60 | ₹2,09,698.00 |
| **Total** | **107** | **1,790** | **44,104** | **₹5,55,84,548.39** |

The one other/unknown row is code `4381`, colour `.`, quantity 60, value ₹2,09,698, invoice date 31 May 2026, customer `PRAYAG MARKETING (KERALA)`.

**Source:** production PostgreSQL `sale_line_current`, FY2026–27 current rows through 17 September 2026; cohort prices from the attached authoritative MRP workbook.

**Why the value differs from ₹5.41 Cr:** Prompt 107’s Drive result is a dated snapshot. Production advanced through 17 September and now contains ₹5.56 Cr for the same 118-code cohort.

### A3. Discount correction

For every sale row with known colour:

- Legacy list value = quantity × base `mrp` (white).
- Correct list value = quantity × the matching colour price.
- Discount = 1 − net sale value ÷ list value.

Result for the exact 118-code cohort:

| Basis | Mapped quantity | Mapped net | List value | Discount |
|---|---:|---:|---:|---:|
| Current base-white resolution | 44,044 | ₹5,53,74,850.39 | ₹13,41,55,650.00 | 58.72% |
| Colour-aware resolution | 44,044 | ₹5,53,74,850.39 | ₹13,41,55,650.00 | 58.72% |
| **Difference** |  |  | **₹0** | **0.00 percentage points** |

The unknown `.` row is excluded from the corrected calculation because assigning WHITE or IVORY would invent a colour.

Examples:

| Code | White MRP | Ivory MRP | FY2026–27 recorded colour | Quantity | Net value | Correctable difference |
|---|---:|---:|---|---:|---:|---:|
| 4031 | ₹4,680 | ₹6,290 | WHITE only | 221 | ₹4,74,964 | ₹0 |
| 4302 | ₹10,780 | ₹13,640 | WHITE only | 154 | ₹7,55,876.39 | ₹0 |
| 4521 | ₹9,980 | ₹11,940 | WHITE only | 19 | ₹80,286 | ₹0 |

**Source:** production `sale_line_current`; attached authoritative workbook `products`.

**Conclusion:** the proposition “every ivory sale is understated” is mathematically true, but the held production register contains no ivory sale in this 118-code cohort. A live rupee understatement is not established.

### A4. Existing discount/realisation surfaces

The explicitly verified affected surface is:

- SKU Deep Dive Discounts UI.
- API endpoint `/api/sku/discounts`.
- Backend `skuK4` calculation: `(mrp × qty − amount) / (mrp × qty)`.

That logic resolves an authoritative/effective MRP per code but not per colour.

Other surfaces using MRP, discount, price realisation, price-shrinker or Laspeyres calculations require a propagation audit before any implementation: SKU overview/focus, customer rankings, comparison, GP margin, AI reports, distributor reports and exports.

**Source:** application source search; `artifacts/api-server/src/lib/sku/skuK4.ts` and `artifacts/prayag/src/components/sku/SkuDiscounts.tsx`.

### A5. What colour-aware MRP resolution requires

Report-only recommendation:

1. Normalize exact colour vocabulary:
   - `WHITE` → WHITE
   - `IVORY` → IVORY
   - `WHITE WITH JET` variants → WHITE_WITH_JET
   - `PINK`, `GREEN`, `P.GREEN`, `BLUE` → PINK_GREEN_BLUE only where the source master explicitly groups them
   - blank or `.` → unresolved, not WHITE
2. Resolve each sale line by exact code, effective date and normalized colour.
3. Precedence:
   - exact colour variant
   - approved grouped-colour variant
   - base/white only for explicit WHITE
   - unresolved for missing/unmapped colour
4. Return resolution method, MRP source, effective date and coverage flags with every aggregate.
5. Centralize the line-level resolver so every discount/realisation surface uses the same basis.
6. Fail closed on conflicting variant prices; never choose `MAX(mrp)`.

No MRP-resolution change was made.

---

## Section B — the 58 names

The frozen fact remains:

- 58 names absent from the then-current roster.
- 25,575 FY2025–26 order-booking rows.
- ₹13.51 Cr.

**Source:** Resolution register dated 14 September 2026.

The exact 58-name list is not retained in that register export or any held annex. Current reconstruction is unsafe because:

- aliases and off-roll labels changed;
- the database now contains 181 `departed_import` persons;
- current roster comparison yields a different, larger population.

Therefore B1–B3 cannot be truthfully produced without the frozen 58-name list or the dated roster used to create it. Any fresh list would answer a different question.

**Verdict:** the aggregate is confirmed; the per-person annex and class counts remain unavailable.

### Ravi Upadhyay and Shiv Kumar

| Name | FY2025–26 exact activity | FY2026–27 secondary order activity | Last activity | Prompt-107 class |
|---|---:|---:|---|---|
| Ravi Upadhyay | None | 3 rows, ₹11,405 | 29 May 2026 | active within roughly 3 months |
| Shiv Kumar | None | 24 rows, ₹57,883 | 30 May 2026 | active within roughly 3 months |

There is no exact `person` or `member_targets` row for either name. `Shiv Kumar Patel` is a different person and was excluded.

**Source:** development PostgreSQL `secondary_order_line`, `person`, and `member_targets`.

**Conclusion:** this is a roster/plan mapping question, not evidence that both have departed.

---

## Section C — distributor matching

Historic finding:

- 399 distributor names.
- 130 without code.
- ₹6.52 Cr unattributed.

**Source:** Resolution register P30 dated 14 September 2026.

The exact historic 130-name/value snapshot is not retained. The current development junction has 52 unresolved distinct names, showing that remediation or source evolution has occurred.

Current name-only candidate quality after stripping parentheticals, punctuation and case:

| Candidate class | Current names |
|---|---:|
| Exact after stripping | 19 |
| Strong similarity ≥0.80 | 1 |
| Possible 0.60–0.79 | 8 |
| Weak/no plausible match | 24 |
| **Current unresolved total** | **52** |

These cannot be promoted to final matches because same-state, same-head, customer overlap and comparable order-pattern evidence are not available at the same frozen historic grain.

**Source:** development `retailer_distributor` and `distributor_identity`; held distributor/retailer upload CSVs.

**Verdict:** do not replace “130” with “52” in the historical register. Record that the live backlog is 52 only after a fresh, separately versioned reconciliation.

---

## Section D — six ambiguous codes

### Evidence summary

| Source code | Sale period | Customers | Realised ₹/piece | Strongest evidence |
|---|---|---:|---:|---|
| 824XD | 17 Apr 2024–16 Sep 2026 | 93 | 1,421.67 | Legacy `item_master` has exact 824XD at MRP ₹3,340; current authority has 824-XD at ₹3,340 |
| 924XD | 23 Apr 2024–31 Aug 2026 | 68 | 1,914.64 | Exact legacy code MRP ₹4,450; current 924-XD MRP ₹4,449.60 |
| 824SD | 23 Apr 2024–31 Aug 2026 | 27 | 1,570.75 | Exact legacy code MRP ₹3,540; current 824-SD MRP ₹3,540 |
| HD140B | 30 Apr 2025–8 Sep 2026 | 1 | 375.00 | Exact legacy code MRP ₹966; many same-size suffix candidates, no customer evidence |
| HD160B | 6–8 Sep 2026 | 1 | 499.53 | Exact legacy code MRP ₹1,267; many suffix candidates |
| HD200B | 4–5 Sep 2026 | 1 | 802.95 | Exact legacy code MRP ₹1,972; many suffix candidates |

**Source:** development `sale_line_current`, `item_master`, and `mrp_current_catalogue`, through 17 September 2026.

### Ranked recommendations

1. `824XD → 824-XD`: high confidence punctuation alias; exact MRP equality and product-family identity.
2. `824SD → 824-SD`: high confidence punctuation alias; exact MRP equality and product-family identity.
3. `924XD → 924-XD`: high confidence punctuation alias; ₹0.40 MRP rounding difference and family identity.
4. HD140B, HD160B and HD200B: **do not map**. The exact codes already exist in the legacy item master, each has only one customer, and the many current suffix candidates lack customer/period evidence. Recommend restoring/confirming these exact B-suffix codes in the authority.

No code was auto-matched.

---

## Section E — smaller confirmations

### E2. September SAP invoice gap

The gap is not closed by held evidence.

- Production September source `sheets`: 449 distinct invoices, 2,049 rows, ₹4.76 Cr.
- Data through 17 September 2026.
- This is not the missing SAP batch and cannot reconcile the historic 604-versus-about-700 count.

**Source:** production `sale_line_current`.

**Remaining decision:** provide the next SAP export or the authoritative September invoice-count basis.

### E3. Thirty-one codes selling after discontinuation

The authoritative workbook has 61 codes discontinued on 20 January or 1 February 2026. Exactly 31 sold in FY2026–27:

- Quantity: 4,516.
- Net value: ₹11,37,661.52.
- Three continue into July/August.
- Twenty-eight stop by June.

Monthly pattern:

| Month | Distinct codes | Quantity | Net value |
|---|---:|---:|---:|
| Apr-26 | 12 | 327 | ₹1,78,628.00 |
| May-26 | 25 | 3,742 | ₹9,25,303.52 |
| Jun-26 | 4 | 400 | ₹7,316.00 |
| Jul-26 | 2 | 7 | ₹4,842.00 |
| Aug-26 | 2 | 40 | ₹21,572.00 |

Persistent exceptions:

| Code | FY2026–27 pattern | Value | Assessment |
|---|---|---:|---|
| BEA-103A | Apr 50, May 149, Aug 30 | ₹1,12,203 | Still active; discontinuation is doubtful |
| BS-65 | Apr 20, May 130, Jul 2 | ₹56,729 | Fading tail |
| BS-28 | Apr 15, Jul 5, Aug 10 | ₹22,864 | Low-volume but still active |

The other 28 have no July/August sale and form a fading/closed tail rather than steady selling.

**Source:** production `sale_line_current`; discontinued dates from attached authoritative MRP workbook.

#### Full 31-code FY2026–27 annex

| Code | Monthly quantity after 1 April | Last sale | Net value |
|---|---|---|---:|
| BEA-108 | May 620 | 31 May | ₹3,43,516.88 |
| C235L | May 140 | 20 May | ₹1,18,615.64 |
| BEA-103A | Apr 50; May 149; Aug 30 | 31 Aug | ₹1,12,203.00 |
| C234L | May 170 | 20 May | ₹70,130.00 |
| BEA-30 | Apr 100; May 10 | 31 May | ₹57,502.00 |
| BS-65 | Apr 20; May 130; Jul 2 | 18 Jul | ₹56,729.00 |
| C233L | May 170 | 20 May | ₹45,572.00 |
| BS-27 | Apr 20; May 50 | 31 May | ₹40,383.00 |
| BS-110 | Apr 20; May 10 | 30 May | ₹37,981.00 |
| C231L | May 450 | 20 May | ₹36,686.00 |
| C232L | May 230 | 20 May | ₹32,964.00 |
| C122 | May 930 | 31 May | ₹28,886.00 |
| BS-28 | Apr 15; Jul 5; Aug 10 | 19 Aug | ₹22,864.00 |
| BHS-2001 | Apr 30 | 30 Apr | ₹19,278.00 |
| BOS-50SQ | Apr 20; May 15 | 23 May | ₹16,092.00 |
| C123 | May 290 | 31 May | ₹15,968.00 |
| BOS-47SQ | Apr 40; May 12 | 31 May | ₹15,205.00 |
| BOS-102SS | May 20 | 23 May | ₹12,421.00 |
| BOS-49SQ | Apr 10; May 24 | 23 May | ₹9,309.00 |
| BS-306 | May 20 | 23 May | ₹7,111.00 |
| GB-02 | May 10 | 31 May | ₹6,131.00 |
| BS-81 | May 5 | 30 May | ₹5,269.00 |
| BS-105 | May 20 | 23 May | ₹5,041.00 |
| GB-01 | May 7 | 31 May | ₹4,034.00 |
| U123 | May 100; Jun 25 | 20 Jun | ₹3,480.00 |
| U121 | Jun 300 | 26 Jun | ₹3,386.00 |
| U122 | May 150; Jun 25 | 20 Jun | ₹2,746.00 |
| U125 | Jun 50 | 26 Jun | ₹2,724.00 |
| BS-102 | May 10 | 28 May | ₹2,526.00 |
| GB-03 | Apr 1 | 30 Apr | ₹2,471.00 |
| BA-17 | Apr 1 | 30 Apr | ₹437.00 |
| **Total** | **4,516 pieces** |  | **₹11,37,661.52** |

### E4. WCT monthly pricing evidence

| Code | Month | Quantity | Net value | Realised ₹/piece |
|---|---|---:|---:|---:|
| WCT-3LL-05 | Jun | 605 | ₹13,14,663.79 | 2,173.00 |
|  | Jul | 974 | ₹20,76,836.00 | 2,132.28 |
|  | Aug | 466 | ₹10,08,213.76 | 2,163.55 |
|  | Sep partial | 66 | ₹1,50,636.00 | 2,282.36 |
| WCT-3LL-07 | Jun | 185 | ₹6,03,681.00 | 3,263.14 |
|  | Jul | 391 | ₹12,51,629.00 | 3,201.10 |
|  | Aug | 126 | ₹4,01,761.00 | 3,188.58 |
|  | Sep partial | 36 | ₹1,21,948.00 | 3,387.44 |
| WCT-3LL-10 | Jun | 330 | ₹14,29,153.12 | 4,330.77 |
|  | Jul | 487 | ₹20,86,926.47 | 4,285.27 |
|  | Aug | 325 | ₹14,71,918.47 | 4,528.98 |
|  | Sep partial | 50 | ₹2,35,816.42 | 4,716.33 |

Exact code totals are ₹45,50,349.55, ₹23,79,019.00 and ₹52,23,814.48 respectively, or **₹1,21,53,183.03** across the three WCT codes.

The corresponding WT codes remain active through September. There are 21 same-customer/same-month intersections and 16 distinct customers buying WCT and a WT product in the same month.

**Source:** development `sale_line_current`, source marker `sheets`, through 17 September 2026.

**Conclusion:** remove the WCT→WT rename candidates. WCT requires its own MRP confirmation.

### E5. Eight PS codes

Codes: PS1106, PS1606, PS5157, PS5163, PS5171, PS5657, PS5763 and PS7506.

- No exact-code FY2026–27 sale.
- No exact-code FY2025–26 sale was found.
- No approved alias/replacement mapping exists.

**Source:** production/development `sale_line_current`; code list from Resolution register P29.

**Conclusion:** sales evidence supports non-use but does not prove intended discontinuation. Ask Prayag to confirm retirement or replacement spellings.

---

## Section F — proposed register revisions

No register changes were made. The following is the report-before-write recommendation.

### F1. PEA codes

**Recommended:** lower priority from URGENT to LOW and note zero sales during the disputed Feb–Aug interval.  
**Caution:** the statement “1 February is the list version, not the effective date” comes from the Drive/MRP review; sales do not independently prove it.

### F2. WCT/WT candidate mapping

**Recommended:** remove all three candidate mappings from P4 immediately in the next approved write. Record that WCT begins in June 2026 and sells concurrently with WT. Do not resolve P4; replace it with a request for WCT prices.

### F3. Missing-code classification

Record the Drive-reviewed finding:

- 780 genuinely missing codes, ₹9.68 Cr.
- 70 already discontinued, ₹20.15 lakh.
- First tranche: CP 303 codes/₹3.09 Cr; Sink 91 codes/₹2.17 Cr.

**Source:** Prompt 107’s reviewed Drive/MRP result. The row-level annex was not re-derived from the current database.

### F4. New colour-price entry

Recommended wording:

> 118 codes have ivory prices 10.0%–48.1% above white in the authoritative MRP workbook; 107 sold ₹5.56 Cr in production through 17 September. Production records WHITE for 106 codes and unknown `.` for one; no IVORY row exists. Current measured discount correction is ₹0, but SKU discount logic is not colour-aware and colour coverage must be fixed before ivory discounts can be trusted.

Owner should be internal data/engineering first, then Prayag only for unresolved colour vocabulary or source-master conflicts.

### F5. “Unchanged — carried forward”

Record the Drive-reviewed result that 500 of 2,175 rows are inconsistent, with differences up to 89%, and that the label is not a reliable pricing rule.

**Source distinction:** this is supplied by Prompt 107’s Drive/MRP review. Earlier held Resolution evidence covered a narrower 61-row population, of which 58 changed and U70 changed 39%.

---

## Required next inputs

1. Frozen 58-name annex or the dated roster used to generate it.
2. Frozen historic 130-distributor-name annex with value/customer lineage.
3. Next September SAP export.
4. Prayag confirmation of the three WCT prices.
5. Prayag confirmation for the three HD B-suffix codes and the eight PS codes.

Until those arrive, no historical population should be reconstructed from newer identities and no ambiguous product code should be auto-matched.