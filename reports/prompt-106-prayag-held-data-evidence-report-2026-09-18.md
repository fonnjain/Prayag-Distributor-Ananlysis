# Prompt 106 — Prayag questions answered from held data

**Run date:** 18 September 2026  
**Scope:** Read-only. No data was loaded, corrected, resolved, or written to the Resolution register.  
**Databases:** Replit PostgreSQL development and production databases. Production figures are identified explicitly.  
**Archives:** Held files in `attached_assets`, including the 26 August analysis export, MRP reconciliation files, Resolution register exports, and the June margin archive.

## Executive result

| Verdict | Count | Meaning |
|---|---:|---|
| ANSWERED | 2 | The factual test can be answered from held data, although a separate management action may remain. |
| NARROWED | 17 | The investigation is reduced to a specific confirmation or missing authoritative input. |
| NEEDS PRAYAG | 11 | The answer is a business decision, source meaning, or missing export held only by Prayag. |
| NEEDS SOURCE MAPPING | 3 | Prompt 106 omitted the original wording, so these cannot safely be classified. |

The 33-question numbering is incomplete in Prompt 106. Q14, Q21 and Q22 are not defined. Q24, Q26 and Q29 were reconstructed from the 14 September Resolution register.

## Important corrections to the starting assumptions

1. **The 64 PEA codes cannot reveal a February-versus-August step from sales.**  
   Source: production/development `sale_line_current`, all current rows through 17 September 2026. None of the exact 64 codes sold from February through August 2026. Fourteen first appear in September. PEA-44B has no sale row. The master inconsistency remains, but sales cannot date it.

2. **Ravi Upadhyay and Shiv Kumar are not completely inactive in FY2026–27.**  
   Source: development `secondary_order_line`. Ravi has 3 rows worth ₹11,405 on 29 May 2026; Shiv has 24 rows worth ₹57,883 on 30 May 2026. They may still lack plan and primary-sale rows, but “no order booking” is false.

3. **The “870 unpriced codes” are codes sold in FY2026–27 but absent from, or unpriced in, the active authority—not a catalogue population containing never-sold items.**  
   Source: production `sale_line_current` joined to active-generation `mrp_synced`. Therefore the “no sales this FY” and “never sold” classes are zero by construction.

4. **The current distributor-code backlog is smaller than the historic 130.**  
   Source: development `retailer_distributor` and `distributor_identity`. The current unresolved distinct-name population is 52. Parenthetical-stripped name comparison produces 19 exact candidates, one additional similarity ≥0.80 candidate, eight possible 0.60–0.79 candidates, and 24 weak candidates. These are proposals only.

## Tests and verdicts

### Q1 — PTMT cost, January–April 2026

**Test requested:** recompute each month from `ANUJ SIR BOM..`, `OLD BOM`, `NEW BOM`, and `NEW BOM APR 2026`.

**What held data shows**

- Prompt 106 records 34,369 component rows and 230 common codes from `ANUJ SIR BOM..`.
- Recomputed ÷ reported: Dec-25 1.37×, Jan-26 3.15×, Apr-26 2.77×, Jun-26 1.07×.
- The Resolution evidence gives median BOM costs across 191 common codes: Nov ₹32.16, Dec ₹30.98, Jan ₹12.92, Feb ₹12.72, Mar ₹13.49, Apr ₹14.82, May ₹34.85, Jun ₹39.66.
- Correcting the level would move April PTMT margin from 86.47% to about 65.5%.
- The workbook containing the four named tabs is not present in the workspace or listed held ZIP archives, so the version-by-month extension cannot be reproduced.

**Source:** Prompt 106 supplied computation; 14 September Resolution register; held archive inventory.  
**Verdict:** **NARROWED.** Direction is established: Jan–Apr cost is understated.  
**Remaining decision:** Which BOM version is authoritative for Jan–Apr 2026, and should those four months be corrected upward?

### Q2 — 64 PEA codes: 1 February or 10 August?

**Test requested:** monthly realised amount per piece for the exact 64 codes.

**What held data shows**

- The authoritative file carries `effective_date = 2026-02-01` and the note “Revised on 10th Aug, 2026.”
- PEA-44B changes from ₹479 to ₹1,528 in the source evidence.
- Exact-code query against `sale_line_current`: zero sales for these codes during Feb–Aug 2026; 14 codes first sell in Sep-26; PEA-44B has no sale.

**Source:** held MRP reconciliation and production/development `sale_line_current` through 17 September 2026.  
**Coverage:** exact 64-code list; all current sale rows.  
**Verdict:** **NARROWED.** Sales cannot distinguish the two dates because there is no sale exposure during the disputed interval.  
**Remaining decision:** Confirm whether the 64-code revision legally took effect on 1 February or 10 August 2026.

