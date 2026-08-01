# QA verification reference — all fiscal years

*Built independently from the source registers on 1 August 2026. Every figure here is computed from the sheet, not read from the application. Compare the app against these.*

---

# Part 1 — Sources

```
SALE SHEET 26-27    19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps
                    tabs Apr/May/Jun/July/Aug   value = Taxable Value (col M)
                    row counted where Invoice No (col B) non-empty
Order Sheet 26-27   1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A
                    tabs Apr/May/Jun/July/Aug   value = Taxable Value (col L)
                    row counted where Document No (col C) non-empty
STATE HEAD DASHBOARD 2026-27   1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM
                    tab 'SECONDARY ORDER BOOKING REPORT ' (trailing space)
                    7-col monthly blocks, members rows 7-168
```

**NET is Taxable Value / Sub Total. Never Order Total.**

---

# Part 2 — Frozen closed years

These are immutable. Any deviation means something wrote to a frozen year.

| FY | Rows | Total ₹ Cr | State |
|---|---|---|---|
| FY2023-24 | 137,619 | **349.02** | frozen |
| FY2024-25 | 141,201 | **341.14** | frozen |
| FY2025-26 | 145,613 | **361.00** | frozen |

> **FY2025-26 is ₹361.00 Cr.** The older ₹359.52 Cr figure came from a stale xlsx that was 1,248 rows short. ₹361.00 Cr sits ₹0.14 Cr from the State Head Sale anchor of ₹361.14 Cr.

**Startup assertion:** if any frozen year's row count or total changes, fail loudly with the year named.

---

# Part 3 — FY2026-27 primary sale / dispatch

| Month | Rows | Invoices | Customers | Codes | Quantity | **₹ Cr** |
|---|---|---|---|---|---|---|
| Apr-26 | 5,542 | 1,012 | 214 | 1,713 | 1,569,677 | **13.11** |
| May-26 | 11,812 | 2,408 | 292 | 2,428 | 4,607,661 | **28.28** |
| Jun-26 | 12,868 | 2,282 | 296 | 2,499 | 5,602,739 | **31.43** |
| Jul-26 | 11,454 | 1,958 | 293 | 2,473 | 5,254,611 | **25.90** |
| **Total** | **41,676** | 7,660 | 500 | 3,654 | 17,034,688 | **98.71** |

*Aug-26 holds zero rows in the register as at 1 August.*

## Periods

| Period | Rows | **₹ Cr** |
|---|---|---|
| **Q1 (Apr–Jun)** | 30,222 | **72.81** |
| **Q2 (Jul only)** | 11,454 | **25.90** |
| **YTD (Apr–Jul)** | 41,676 | **98.71** |

---

# Part 4 — FY2026-27 primary order booking

| Month | Rows | Orders | Customers | Codes | Quantity | **₹ Cr** |
|---|---|---|---|---|---|---|
| Apr-26 | 6,694 | 630 | 231 | 1,992 | 1,840,266 | **15.73** |
| May-26 | 11,842 | 1,016 | 278 | 2,450 | 4,816,124 | **29.37** |
| Jun-26 | 13,311 | 1,153 | 299 | 2,633 | 5,943,338 | **32.65** |
| Jul-26 | 13,812 | 1,308 | 325 | 2,603 | 6,943,554 | **32.56** |
| **Total** | **45,659** | 4,107 | 519 | 3,790 | 19,543,282 | **110.32** |

## Pending — order booking minus dispatch

| Month | OB ₹ Cr | Sale ₹ Cr | **Pending ₹ Cr** |
|---|---|---|---|
| Apr-26 | 15.73 | 13.11 | **2.63** |
| May-26 | 29.37 | 28.28 | **1.09** |
| Jun-26 | 32.65 | 31.43 | **1.23** |
| Jul-26 | 32.56 | 25.90 | **6.66** |
| **YTD** | **110.32** | **98.71** | **11.60** |

> **Pending must never be negative.** A negative value means dispatch exceeds what was ever ordered, which is impossible and indicates the sale side is inflated.
---

# Part 5 — FY2026-27 sale by State Head

*Note: the register uses the OLD head vocabulary — SANDEEP JI, RIZVI JI, BIJJU, LALAN, NASIR HUSAIN, PAWAN KUMAR. Five of these are merged to current names in `head_canon`. PROJECT, GOVT, GEM, JJM and OTHER are non-territory channels.*

