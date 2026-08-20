# Catalogue-owner escalation: Water Tank coverage and unresolved product lines

**Audience:** maintainer of `prayag-price.com`'s product catalogue  
**Basis:** active authoritative-cache generation; FY 2026-27 current primary-sales register  
**Purpose:** catalogue correction only. No MRP, division, segment, or discontinued status should be guessed in the consuming application.

## Summary

| Question | Evidence |
| --- | ---: |
| Active source product rows | 6,223 |
| Active source rows with a non-null MRP | 6,222 |
| FY 2026-27 distinct register codes | 3,751 |
| Exact source-code misses before resolver rules | 694 |
| Resolved by leading `P` strip | 19 |
| Resolved by trailing colour suffix | 23 |
| Resolved by whitespace-only variation | 4 |
| Still unresolved by the strict resolver | 648 |

The strict resolver is deliberately limited to exact code, `P` + digits, a recognised trailing colour letter, and whitespace-only variation. It does not infer product identity.

## 1. Water Tank catalogue coverage

The source has **no `Water Tank` division**. It does contain 29 of the 40 Water Tank register codes, but classifies every one of those 29 as `Pipes & Fittings`. The remaining 11 codes are absent from the source and account for **₹1,17,42,752.06** of FY 2026-27 net sales. All 40 Water Tank register codes account for **₹5,80,84,128.90**.

### Requested source-owner action

1. Confirm whether Water Tank is intentionally represented as a Pipes & Fittings sub-line, or add an explicit Water Tank division/category.
2. Add the 11 absent codes below with MRP, effective date, division, active/discontinued status, and source-review lineage; alternatively mark each as discontinued with its effective date.
3. Confirm the correct source classification for the 29 present codes so consuming applications do not infer it.

| Register code | FY 2026-27 net (₹) | Source result |
| --- | ---: | --- |
| WT-3LL-10 | 80,46,122.54 | Present — Pipes & Fittings |
| WT-4LL-10 | 73,03,664.09 | Present — Pipes & Fittings |
| WT-4LC-07 | 45,03,754.00 | Present — Pipes & Fittings |
| WT-3LL-05 | 43,06,857.63 | Present — Pipes & Fittings |
| WCT-3LL-10 | 40,07,910.59 | **Absent** |
| WCT-3LL-05 | 36,65,472.47 | **Absent** |
| WT-4LC-10 | 27,90,090.00 | Present — Pipes & Fittings |
| WT-ISI-10 | 25,20,034.60 | Present — Pipes & Fittings |
| WT-4LL-05 | 23,12,136.59 | Present — Pipes & Fittings |
| WT-4LL-07 | 23,02,655.00 | Present — Pipes & Fittings |
| WCT-3LL-07 | 19,31,143.00 | **Absent** |
| WT-3LC-07 | 16,80,260.00 | Present — Pipes & Fittings |
| WT-3LL-07 | 15,92,936.00 | Present — Pipes & Fittings |
| WT-ISI-05 | 15,72,840.83 | Present — Pipes & Fittings |
| WT-3LC-10 | 12,82,142.00 | Present — Pipes & Fittings |
| WT-4LC-05 | 12,24,599.00 | Present — Pipes & Fittings |
| WT-3LC-05 | 11,75,310.00 | Present — Pipes & Fittings |
| WT-3LL-20 | 10,71,437.92 | Present — Pipes & Fittings |
| WT-4LWP-07 | 9,77,628.00 | **Absent** |
| WT-4LWP-10 | 6,10,147.00 | **Absent** |
| WT-ISI-50 | 5,43,683.90 | Present — Pipes & Fittings |
| WT-4LL-20 | 4,40,153.00 | Present — Pipes & Fittings |
| WT-3LL-30 | 4,06,860.81 | Present — Pipes & Fittings |
| WT-4LWP-05 | 4,06,285.00 | **Absent** |
| WT-ISI-20 | 3,44,517.20 | Present — Pipes & Fittings |
| WT-3LL-15 | 3,44,181.00 | Present — Pipes & Fittings |
| WT-3LL-50 | 1,43,999.73 | Present — Pipes & Fittings |
| WT-4LL-15 | 1,02,660.00 | Present — Pipes & Fittings |
| WT-ISI-15 | 94,492.00 | Present — Pipes & Fittings |
| WT-ISI-07 | 64,392.00 | Present — Pipes & Fittings |
| WT-ISI-30 | 50,464.00 | Present — Pipes & Fittings |
| WT-4LWP-20 | 43,802.00 | **Absent** |
| WT-3LC-03 | 41,093.00 | **Absent** |
| WT-3LC-20 | 39,796.00 | Present — Pipes & Fittings |
| WT-4LC-20 | 36,051.00 | Present — Pipes & Fittings |
| WT-4LL-50 | 31,248.00 | Present — Pipes & Fittings |
| WT-3LC-02 | 25,866.00 | **Absent** |
| WT-3LL-03 | 24,919.00 | **Absent** |
| WT-3LC-15 | 14,038.00 | Present — Pipes & Fittings |
| WT-3LL-02 | 8,486.00 | **Absent** |