### Q3 and Q4 — missing exports

**Test:** locate the requested exports in held archives.

**What held data shows:** the exports named by the original questions are absent from the workspace inventory. Prompt 106 does not reproduce their exact names.

**Source:** held workspace and archive inventory.  
**Verdict:** **NEEDS PRAYAG.**  
**Remaining decisions:** provide each missing export in the requested period/schema.

### Q5 — FY2024–25 re-export

**What held data shows:** 28,613 rows retain day/month ambiguity after the partial correction. The annual total remains ₹216.00 Cr, but monthly attribution is unsafe.

**Source:** Resolution register H3 and held FY2024–25 diagnostics.  
**Verdict:** **NEEDS PRAYAG.**  
**Remaining decision:** re-export FY2024–25 dates in an unambiguous agreed schema.

### Q6 — distributors with no code

**Test requested:** normalize names, strip parentheticals, rank coded candidates, then add state/head/customer evidence.

**What held data shows**

- Historic source: 399 names, 130 blank codes, ₹6.52 Cr unattributed.
- Current development tables: 52 unresolved distinct distributor names.
- Top name candidate quality: 19 exact after parenthetical stripping, 1 additional ≥0.80 similarity, 8 possible 0.60–0.79, 24 weak.
- Examples of exact candidates include `Rashmi Enterprises (Non Active)` → `Rashmi Enterprises`, `Sharma Traders (Not Working)` → `Sharma Traders`, `Somarwal Tiles & Sanitoaryware (Non Active)` → the same coded spelling, and `Vishal Ceramic (Non Active)` → `Vishal Ceramic`.
- State/head/customer confirmation was not available for every historical row, so no candidate was auto-matched.

**Source:** development `retailer_distributor` and `distributor_identity`; historic Resolution register.  
**Verdict:** **NARROWED.**  
**Remaining decision:** confirm the 20 high-confidence candidates, review 8 possible candidates, and create/retire records for the 24 weak unmatched names.

### Q7 — 870 unpriced/absent-authority codes

**Classification rule:** production FY2026–27 gap codes; “declining” means Aug quantity is zero or below 70% of the May–July monthly average. Sep is excluded because it is partial.

| Class | Codes | FY2026–27 value |
|---|---:|---:|
| Still selling, steady | 328 | ₹5.19 Cr |
| Selling, declining | 542 | ₹5.85 Cr |
| No sales this FY | 0 | ₹0 |
| Never sold | 0 | ₹0 |
| **Total** | **870** | **₹11.04 Cr** |

**Source:** production `sale_line_current` joined to active-generation `mrp_synced`; current rows through 17 September 2026.  
**Coverage:** all 870 production FY2026–27 authority-gap codes.  
**Verdict:** **ANSWERED as a classification; action remains.**  
**Remaining decision:** price the 328 steady sellers first; decide whether the 542 declining sellers need prices or controlled retirement.

### Q8 and Q9 — website catalogue intent and September go-live

**What held data shows:** codes 20, 25 and 32 are live on the website but invalid/absent in the authoritative master. The website labels 2,409 products with the September authority version while showing older prices.

**Source:** 14 September Resolution register and held website/MRP reconciliation.  
**Verdict:** **NEEDS PRAYAG.**  
**Remaining decisions:** confirm whether codes 20/25/32 are valid items; confirm the production go-live date for 1 September prices.

### Q10–Q12 — disputed organisation ownership

**Tests:** order activity, customer counts, and servicing volume by named people.

**What held data shows**

- Exact `secondary_order_line.sales_user_name` searches returned no Sunil Mohanty, Pawan Kumar Sharma, or Narendra Kumar Sharma rows.
- Sunil Mohanty remains absent from employee, coverage, registry, and order-user evidence.
- Both Rajasthan assignments remain open in the organisation evidence; 354 customers were unassigned at the source date.
- Karnataka’s winner-take-all attribution was decided by only six source rows and is not a reliable ownership rule.
- Maharashtra source-pack evidence maps recorded territories L/R/S to different heads, which describes work performed but not normative ownership.

**Source:** development `secondary_order_line`, person/coverage evidence, and Resolution register.  
**Verdict:** **NARROWED.** The held order-user data does not support assigning the disputed ownership automatically.  
**Remaining decisions:** confirm Sunil’s employment/scope; name the authoritative Rajasthan owner; approve explicit Karnataka and Maharashtra ownership.

### Q13 — which 58 names are former employees?

