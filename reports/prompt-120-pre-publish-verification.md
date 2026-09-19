# Prompt 120 — Pre-Publish Verification Report

**Date:** 19 September 2026  
**Status:** GitHub push verified; ready for publication. H2 remains open pending production checks 1–5 and C5.

## 1. GitHub push verification

origin/main now points to:

    6da8bfa8b5289bde3f6cbc6c47d8606d0293e8a7 refs/heads/main

This remote commit contains:

- ea2ef9e3bc8e42b41aff1768fec7d41b2fbc56e8 — Prompt 120 implementation
- a1222798 — Prompt 119 publish marker
- ff0548f — Prompt 119 August data and adapter work

## 2. B1 — Outside-5% breakdown

The production database has moved since the original 553 codes / ₹3.88 Cr observation:

- History-backed rows only: ₹3.63 Cr
- Current active-catalogue fallback included: 645 codes, 5,572 rows, ₹4.78 Cr

That movement is the closed-month instability addressed by C1–C3.

### Largest history-backed groups

| Master category | Sub-category | MRP source | Effective | Codes | Value | Median ratio |
|---|---|---|---|---:|---:|---:|
| C.P. 5000 SERIES | CP | New CP MRP w.e.f. 01 Aug 2026 | 1 Aug | 83 | ₹1.06 Cr | 0.9144 |
| C.P. 6000 SERIES | CP | New CP MRP w.e.f. 01 Aug 2026 | 1 Aug | 85 | ₹1.00 Cr | 0.9228 |
| C.P-CDA | CP | New CP MRP w.e.f. 01 Aug 2026 | 1 Aug | 77 | ₹68.92 L | 0.9026 |
| C.P. 7000 SERIES | CP | New CP MRP w.e.f. 01 Aug 2026 | 1 Aug | 120 | ₹38.40 L | 0.9137 |
| C.P. 8000 SERIES | CP | New CP MRP w.e.f. 01 Aug 2026 | 1 Aug | 53 | ₹21.31 L | 0.9086 |
| C.P. 9000 SERIES | CP | New CP MRP w.e.f. 01 Aug 2026 | 1 Aug | 25 | ₹13.37 L | 0.9089 |
| PTMT SYMET | PTMT/Faucets | PTMT MRP 5 Mar 2026 | 5 Mar | 36 | ₹5.31 L | 1.1607 |
| PTMT SYMET | PTMT/Faucets | New CP MRP 1 Aug 2026 | 1 Aug | 2 | ₹2.38 L | 0.9286 |
| Sanitaryware | Sanitaryware | Sanitaryware MRP 1 May 2026 | 1 May | 8 | ₹2.29 L | 1.1514 |
| UPVC Aquafresh | UPVC | Pipe & Fitting MRP 1 Feb 2026 | 1 Feb | 6 | ₹1.90 L | 2.0213 |
| SWR Draintech | SWR | Pipe & Fitting MRP 1 Feb 2026 | 1 Feb | 8 | ₹1.62 L | 2.0850 |

### Rows now affected by the active API fallback

| Category | Declared effective date | Codes | Value | Median ratio |
|---|---|---:|---:|---:|
| S. Steel Sink | 1 Sep 2026 | 41 | ₹61.87 L | 0.9266 |
| Water Tanks | 1 Feb 2026 | 3 | ₹20.42 L | 1.2500 |
| PVC Garden Pipe | 1 Sep 2026 | 32 | ₹18.69 L | 0.9256 |
| UPVC Aquafresh | 10 Aug 2026 | 25 | ₹11.97 L | 0.7597 |
| Cockroach Traps & Gratings | 1 Sep 2026 | 24 | ₹1.30 L | 0.9438 |
| CPVC Duralife | 10 Aug 2026 | 2 | ₹0.22 L | 0.9311 |

After Prompt 120 is published, August uses its transaction-date generation instead of today's active catalogue.

## 3. B2 — 1 August revision

- 438 outside-5% codes were revised effective 1 August 2026.
- 437 of 438 still have modal CRM implied MRP within 0.5% of the previous mrp_history price.
- 292 codes match the previous price exactly to the cent.
- August Product-Wise value: ₹3,50,86,059.

This strongly supports the finding that the CRM largely continued using the pre-revision price after the 1 August revision.

### Code 5306

| Measure | Value |
|---|---:|
| Previous history price | ₹1,040 |
| 1 August catalogue price | ₹1,140 |
| CRM modal implied MRP | ₹1,040 |

No figures were changed because of this finding.

## 4. C5 stability comparison

C5 must run after publication because production needs the immutable-generation migration and transaction-date fallback first.

1. Take a production B3 snapshot immediately after publication and migration verification.
2. Take a second snapshot at least one hour later.
3. Compare rows, codes and values field by field.

