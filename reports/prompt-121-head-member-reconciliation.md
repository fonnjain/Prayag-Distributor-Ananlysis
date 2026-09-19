# Prompt 121 — August CRM vs secondary_head_month reconciliation

**Environment:** production database, 19 September 2026.

**Basis:** Production `secondary_order_line.basic_order_value` for the 28,185 August Product-Wise rows was matched by exact Employee ID + Sales User Name to the reviewed 152-member authority; all 152 authority values cross-foot exactly to ₹19,57,88,289 with zero drift. Comparison values are production `secondary_head_month.ordered_amount` for FY 2026-27, `month_idx = 4`. Members join on the existing `normSecKey` rule (lowercase alphanumerics, parentheticals retained).

## Head summary

| Head | CRM | head_month | CRM − head_month | Coverage | Missing | Non-zero below 90% |
|---|---:|---:|---:|---:|---:|---:|
| Sandeep Dadheech | ₹12,37,42,880.00 | ₹11,04,17,853.16 | ₹1,33,25,026.84 | 89.23% | 10 | 0 |
| Syed Aqil Rizvi | ₹3,75,57,506.00 | ₹1,30,40,396.18 | ₹2,45,17,109.82 | 34.72% | 24 | 0 |
| Lalan Kumar | ₹1,12,40,415.00 | ₹83,22,015.46 | ₹29,18,399.54 | 74.04% | 4 | 0 |
| Anant Singh | ₹86,46,568.00 | ₹63,85,850.33 | ₹22,60,717.67 | 73.85% | 3 | 1 |
| Biju C.O | ₹67,25,577.00 | ₹36,35,465.24 | ₹30,90,111.76 | 54.05% | 10 | 0 |
| Pawan Kumar Sharma | ₹35,11,104.00 | ₹9,95,810.26 | ₹25,15,293.74 | 28.36% | 5 | 0 |
| Sunil Patel | ₹17,22,676.00 | ₹12,53,434.02 | ₹4,69,241.98 | 72.76% | 1 | 0 |
| Sulinder Pal | ₹14,04,844.00 | ₹12,90,551.94 | ₹1,14,292.06 | 91.86% | 1 | 0 |
| Nasir Hussain Khan | ₹12,36,719.00 | ₹6,68,308.10 | ₹5,68,410.90 | 54.04% | 4 | 0 |

## Missing and below-90% members

“Missing” means CRM > 0 and head_month = 0. “Below 90%” below means a non-zero head_month value below 90% of CRM.

### Anant Singh

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-001 | RAHUL SINGH | ₹7,37,716.00 | ₹0.00 | ₹7,37,716.00 | 0.00% |
| Missing | PRG-102 | ASHUTOSH KUMAR (RUDRAPUR) | ₹7,22,410.00 | ₹0.00 | ₹7,22,410.00 | 0.00% |
| Missing | PRG-036 | ANKIT KUMAR | ₹6,04,646.00 | ₹0.00 | ₹6,04,646.00 | 0.00% |
| Below 90% | PRG-056 | SHIVAM CHAUHAN | ₹12,23,544.00 | ₹6,51,248.94 | ₹5,72,295.06 | 53.23% |

### Biju C.O

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-112 | SAIBULLA S. | ₹9,03,787.00 | ₹0.00 | ₹9,03,787.00 | 0.00% |
| Missing | PRG-095 | AMEERALI EK (OFF ROLL) | ₹6,13,655.00 | ₹0.00 | ₹6,13,655.00 | 0.00% |
| Missing | PRG-082 | RIYAS V | ₹5,27,216.00 | ₹0.00 | ₹5,27,216.00 | 0.00% |
| Missing | PRG-355 | PRATHEESH CC | ₹4,52,594.00 | ₹0.00 | ₹4,52,594.00 | 0.00% |
| Missing | PRG-014 | PRATHAM KYASTI | ₹2,75,044.00 | ₹0.00 | ₹2,75,044.00 | 0.00% |
| Missing | PRG-008 | ABHISHEK RAVINDRA PADADAR | ₹2,24,885.00 | ₹0.00 | ₹2,24,885.00 | 0.00% |
| Missing | PRG-031 | MILIND ASHOK SADANAND | ₹41,651.00 | ₹0.00 | ₹41,651.00 | 0.00% |
| Missing | NJ-7 | ABHISHEKGOUD .K. PATIL | ₹23,170.00 | ₹0.00 | ₹23,170.00 | 0.00% |
| Missing | PRG-021 | HARSHA K RAO | ₹22,739.00 | ₹0.00 | ₹22,739.00 | 0.00% |
| Missing | NJ-5 | KRISHNA KUMAR K | ₹5,364.00 | ₹0.00 | ₹5,364.00 | 0.00% |