**Test requested:** first/last month, value and inactivity.

**What held data shows**

- The historic aggregate is 25,575 FY2025–26 order-booking rows worth ₹13.51 Cr against 58 names absent from the then-current roster.
- The exact frozen 58-name list is not stored in the Resolution evidence.
- A fresh broad name-vs-current-registry query produces a much larger population because roster aliases, off-roll labels and later departed-person imports have changed; substituting that population would be misleading.
- The database now has 181 `departed_import` persons, proving that later remediation changed the population.

**Source:** 14 September Resolution register; development `person`, `person_registry`, and `secondary_order_line`.  
**Verdict:** **NARROWED.** The aggregate is confirmed, but the original 58-row annex cannot be faithfully reconstructed from the frozen evidence.  
**Remaining decision:** provide/confirm the original 58-name roster comparison and classify each as former, off-roll-current, or alias.

### Q14

Prompt 106 does not state Q14 and the available register mapping is not unambiguous.

**Verdict:** **NEEDS SOURCE MAPPING.**  
**Remaining decision:** identify the original Q14 wording and linked Resolution item.

### Q15 — round WT tank prices

Eight new WT prices are round figures and retrospectively dated. Data cannot distinguish an approved round price from a placeholder.

**Source:** Resolution register P28 and held MRP history.  
**Verdict:** **NEEDS PRAYAG.**  
**Remaining decision:** confirm whether the eight WT prices are approved and state their effective date.

### Q16 and Q18 — label meanings

The database can show where a label appears but cannot establish the author’s intended meaning.

**Source:** Resolution register/source semantics.  
**Verdict:** **NEEDS PRAYAG.**  
**Remaining decisions:** define each label and its operational treatment.

### Q17 and Q26 — colour prices

**Test requested:** compare realised prices for sold colour variants.

**What held data shows**

- Current production `item_master_variant`: 121 multi-colour codes with different master MRPs, close to the historic 123 after source evolution.
- Only 10 have at least two colours represented in current sale rows.
- Of those 10, 7 have a realised-price spread greater than 5%; 3 are within 5%.
- One price per code is therefore not adequate for every product, but sale colour coverage is only 10/121.

**Source:** production `item_master_variant` and `sale_line_current`, current rows through 17 September 2026.  
**Verdict:** **NARROWED.** The data disproves a universal single-price assumption, but coverage is insufficient to set every colour price from realised sales.  
**Remaining decision:** approve colour-specific website prices where the source master carries different colour MRPs; define fallback for rows without captured colour.

### Q19 — are WCT and WT the same product?

| Pair | WCT customers | WT customers | Common | WCT realised ₹/piece | WT realised ₹/piece |
|---|---:|---:|---:|---:|---:|
| 3LL-05 | 42 | 281 | 19 | 2,155.54 | 2,238.54 |
| 3LL-07 | 34 | 184 | 13 | 3,223.60 | 3,355.64 |
| 3LL-10 | 45 | 291 | 21 | 4,382.39 | 4,464.27 |

WCT starts in June 2026, but WT continues selling through September 2026. Prices are close, and many WCT customers also bought the matching WT code, but the periods overlap. This is not a clean rename where one code stops and the other starts.

**Source:** development `sale_line_current`, current rows through 17 September 2026.  
**Verdict:** **NARROWED.** Strong evidence supports a related/alias product, but disproves a simple non-overlapping rename.  
**Remaining decision:** confirm whether WCT and WT are concurrent aliases of one physical tank or intentionally distinct variants.

### Q20 — six ambiguous product codes

**What held data shows**

- `824XD` → `824-XD`, `824SD` → `824-SD`, and `924XD` → `924-XD` are unique exact matches after hyphen removal. Each candidate has the same catalogue family/name; the candidate code itself has no separate sale history.
- Source realised prices are ₹1,421.67, ₹1,570.75 and ₹1,914.64 per piece respectively.
- `HD140B`, `HD160B`, and `HD200B` each have only one selling customer and many same-size catalogue suffix candidates. Customer overlap is zero or unavailable, so price/customer evidence cannot identify a unique suffix.

**Source:** development `sale_line_current` and `mrp_current_catalogue`.  
**Verdict:** **NARROWED.**  
**Remaining decision:** confirm the three hyphen-only sink mappings; provide the suffix/description for HD140B, HD160B and HD200B.

### Q21 and Q22

Prompt 106 does not state these questions, and mapping them to P21/P22 would confuse two numbering systems.

**Verdict:** **NEEDS SOURCE MAPPING.**  
**Remaining decision:** provide the original Q21/Q22 wording or explicit Resolution codes.