H2 remains open until C5 and production checks 1–5 pass.

## 5. D2 — Unresolved employee codes

After excluding the deterministic HR-resolved Ashutosh Kumar case:

| Employee code | Sales User Name | Rows | Value |
|---|---|---:|---:|
| 396 | SHAIK JANI BASHA | 345 | ₹17,00,809 |
| 341 | K.V.THAMIZHSELVAN | 353 | ₹13,70,253 |
| 340 | JITHENDER REDDY KATUKURI | 214 | ₹7,49,625 |
| 350 | PAWAN KUMAR | 66 | ₹4,69,566 |
| NJ-6 | BASHARAT MAJEED MAGLOO | 31 | ₹4,44,284 |
| 429 | TANINKI RAMESH BABU | 78 | ₹3,12,837 |
| 616 | SAMIR SENGUPTA | 46 | ₹1,29,146 |
| NJ-7 | ABHISHEKGOUD .K. PATIL | 3 | ₹23,170 |
| NJ-5 | KRISHNA KUMAR K | 1 | ₹5,364 |
| **Total** | | **1,137** | **₹52,05,054** |

None were guessed or automatically assigned.

## 6. D4 — Head-name variants

### Proposed mappings — not applied

| Variant | Proposed canonical name |
|---|---|
| Aqil Rizvi | Syed Aqil Rizvi |
| Pawan Sharma | Pawan Kumar Sharma |
| Narendra Sharma | Narendra Kumar Sharma |

### Aqil and Sandeep

| Registry state-head name | Rows | Value |
|---|---:|---:|
| Aqil Rizvi | 2,837 | ₹1.056 Cr |
| Syed Aqil Rizvi | 3,305 | ₹1.900 Cr |
| Combined Aqil | 6,142 | ₹2.956 Cr |
| Sandeep Dadheech | 9,707 | ₹9.129 Cr |

Development already resolves the two Aqil variants together at ₹2.956 Cr. The variants explain an Aqil label split, but do not by themselves explain a ₹1.65 Cr transfer from Sandeep to Aqil. The remaining offset involves person-registry identity linkage and territory/member attribution.

### Pawan

- secondary_head_month uses Pawan Sharma and reports ₹0.
- Product-Wise identity resolution maps 524 rows / ₹29,57,156 to Pawan Kumar Sharma.

The name variant explains the visible ₹0 versus ₹29.57 L discrepancy because the two independent sources use different canonical head names.

### Narendra

Narendra Sharma and Narendra Kumar Sharma both exist in the registry, and no common alias currently merges them. Current production evidence has no corresponding non-zero August secondary_head_month row, so this is an identity-risk mapping but does not explain the measured Sandeep/Aqil offset.

## 7. D5 — Sandeep's three August numbers

| Surface | Observed | Attribution basis |
|---|---:|---|
| Distributor Deep Dive | ₹11.70 Cr | Retailer/customer to distributor attribution from member working-sheet/distributor mapping |
| Sales Deep Dive Product-Wise | ₹9.21 Cr | Product-Wise secondary_order_line.basic_order_value through employee/person/member identity |
| E table | ₹9.17 Cr | secondary_head_month.ordered_amount matched to the Sales Deep Dive member roster |

### Why ₹11.70 Cr differs from ₹9.21 Cr

They use different attribution systems. ₹11.70 Cr follows assigned distributors/customers. ₹9.21 Cr follows Product-Wise employee/member identity. Unmapped employees, customer ownership and different source coverage prevent direct interchangeability. The UI now labels these bases.

### Why ₹9.21 Cr differs from ₹9.17 Cr

The Product-Wise figure uses individual secondary_order_line.basic_order_value rows. E uses pre-aggregated secondary_head_month.ordered_amount member rows, limited to members matched to the Sales Deep Dive roster. The approximately ₹4 L difference is not rounding; it comes from rows that pass Product-Wise person attribution but do not cross-foot identically through the E-table member/head-month basis.

Current production tables have moved since those observations. A direct current reconstruction returns approximately ₹9.129 Cr for Product-Wise Sandeep and ₹11.042 Cr for the raw Sandeep secondary_head_month state-head total. The historical ₹9.21/₹9.17 operands therefore cannot be reconstructed truthfully from today's mutable pre-Prompt-120 state alone. Prompt 120's immutable generation and explicit basis labels prevent this ambiguity going forward.

## 8. Publication instruction

The required commits are on GitHub. Publish origin/main at:

    6da8bfa8b5289bde3f6cbc6c47d8606d0293e8a7

After publication:

1. Run production checks 1–5.
2. Capture screenshots for checks 1 and 4.
3. Run the hour-separated C5 comparison.
4. Close H2 only if all five checks and C5 pass.