| State Head (register name) | Apr | May | Jun | Jul | **Total ₹ Cr** | Share |
|---|---|---|---|---|---|---|
| SANDEEP JI | 6.24 | 13.07 | 18.63 | 13.87 | **51.80** | 52.5% |
| RIZVI JI | 2.23 | 6.30 | 4.36 | 4.88 | **17.78** | 18.0% |
| BIJJU | 1.52 | 2.42 | 1.88 | 1.50 | **7.32** | 7.4% |
| GOVT | 0.48 | 1.52 | 0.87 | 0.62 | **3.49** | 3.5% |
| ANANT SINGH | 0.07 | 1.20 | 1.18 | 0.61 | **3.05** | 3.1% |
| PAWAN KUMAR | 0.41 | 0.98 | 0.48 | 0.81 | **2.67** | 2.7% |
| LALAN | 0.51 | 0.55 | 0.75 | 0.83 | **2.64** | 2.7% |
| SULINDER PAL | 0.41 | 0.63 | 1.09 | 0.48 | **2.60** | 2.6% |
| ANUJ SHARMA | 0.00 | 0.00 | 0.73 | 0.72 | **1.46** | 1.5% |
| PROJECT | 0.41 | 0.34 | 0.25 | 0.39 | **1.40** | 1.4% |
| OTHER | 0.24 | 0.37 | 0.28 | 0.26 | **1.15** | 1.2% |
| NASIR HUSAIN | 0.34 | 0.26 | 0.39 | 0.16 | **1.15** | 1.2% |
| SUNIL PATEL | 0.11 | 0.18 | 0.51 | 0.31 | **1.11** | 1.1% |
| GEM | 0.13 | 0.49 | 0.03 | 0.39 | **1.04** | 1.1% |
| NARENDRA SHARMA | 0.00 | 0.00 | 0.00 | 0.05 | **0.05** | 0.1% |
| JJM | 0.01 | 0.00 | 0.00 | 0.00 | **0.01** | 0.0% |
| **Total** | 13.11 | 28.28 | 31.43 | 25.90 | **98.71** | 100% |

> **Non-territory channels — PROJECT, GOVT, GEM, JJM, OTHER — total ₹7.09 Cr, 7.2% of primary sale.** These must be excluded from every territory baseline, gap and opportunity figure.

---

# Part 6 — FY2026-27 sale by product group

| Group | Apr | May | Jun | Jul | **Total ₹ Cr** | Share |
|---|---|---|---|---|---|---|
| PTMT | 3.57 | 5.42 | 7.39 | 5.90 | **22.28** | 22.6% |
| C P | 3.69 | 6.03 | 5.80 | 3.86 | **19.39** | 19.6% |
| CPVC | 0.82 | 3.23 | 3.60 | 3.01 | **10.66** | 10.8% |
| SWR | 0.64 | 1.77 | 2.51 | 2.32 | **7.24** | 7.3% |
| UPVC | 0.41 | 1.64 | 2.26 | 2.05 | **6.36** | 6.4% |
| SANITARYWARE | 0.33 | 1.91 | 1.58 | 1.35 | **5.17** | 5.2% |
| WATER TANK | 0.41 | 1.31 | 1.55 | 1.53 | **4.79** | 4.9% |
| CP ACCESSORIES | 0.74 | 1.72 | 1.06 | 1.10 | **4.63** | 4.7% |
| SINK | 0.47 | 1.03 | 1.64 | 0.95 | **4.09** | 4.1% |
| CISTERN | 0.26 | 0.97 | 0.81 | 0.96 | **3.00** | 3.0% |
| AGRI | 0.55 | 0.67 | 0.84 | 0.59 | **2.65** | 2.7% |
| GARDEN PIPE | 0.54 | 0.91 | 0.84 | 0.32 | **2.61** | 2.6% |
| CONNECTION | 0.23 | 0.56 | 0.48 | 0.80 | **2.08** | 2.1% |
| WASTE PIPE | 0.15 | 0.26 | 0.28 | 0.27 | **0.96** | 1.0% |
| SEAT COVER | 0.08 | 0.18 | 0.15 | 0.15 | **0.57** | 0.6% |
| HARDWARE | 0.05 | 0.15 | 0.22 | 0.12 | **0.55** | 0.6% |
| CABINET | 0.04 | 0.15 | 0.10 | 0.17 | **0.46** | 0.5% |
| HDPE PIPE | 0.02 | 0.09 | 0.12 | 0.16 | **0.39** | 0.4% |
| TEFELON TAPE | 0.03 | 0.18 | 0.08 | 0.06 | **0.34** | 0.3% |
| PLATE RACK | 0.01 | 0.04 | 0.05 | 0.12 | **0.23** | 0.2% |
| FLOOR TRAP | 0.04 | 0.05 | 0.04 | 0.07 | **0.21** | 0.2% |