## 2. Other product-line questions (109 codes)

These uploaded product-master records intentionally remain `UNMAPPED`; they must not be silently assigned to an existing application segment. They are the same catalogue-owner decision as the Water Tank classification question.

| Product line | Codes | Requested decision |
| --- | ---: | --- |
| Cockroach Traps & Gratings | 77 | Add catalogue division/segment and current price records, or confirm a canonical parent segment. |
| Manhole Cover | 10 | Add catalogue division/segment and current price records, or confirm a canonical parent segment. |
| Water Heater | 22 | Add catalogue division/segment and current price records, or confirm a canonical parent segment. |

### Cockroach Traps & Gratings (77)

`FT-02`, `FT-02 M`, `FT-03`, `FT-03 M`, `FT-04`, `FT-04 M`, `FT-05`, `FT-05 M`, `FT-06`, `FT-06 M`, `FT-07`, `FT-07 M`, `FT-08`, `FT-08 M`, `FT-20`, `FT-20 M`, `FT-21`, `FT-21 M`, `FT-22`, `FT-22 M`, `FT-23`, `FT-23 M`, `FT-24`, `FT-24 M`, `FT-25`, `FT-25 M`, `FT-27`, `FT-27 M`, `FT-28`, `FT-28 M`, `FT-29`, `FT-29 M`, `FT-30`, `FT-30 M`, `FT-31`, `FT-31 M`, `FT-32`, `FT-32 M`, `FT-42`, `FT-45`, `FT-45 M`, `FT-52`, `FT-52 M`, `FT-53`, `FT-53 M`, `FT-54`, `FT-54 M`, `FT-61`, `FT-61 M`, `FT-62`, `FT-62 M`, `FT-63`, `FT-63 M`, `FT-64`, `FT-64 M`, `FT-65`, `FT-65 M`, `FT-70`, `FT-70 M`, `FT-71`, `FT-71 M`, `FT-72`, `FT-72 M`, `FT-73`, `FT-73 M`, `FT-74`, `FT-74 M`, `FT-75`, `FT-75 M`, `FT-76`, `FT-76 M`, `FT-77`, `FT-77 M`, `FT-78`, `FT-78 M`, `FT-79`, `FT-79 M`.

### Manhole Cover (10)

`MHC-01`, `MHC-02`, `MHC-03`, `MHC-04`, `MHC-05`, `MHC-06`, `MHC-07`, `MHC-08`, `MHC-09`, `MHC-10`.

### Water Heater (22)

`1010`, `BROMO 10L G`, `BROMO 10L M`, `BROMO 15L G`, `BROMO 15L M`, `BROMO 25L G`, `BROMO 25L M`, `BROMO 35L G`, `BROMO 35L M`, `BROMO 50L G`, `BROMO 50L M`, `BROMO 6L G`, `BWH010`, `BWH015`, `NILE-03`, `PICO-03`, `PWH010`, `PWH015`, `PWH030`, `THERMA-15L G`, `THERMA-25L G`, `THERMA-50L G`.

## 3. Existing cross-system conflict: TTS-01 / TTS-02 / TTS-03

The consuming application must continue to retain both segment rows and require a decision. Do **not** select one silently. Please provide the authoritative division/segment and current MRP for each of `TTS-01`, `TTS-02`, and `TTS-03`, including whether they are legitimately multi-division products.