### Q23 — Maharashtra territories

Recorded order-book spellings and row volumes:

| Recorded spelling | Rows |
|---|---:|
| MAHARASTRA L | 6,201 |
| MAHARASTRA R | 3,664 |
| MAHARASTRA S | 124 |
| **Total** | **9,989** |

**Source:** held order-book reconciliation report and State Head source-pack mapping.  
**Verdict:** **ANSWERED for actual recording:** the source records three territories, L/R/S.  
**Remaining decision:** confirm whether all three are official and approve canonical `MAHARASHTRA` spellings.

### Q24 — “Unchanged — carried forward”

The source contains 61 such items; 58 have differing old/new prices and U70 rises 39%. The phrase’s intended business meaning cannot be inferred.

**Source:** held MRP reconciliation and Resolution register P24.  
**Verdict:** **NEEDS PRAYAG.**  
**Remaining decision:** define whether “unchanged” permits a changed price and identify the authoritative date/value.

### Q25 — Ravi Upadhyay and Shiv Kumar

**What held data shows:** contrary to the original premise, both have FY2026–27 secondary order rows: Ravi 3 rows/₹11,405 and Shiv 24 rows/₹57,883, both in May 2026.

**Source:** development `secondary_order_line`.  
**Verdict:** **NARROWED.** They are not wholly inactive; missing plan/sale rows may still indicate a scope or roster problem.  
**Remaining decision:** confirm whether both remain plan-carrying employees and whether May order activity should map to their monthly rows.

### Q27 — September SAP: 604 against about 700

Production currently contains 449 distinct September invoices, 2,049 lines and ₹4.76 Cr through 17 September, source `sheets`. This does not prove receipt of the missing SAP batch and does not close the historic 604-versus-~700 reconciliation.

**Source:** production `sale_line_current`, loaded through 17 September 2026.  
**Verdict:** **NARROWED / still open.**  
**Remaining decision:** provide the next SAP export or confirm the authoritative September invoice count and reconciliation basis.

### Q28 — correct spelling

Observed variants can be enumerated, but correctness is a master-data decision.

**Verdict:** **NEEDS PRAYAG.**  
**Remaining decision:** approve canonical spellings and aliases.

### Q29 and Q30 — eight PS codes

The exact codes are PS1106, PS1606, PS5157, PS5163, PS5171, PS5657, PS5763 and PS7506. No exact-code sale exists in current `sale_line_current`.

**Source:** Resolution register P29; production/development `sale_line_current`.  
**Verdict:** **NARROWED.** Absence of sale supports retirement but does not establish intended catalogue status.  
**Remaining decision:** confirm these eight codes discontinued or identify replacement code spellings.

### Q31 — 70 discontinued codes still selling

The “70” is a historic source-list population. The active authority has evolved, so the exact 70-code annex is not recoverable from the current authority generation without the original frozen list.

**Source:** 14 September Resolution evidence; current production `mrp_synced`.  
**Verdict:** **NARROWED.**  
**Remaining decision:** provide/confirm the frozen 70-code list, then approve active exceptions or retirement dates.

### Q32 — 15 `-VB` codes

The development active authority previously contained 15 `-VB` codes marked `unchanged`; the production active generation no longer exposes that population. The original register says they were in `excluded_do_not_load` without price/date.

**Source:** development `mrp_synced`; production `mrp_synced`; Resolution register.  
**Verdict:** **NARROWED.** The environment difference itself requires an authority decision.  
**Remaining decision:** confirm whether `-VB` codes are active sellable variants and which authority generation should contain them.

### Q33 — whether a price move was intended

Data can show that a move occurred, not whether it was intended.

**Verdict:** **NEEDS PRAYAG.**  
**Remaining decision:** confirm intent and effective date for the Q33 price move.

## Resolution register

No register item was changed. Prompt 106 explicitly requires reporting before any register write. Recommended post-approval actions:

- Resolve or mark answered only the Q7 classification and Q23 observed-territory fact.
- Add evidence notes, without resolving, to Q1, Q2, Q6, Q17/Q26, Q19, Q20, Q25, Q27 and Q29–Q32.
- Keep all business-intent/source-semantic items open.

## Method limitations

- The four BOM tabs required for Q1 are not held locally.
- Prompt 106 does not include the original full 33-question pack.
- Current master and identity generations have advanced since the 14 September snapshots; this report reports the drift rather than forcing current rows into historic populations.
- Realised price is `SUM(amount) / SUM(qty)` from current sale rows. It is evidence of commercial level, not MRP.
- The Q7 “steady/declining” threshold is an explicit analytical rule, not a Prayag policy.