---

# Part 7 — FY2026-27 sale by state

| State | **Total ₹ Cr** | Share |
|---|---|---|
| W-BENGAL | **19.44** | 19.7% |
| BIHAR | **9.26** | 9.4% |
| UP ( R ) | **8.91** | 9.0% |
| MP | **7.05** | 7.1% |
| JHARKHAND | **6.50** | 6.6% |
| ODISHA | **6.45** | 6.5% |
| Kerala | **5.74** | 5.8% |
| ASSAM | **3.60** | 3.6% |
| GOVT | **3.49** | 3.5% |
| Tamilnadu | **2.67** | 2.7% |
| MAHARASTRA L | **2.60** | 2.6% |
| AP | **2.18** | 2.2% |
| PUNJAB | **1.89** | 1.9% |
| Telangana | **1.68** | 1.7% |
| Haryana | **1.65** | 1.7% |
| UP ( A ) | **1.63** | 1.7% |
| Karnataka (B) | **1.58** | 1.6% |
| UP (AS) | **1.46** | 1.5% |
| PROJECT | **1.40** | 1.4% |
| OTHER | **1.14** | 1.2% |
| Gujarat | **1.11** | 1.1% |
| MAHARASTRA R | **1.09** | 1.1% |
| GEM | **1.04** | 1.1% |
| Rajasthan | **1.02** | 1.0% |
| KASHMIR | **0.74** | 0.7% |
| Chhattisgarh | **0.72** | 0.7% |
| Uttarakhand | **0.71** | 0.7% |
| Himachal Pradesh | **0.67** | 0.7% |
| DELHI A | **0.45** | 0.5% |
| JAMMU | **0.41** | 0.4% |
| DELHI NCR | **0.26** | 0.3% |

> **State names carry territory splits, not true states** — `UP ( R )`, `DELHI A`, `KARNATAKA (B)`. Normalise through the shared `stateCanon` module before filtering or grouping.
---

# Part 8 — FY2026-27 secondary

*Source: State Head Dashboard, `SECONDARY ORDER BOOKING REPORT ` tab. 162 member rows.*

| Month | Plan ₹ Cr | OB ₹ Cr | Sales ₹ Cr | Ach % | Members with plan |
|---|---|---|---|---|---|
| Apr | 25.30 | **12.76** | **14.10** | 55.7 | 124 |
| May | 28.53 | **20.49** | **20.42** | 71.6 | 137 |
| Jun | 28.77 | **24.44** | **28.33** | 98.5 | 137 |
| Jul | 26.02 | 0.00 | 0.34 | — | 117 |
| Aug | 19.15 | 0.00 | 0.00 | — | 85 |
| Sep | 19.53 | 0.00 | 0.00 | — | 76 |
| Oct | 16.78 | 0.00 | 0.00 | — | 68 |
| Nov | 16.92 | 0.00 | 0.00 | — | 68 |
| Dec | 19.41 | 0.00 | 0.00 | — | 68 |
| Jan | 17.07 | 0.00 | 0.00 | — | 68 |

## Periods

| Period | Plan | OB | Sales | **Achievement** |
|---|---|---|---|---|
| **Q1 (Apr–Jun)** | **₹82.60 Cr** | **₹57.70 Cr** | **₹62.86 Cr** | **76.1%** |
| **YTD (Apr–Jun)** | ₹82.60 Cr | ₹57.70 Cr | ₹62.86 Cr | 76.1% |

**Annual columns:** plan (L) ₹365.38 Cr · OB (M) ₹57.70 Cr · sales (O) ₹63.20 Cr · Total Dealer (K) 11,536