### Lalan Kumar

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-430 | TEJAS LUNAWAT | ₹11,31,452.00 | ₹0.00 | ₹11,31,452.00 | 0.00% |
| Missing | PRG-330 | CHANDRAKANT MANDAVE | ₹7,87,879.00 | ₹0.00 | ₹7,87,879.00 | 0.00% |
| Missing | PRG-007 | VAIBHAV BAPURAO WAGHE | ₹6,39,346.00 | ₹0.00 | ₹6,39,346.00 | 0.00% |
| Missing | PRG-168 | ANAND BHAGWAN MORE | ₹3,59,725.00 | ₹0.00 | ₹3,59,725.00 | 0.00% |

### Nasir Hussain Khan

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-350 | PAWAN KUMAR | ₹4,69,566.00 | ₹0.00 | ₹4,69,566.00 | 0.00% |
| Missing | NJ-6 | BASHARAT MAJEED MAGLOO | ₹4,44,284.00 | ₹0.00 | ₹4,44,284.00 | 0.00% |
| Missing | PRG-027 | DEEP KUMAR | ₹1,01,416.00 | ₹0.00 | ₹1,01,416.00 | 0.00% |
| Missing | PRG-166 | BASIT AHMAD PALA | ₹95,898.00 | ₹0.00 | ₹95,898.00 | 0.00% |

### Pawan Kumar Sharma

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-271 | DINESH KUMAR KAUSHIK | ₹7,55,087.00 | ₹0.00 | ₹7,55,087.00 | 0.00% |
| Missing | PRG-283 | GULAB SINGH | ₹5,53,948.00 | ₹0.00 | ₹5,53,948.00 | 0.00% |
| Missing | PRG-040 | ISHANT | ₹4,75,090.00 | ₹0.00 | ₹4,75,090.00 | 0.00% |
| Missing | PRG-061 | SHOYKARAN NAI | ₹3,99,512.00 | ₹0.00 | ₹3,99,512.00 | 0.00% |
| Missing | PRG-131 | KANHAIYA LAL SALVI | ₹3,31,659.00 | ₹0.00 | ₹3,31,659.00 | 0.00% |

### Sandeep Dadheech

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-351 | PRABHAKAR PRATAP SINGH | ₹49,17,353.00 | ₹0.00 | ₹49,17,353.00 | 0.00% |
| Missing | PRG-356 | PRAVAT KUMAR DASH | ₹28,00,122.00 | ₹0.00 | ₹28,00,122.00 | 0.00% |
| Missing | PRG-352 | PRADEEP KUMAR | ₹15,21,597.00 | ₹0.00 | ₹15,21,597.00 | 0.00% |
| Missing | PRG-216 | KUMAR AVINISH | ₹11,45,174.00 | ₹0.00 | ₹11,45,174.00 | 0.00% |
| Missing | PRG-025 | PAWAN KUMAR PAREEK (OFF-ROLL) | ₹9,48,367.00 | ₹0.00 | ₹9,48,367.00 | 0.00% |
| Missing | PRG-165 | AJAY MORTHAD | ₹6,40,389.00 | ₹0.00 | ₹6,40,389.00 | 0.00% |
| Missing | PRG-002 | PARIPALLY SRIDHAR | ₹5,71,918.00 | ₹0.00 | ₹5,71,918.00 | 0.00% |
| Missing | PRG-147 | ADARSH GAURAV | ₹5,65,657.00 | ₹0.00 | ₹5,65,657.00 | 0.00% |
| Missing | PRG-368 | S.TIRUMALA RAO | ₹4,70,237.00 | ₹0.00 | ₹4,70,237.00 | 0.00% |
| Missing | PRG-170 | MANAS RANJAN DAS | ₹9,206.00 | ₹0.00 | ₹9,206.00 | 0.00% |

### Sulinder Pal

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-099 | ARVIND KUMAR | ₹1,14,309.00 | ₹0.00 | ₹1,14,309.00 | 0.00% |

### Sunil Patel

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-078 | RATHOD VIJAYBHAI | ₹4,69,241.00 | ₹0.00 | ₹4,69,241.00 | 0.00% |

### Syed Aqil Rizvi

| Status | Employee | Member | CRM | head_month | Difference | Coverage |
|---|---|---|---:|---:|---:|---:|
| Missing | PRG-334 | FARAZ KHAN | ₹48,99,721.00 | ₹0.00 | ₹48,99,721.00 | 0.00% |
| Missing | PRG-339 | JITENDER BIRLA | ₹30,82,678.00 | ₹0.00 | ₹30,82,678.00 | 0.00% |
| Missing | PRG-335 | HEMANT KUMAR SRIVASTAVA | ₹23,07,520.00 | ₹0.00 | ₹23,07,520.00 | 0.00% |
| Missing | PRG-253 | AJEET YADAV | ₹17,36,804.00 | ₹0.00 | ₹17,36,804.00 | 0.00% |
| Missing | PRG-117 | DEEPENDRA SINGH | ₹14,10,373.00 | ₹0.00 | ₹14,10,373.00 | 0.00% |
| Missing | PRG-156 | WASIM AHMAD | ₹12,48,638.00 | ₹0.00 | ₹12,48,638.00 | 0.00% |
| Missing | PRG-360 | RAVI KUMAR VERMA | ₹12,13,424.00 | ₹0.00 | ₹12,13,424.00 | 0.00% |
| Missing | PRG-348 | NITIN PRASAD BAGHEL | ₹10,23,548.00 | ₹0.00 | ₹10,23,548.00 | 0.00% |
| Missing | PRG-188 | DHIRAJ RAVINDRA PATLE | ₹9,11,376.00 | ₹0.00 | ₹9,11,376.00 | 0.00% |
| Missing | PRG-252 | VISHAL KUMAR GAURAV | ₹8,97,047.00 | ₹0.00 | ₹8,97,047.00 | 0.00% |
| Missing | PRG-230 | ARUN SHARMA | ₹8,76,592.00 | ₹0.00 | ₹8,76,592.00 | 0.00% |
| Missing | PRG-336 | HIMANSHU SABLE | ₹8,36,002.00 | ₹0.00 | ₹8,36,002.00 | 0.00% |
| Missing | PRG-063 | ROHIT KUMAR | ₹8,29,013.00 | ₹0.00 | ₹8,29,013.00 | 0.00% |
| Missing | PRG-255 | NANDKISHOR UPADHYAY | ₹7,87,505.00 | ₹0.00 | ₹7,87,505.00 | 0.00% |
| Missing | PRG-533 | VISHAL DHEER | ₹7,20,828.00 | ₹0.00 | ₹7,20,828.00 | 0.00% |
| Missing | PRG-347 | NEEL KAMAL CHOURE | ₹5,65,919.00 | ₹0.00 | ₹5,65,919.00 | 0.00% |
| Missing | PRG-009 | ABHISHEK KUMAR GUPTA | ₹5,56,995.00 | ₹0.00 | ₹5,56,995.00 | 0.00% |
| Missing | PRG-042 | RAJESH PATEL | ₹4,71,882.00 | ₹0.00 | ₹4,71,882.00 | 0.00% |
| Missing | PRG-037 | SUNIL KUMAR | ₹4,60,891.00 | ₹0.00 | ₹4,60,891.00 | 0.00% |
| Missing | PRG-404 | SIDDHARTH SHANKER SINGH | ₹3,93,006.00 | ₹0.00 | ₹3,93,006.00 | 0.00% |
| Missing | PRG-103 | MANOJ YADAV | ₹3,00,631.00 | ₹0.00 | ₹3,00,631.00 | 0.00% |
| Missing | PRG-046 | VIKAS KUMAR (BAREILLY) | ₹1,51,394.00 | ₹0.00 | ₹1,51,394.00 | 0.00% |
| Missing | PRG-616 | SAMIR SENGUPTA | ₹1,29,146.00 | ₹0.00 | ₹1,29,146.00 | 0.00% |
| Missing | PRG-012 | MANISH KUMAR KARTIKEY | ₹74,042.00 | ₹0.00 | ₹74,042.00 | 0.00% |

## Aqil members where head_month exceeds CRM

| Employee | Member | CRM | head_month | head_month − CRM | Coverage |
|---|---|---:|---:|---:|---:|
| PRG-358 | RAJAN SRIVASTAVA | ₹29,21,985.00 | ₹37,61,275.64 | ₹8,39,290.64 | 128.72% |
| PRG-273 | SIDDHARTH SRIVASTAVA | ₹19,89,015.00 | ₹24,79,164.61 | ₹4,90,149.61 | 124.64% |
| PRG-243 | SAQIB JUNED | ₹21,98,209.00 | ₹22,36,647.89 | ₹38,438.89 | 101.75% |
| PRG-035 | SHUBHAM SHUKLA | ₹5,08,655.00 | ₹5,08,657.30 | ₹2.30 | 100.00% |
| PRG-045 | PRADEEP KUMAR DWIVEDI | ₹2,62,217.00 | ₹2,62,217.40 | ₹0.40 | 100.00% |

- Missing-member CRM total: ₹2,58,84,975.00.
- Five-member head_month overage: ₹13,67,881.84.
- The other matched members have a net CRM-over-head_month difference of ₹16.66.
- Net Aqil shortfall: ₹2,45,17,109.82.