> **Secondary YTD stops at June**, because July has a plan of ₹26.02 Cr and effectively no recorded actuals. Including July would drop achievement from 76.1% to 57.9% — a fall caused entirely by a month with no data. **Primary YTD runs to July; secondary to June.** Each card must state its own range.

> **Months from Aug onward carry a plan and zero actuals.** They must read **"no actuals recorded yet"**, never 0%, and must not contribute a low-performer count.

> **The plan declines month on month** — ₹28.77 Cr in June against ₹16.78 Cr in October — and the count of members with a plan falls from 137 to 68. **Never pro-rate an annual target evenly across months.**

---

# Part 9 — Cross-checks that must hold

| # | Check | Expected |
|---|---|---|
| 1 | Apr + May + Jun sale | **₹72.81 Cr** |
| 2 | Apr–Jul sale | **₹98.71 Cr** |
| 3 | Apr–Jul order booking | **₹110.32 Cr** |
| 4 | Pending = OB − sale | **₹11.60 Cr**, never negative |
| 5 | Secondary Q1 OB | **₹57.70 Cr** |
| 6 | Secondary Q1 sales received | **₹62.86 Cr** |
| 7 | Secondary Q1 achievement | **76.1%** = 62.86 ÷ 82.60 |
| 8 | Monthly sale sums to YTD | 13.11 + 28.28 + 31.43 + 25.90 = 98.72 |
| 9 | Monthly OB sums to YTD | 15.73 + 29.37 + 32.65 + 32.56 = 110.31 |
| 10 | SOBR col O annual vs monthly | ₹63.20 Cr vs ₹62.86 Cr — **₹0.34 Cr is July's partial entry** |
| 11 | Frozen FY2023-24 | 137,619 rows · ₹349.02 Cr |
| 12 | Frozen FY2024-25 | 141,201 rows · ₹341.14 Cr |
| 13 | Frozen FY2025-26 | 145,613 rows · ₹361.00 Cr |

**A frozen year that moves, or a negative pending, is a fault — not drift.**

---

# Part 10 — Row-count anchors

| Source | Month | Rows |
|---|---|---|
| Sale Sheet | Apr-26 | 5,542 |
| Sale Sheet | May-26 | 11,812 |
| Sale Sheet | Jun-26 | 12,868 |
| Sale Sheet | **Jul-26** | **11,454** |
| Order Sheet | Apr-26 | 6,694 |
| Order Sheet | May-26 | 11,842 |
| Order Sheet | Jun-26 | 13,311 |
| Order Sheet | **Jul-26** | **13,812** |
| SOBR | member rows | 162 |
| Dashboard `Data` | member rows | 183 |

**Row counts are the fastest fault detector.** A month whose DB row count exceeds the sheet is inflated; fewer means rows were dropped. Both have happened.

---

# Part 11 — Currently known deviations

| Figure | App | Source | Diff |
|---|---|---|---|
| **Jul sale** | ₹27.36 Cr | **₹25.90 Cr** | **+1.46** |
| **YTD sale** | ₹100.17 Cr | **₹98.71 Cr** | **+1.46** |
| **Pending** | ₹10.15 Cr | **₹11.60 Cr** | **−1.45** |
| OB Primary YTD | ₹110.32 Cr | ₹110.32 Cr | exact |

**One fault, three symptoms.** YTD includes July; Pending is OB minus sale, so it is understated by exactly what sale is overstated. The Order Sheet path is clean.

July read ₹41.26 Cr earlier on 1 August and ₹27.36 Cr later, so a partial cleanup ran — **but stopped ₹1.46 Cr short.** The July DB row count should be **11,454**.

---

# Part 12 — How to use this

**Row counts first.** They are unambiguous and catch both inflation and loss.

**Then monthly values**, which localise a fault to one month.

**Then the cross-checks in Part 9**, which catch faults that survive both — a wrong period range, a mislabelled card, a negative pending.

**Then the dimensional breakdowns** in Parts 5 to 7, which catch attribution faults: a head merged wrongly, a segment derived from the wrong column, a state variant not normalised.

> **Re-read the source before treating any difference as a bug.** The live sheet moves during the day — one member's sale shifted ₹6.5 lakh in a few hours on 30 July. Compare at the same moment, and record the read timestamp alongside every figure.

---

*Reference built from source registers, 1 August 2026. Closed-year anchors from the frozen database.*
