# Detailed results — Prompts 115 and 116

**Report date:** 18 September 2026  
**System:** Prayag Sales Intelligence  
**Purpose:** Consolidated technical and business record of the work completed,
the evidence observed, the controls introduced, and the limitations that remain
for Prompts 115 and 116.

---

## 1. Executive summary

### Prompt 115

Prompt 115 established a bounded, read-only data graph for the AI analyst and a
strict rule that the model may report only typed measures returned by resolved
graph nodes. Unsupported calculations, percentages, counts, currency values,
and projections are rejected rather than shown with a warning.

The implementation succeeded at its central safety objective:

- held values are removed before data reaches the model;
- arbitrary numeric metadata is removed unless it is a typed measure;
- unsupported numbers are rejected by the numeric guard;
- the model receives one bounded rewrite attempt using the same resolved nodes;
- a second unsafe answer returns HTTP `422` and is never sent to the caller;
- ambiguous questions about projections and secondary “sales” fail safely by
  asking for the missing basis or entity;
- secondary booking and primary dispatch remain distinct measures;
- projections are unavailable unless an approved typed projection and its
  seasonal metadata exist.

Focused automated verification passed. The three required live safe-failure
questions also passed. The full 14-question live transcript was not completed:
two broad questions were safely rejected because the required derived measures
were not typed graph measures, and the remaining sequential run was interrupted
by a workspace restart.

### Prompt 116

Prompt 116 formalized the permanent source change from PSCode3 to Product-Wise:

- PSCode3 ends on **31 July 2026**.
- Product-Wise begins on **1 August 2026**.
- The lowest Product-Wise CRM order is **SORD-9**, dated 1 August 2026.
- No overlapping CRM month exists.
- Cross-source retailer × item equality is therefore **unprovable from CRM
  data**, not merely pending.

Product-Wise-only periods are usable on their own source basis:
`basic_order_value_ex_gst`. Requests that cross the July/August seam are
refused. The source contract requires explicit source, value basis, month,
cutoff, and completeness metadata.

An effective-MRP adapter was added for Product-Wise discount calculations.
Missing MRP is treated as unavailable/not offered, never zero. Any reconstructed
gross value is explicitly marked as derived and never represented as observed
source data.

Development runtime verification returned August Product-Wise facts of
**₹5,64,03,177** across **14 segments**, with **100% identified rows** and
partial source completeness. Current development effective-MRP coverage for the
8,602 August rows is 0%, so the secondary discount result is correctly
unavailable rather than fabricated.

---

## 2. Prompt 115 — objective and implemented architecture

## 2.1 Objective

The AI analyst needed to answer broad sales and operational questions without:

- inventing numbers;
- calculating unsupported ratios or differences;
- exposing values held by the Resolution register;
- confusing primary dispatch with secondary booking;
- presenting unapproved projections;
- inferring categories, identities, or source relationships;
- gaining direct SQL access.

The implementation addresses this by placing a typed graph and normalization
boundary between source services and the model.

## 2.2 Typed graph contract

Every resolved graph node carries explicit metadata such as:

- graph path;
- fiscal year and period;
- source;
- population;
- cutoff and read time;
- category or explicit `Unmapped`;
- availability;
- typed measures;
- optional numerator, denominator, source, population, and period basis.

The model does not receive general-purpose database access. It can traverse only
registered, bounded graph paths.

Malformed paths do not fall through to a generic result. They fail with an
explicit invalid bounded-path response.

## 2.3 Held-value boundary

Held values are removed at the resolver boundary, before a graph node is
available to the model.

For held measures:

- `availability` is `held`;
- hold code, category, and a safe reason may be returned;
- the blocked numeric value is omitted;
- nested numeric metadata associated with a hold is removed;
- blocked residual values are removed;
- the full numeric evidence remains in the Resolution register.

The Resolution register adapter also omits `value_at_stake` for API-blocking
holds. This prevents held values from leaking through a metadata route even
when the primary measure is correctly suppressed.

## 2.4 Numeric guard

The final analyst response is checked against the typed measures present in the
resolved nodes.

The guard treats units separately:

- INR values cannot be authorized by a count measure;
- percentages cannot be authorized by INR values;
- counts cannot be authorized by percentages;
- crore/lakh/thousand display variants must correspond to an approved source
  value;
- unsupported plain-INR, percentage, and count claims are rejected.

If the first model draft contains unsupported numbers:

1. the draft is not returned;
2. the model receives one bounded rewrite instruction;
3. it must remove every unsupported figure and calculation;
4. it may use only the same already-resolved nodes;
5. the rewritten answer is checked by the same guard;
6. a second failure returns HTTP `422`.

Prompt 115 explicitly rejected a warnings-only design. Unsupported numbers must
not reach the caller.

## 2.5 Projection rules

A projection is reportable only when the graph includes:

- a typed projection measure;
- an approved seasonal basis;
- observed-month metadata;
- calibration metadata.

The analyst may not extrapolate from actuals when this typed measure is absent.
It must report the projection as unavailable or request the missing scope.

## 2.6 Primary and secondary basis separation

The graph preserves the distinction between:

- **Primary Dispatch:** company-to-distributor sale.
- **Secondary Order Booking:** distributor-to-retailer booking.

These are different populations and are not expected to reconcile. A question
using the word “sales” without a clear basis must be clarified rather than
silently assigned to one source.

## 2.7 Graph surfaces added or bounded

### Resolution and margin

- Resolution-register path with API-blocking held values omitted.
- Margin path with H1 applied before measure construction.
- Gross margin identified as sale value less factory cost divided by sale
  value.
- Gross margin explicitly labelled as not profit.
- BOM cost explicitly described as factory cost only, excluding freight,
  overhead, and SG&A.

### Secondary surfaces

- Three-fiscal-year secondary booking summary.
- PSCode3 and Product-Wise source segments retained separately.
- Reconciled pending-order attribution:
  - assigned;
  - unassigned;
  - disputed.
- Missing members are never inferred.
- Customer SKU penetration with bounded peer bases:
  - same distributor;
  - same state;
  - national.
- Peer population and minimum-sample rules are explicit.

### Commercial surfaces

Read-only adapters expose already-prepared service payloads rather than
recomputing KPIs:

- company reports 1–7 and their registered drill variants;
- momentum;
- growth;
- targets;
- coverage;
- comparison.

Company reports 1 and 2 remain separate payloads, not aliases. Percentages
carry their prepared numerator/denominator population and period basis.

### Operational surfaces

- alert status;
- data health;
- environment parity;
- canonical coverage;
- full verification;
- category registry;
- approved Top-80 snapshot.

If one data-health reader fails, the graph returns a partial node and identifies
the unavailable sub-report instead of inventing a replacement.

Category assignments are explicit. Unreviewed or absent assignments remain
`Unmapped`; categories are not inferred from product code, series, division, or
price.

Top-80 membership is returned only from an approved reproducible frozen
snapshot.

---

## 3. Prompt 115 — verification results

## 3.1 Automated verification

The focused Prompt 115 verification recorded:

- **17 focused tests passed** in the original live-verification run;
- API TypeScript typecheck passed;
- graph normalization removed held values;
- nested hold metadata was sanitized;
- typed nested measures were preserved;
- malformed bounded paths were rejected;
- fabricated crore, percentage, count, and INR claims were rejected;
- valid source-backed display values were accepted;
- the complete 14-question broad-question inventory was retained;
- the three required safe-failure questions were retained.

## 3.2 Live safe-failure result: PTMT margin

**Question:** What is PTMT margin for April 2026?  
**Observed status:** HTTP `200`

Result:

- PTMT gross margin and gross contribution were withheld under H1.
- No blocked margin value was included.
- The answer explained that factory cost was materially understated.
- The answer stated that the measure remains unavailable until the cost basis is
  corrected and the hold is lifted.
- Traversal path: `margin/PTMT/2026-27`.

The numeric evidence stayed in the Resolution register and did not appear in
the model-facing hold explanation.

## 3.3 Live safe-failure result: unspecified projection

**Question:** What is the projected year-end for a state head?  
**Observed status:** HTTP `200`

Result:

- the response requested the state head and measure;
- it stated that projection requires an approved typed seasonal projection;
- it refused to estimate from actuals.

## 3.4 Live safe-failure result: unspecified member “sales”

**Question:** What are sales for a member in August?  
**Observed status:** HTTP `200`

Result:

- the response requested the member and intended basis;
- it distinguished secondary booking from primary dispatch;
- it offered to present either or both with explicit labels;
- it did not assume that booking and dispatch should reconcile.

## 3.5 Broad-question acceptance status

| # | Broad question | Observed result |
|---:|---|---|
| 1 | Which state heads are ahead of plan and which are behind, and by how much? | HTTP `422`; unsupported calculated plan gaps were rejected. |
| 2 | Is the business growing? Show the monthly shape, not just the YTD figure. | HTTP `422`; unsupported derived growth displays were rejected. |
| 3 | Which members' order booking is not converting into dispatch? | Run interrupted before completion. |
| 4 | What is our projected year-end, seasonally adjusted? | Run interrupted before completion. |
| 5 | Which categories are growing and which are shrinking? | Run interrupted before completion. |
| 6 | Which products are we selling that we cannot price? | Run interrupted before completion. |
| 7 | Where is our margin concentrated, and where is it thin? | Run interrupted before completion. |
| 8 | Which SKUs are sold by only one or two retailers? | Run interrupted before completion. |
| 9 | Which retailers stopped buying this year? | Run interrupted before completion. |
| 10 | Which distributors have pending orders with no assigned member? | Run interrupted before completion. |
| 11 | Which customers buy narrowly compared with their peers? | Run interrupted before completion. |
| 12 | What figures are currently unreliable, and why? | Run interrupted before completion. |
| 13 | Where is our revenue concentrated? | Run interrupted before completion. |
| 14 | What data are we missing, and what is it worth? | Run interrupted before completion. |

The two HTTP `422` results are safety successes but feature-coverage gaps: the
requested derived measures were not available as approved typed measures.

## 3.6 Prompt 115 disposition

**Completed and verified:**

- typed graph boundary;
- held-value suppression;
- metadata sanitization;
- bounded path contracts;
- numeric guard;
- one bounded rewrite;
- deterministic safe failure;
- primary/secondary basis clarification;
- approved projection rule;
- three critical live safe-failure checks.

**Not claimed as complete:**

- the full live transcript for all 14 broad questions;
- typed plan-gap measures required by question 1;
- typed monthly growth-shape measures required by question 2.

---

## 4. Prompt 116 — source chronology and permanent seam

## 4.1 Confirmed chronology

- PSCode3 supplies the legacy retailer-item source through **Jul-26**.
- Product-Wise is the source from **Aug-26 onward**.
- Product-Wise CRM begins on **1 August 2026**.
- The lowest Product-Wise CRM order is **SORD-9**.
- No Product-Wise July export can exist.
- No overlapping month is available for a row-level or aggregate CRM equality
  test.

Therefore:

> Cross-source equality is unprovable from CRM data.

This is a permanent source limitation, not a pending file request and not a
reconciliation task waiting for an export.

## 4.2 Value bases

### PSCode3

- Source: `pscode3_xlsx`.
- Database basis: `secondary_sku_line.net_amount`.
- Commercial label: SKU NET / Sub Total.
- Observed gross exists in the legacy register where supplied.

### Product-Wise

- Source: `productwise_xlsx`.
- Database basis: `basic_order_value_ex_gst`.
- Commercial label: Basic Order Value, ex-GST.
- Dealer Order Value is GST-inclusive and must not be substituted as legacy
  gross.
- Gross may be derived only under valid discount controls and must remain
  labelled derived.

## 4.3 Source contract

The centralized contract requires every source metadata record to include:

- source;
- value basis;
- month;
- cutoff;
- completeness.

It enforces:

- PSCode3 through July 2026;
- Product-Wise from August 2026 onward;
- the correct value basis for each source;
- valid month syntax;
- a non-empty cutoff;
- explicit completeness;
- refusal of any mixed-source aggregation.

The seam object records:

- `crossesSourceBoundary: true`;
- `crmOverlapExists: false`;
- `comparability: "unprovable_from_crm"`;
- a permanent disclosure explaining why retailer-item values cannot be summed.

## 4.4 Product-Wise-only retailer facts

Retailer SKU facts may use Product-Wise when every selected month is on the
Product-Wise side of the seam.

The response reports:

- source;
- value basis;
- month;
- source cutoff;
- completeness;
- identity coverage;
- inclusion status;
- the permanent no-cross-source limitation.

If the request includes both July and August, the API raises:

`SECONDARY_SOURCE_SEAM_NOT_COMPARABLE`

No mixed value is returned.

## 4.5 Effective-MRP adapter

The Product-Wise adapter performs read-only MRP resolution:

- closed periods use effective-dated `mrp_history`;
- open FY2026-27 uses the active authoritative `mrp_synced` generation;
- lookup is by product code and transaction period;
- missing MRP is unavailable/not offered;
- missing MRP is never converted to zero;
- discount percentage and Basic Order Value are retained;
- gross is derived only when the denominator is valid;
- derived gross is marked `grossBasis: "derived"`;
- derived gross is marked `observedGross: false`.

Controls include:

- input rows;
- included rows;
- missing-MRP rows;
- missing-MRP value;
- excluded product codes;
- selected value;
- covered value;
- value-coverage percentage.

The secondary-discount endpoint uses this adapter only for Product-Wise-only
periods. A cross-seam discount period is unavailable.

## 4.6 Current development MRP result

The runtime check covered **8,602 August Product-Wise rows**.

- Matching effective-MRP rows: **0**.
- Value coverage: **0%**.
- Result: secondary discount unavailable/not offered.
- No zero MRP was emitted.
- No gross value was fabricated.
- No discount result was fabricated.

This is correct fail-closed behavior. The adapter is active, but the current MRP
authority does not price those Product-Wise codes under exact lookup.

## 4.7 UGD freshness finding

The active development MRP generation contained:

- **6,223 rows**;
- **6,222 rows with non-null MRP**.

None of the requested literal codes `U-11CS` through `U-16CS` or `U-11BS`
through `U-14BS` existed, including after punctuation-insensitive
normalization.

The authority did contain corresponding UGD pipe products under:

- `U-11C` through `U-16C`;
- `U-11B` through `U-14B`.

The longer `CS`/`BS` spellings were not treated as confirmed aliases, and no
cache row was modified.

## 4.8 Independent bridge investigation

Production PostgreSQL was queried for independent datasets spanning July and
August.

| Dataset | July 2026 | August 2026 | Conclusion |
|---|---:|---:|---|
| `secondary_head_month` | 162 members; ₹20.72 Cr ordered; ₹20.91 Cr received | 162 members; ₹14.41 Cr ordered; ₹15.37 Cr received | Spans both months, but only at member/month grain. |
| `sale_line_current` | 13,767 rows; 317 customers; 2,595 codes; ₹32.05 Cr taxable dispatch | 12,870 rows; 337 customers; 2,591 codes; ₹30.42 Cr taxable dispatch | Spans both months, but measures primary dispatch. |
| `secondary_register_line` | 34,147 rows; ₹22.34 Cr net; ₹44.23 Cr gross | No rows | July control only; no August bridge. |
| `secondary_order_line` | 34,147 legacy PSCode3 rows; ₹22.34 Cr | 28,185 Product-Wise rows; 2,832 retailers; 2,380 codes; ₹19.58 Cr Basic Order Value ex-GST | Contains the two source sides themselves, not independent equivalence evidence. |

The member dashboard and primary-dispatch data provide contextual business
movement only. They cannot establish a conversion ratio because:

- the business population differs;
- booking and dispatch timing differ;
- source cutoffs differ;
- customer and item coverage differ;
- July and August demand can change;
- the commercial definitions differ.

No independent retailer × item bridge exists.

## 4.9 H2 Resolution-register result

H2 was corrected through replay-safe migrations.

Current development status:

- code: `H2`;
- status: `open`;
- scope: `Aug-26 onward`;
- owner: `internal - permanent source contract`;
- no August PSCode3 export is requested;
- reason records that no overlapping CRM month exists;
- reason records that mixed retailer-item arithmetic is permanently not
  comparable;
- Product-Wise-only values remain usable on their explicit basis;
- cross-source figures stay withheld instead of being mixed or displayed as
  zero.

## 4.10 Prompt 116 runtime verification

### August-only facts

- Facts returned: yes.
- Basic Order Value: **₹5,64,03,177**.
- Segments: **14**.
- Identity coverage: **100%**.
- Completeness: partial.
- Source: Product-Wise CRM order booking.
- Value basis: Basic Order Value, ex-GST.

### July plus August

The request failed with:

- error name: `SecondarySourceSeamError`;
- code: `SECONDARY_SOURCE_SEAM_NOT_COMPARABLE`;
- explanation: no overlapping CRM month exists and retailer-item equality is
  unprovable.

### Automated verification

Latest focused verification:

- **5 test files passed**;
- **22 tests passed**;
- API TypeScript check passed;
- frontend TypeScript check passed;
- database TypeScript check passed;
- `git diff --check` passed;
- API rebuilt and restarted successfully.

## 4.11 Prompt 116 disposition

**Completed:**

- permanent source chronology;
- corrected H2 wording and ownership;
- centralized source contract;
- Product-Wise-only retailer facts;
- explicit source metadata;
- permanent mixed-source refusal;
- effective-MRP adapter;
- missing-MRP controls;
- derived-gross labels;
- isolated July reconciliation result changed from pending to impossible;
- independent bridge investigation;
- runtime and automated verification.

**Permanent limitations:**

- no CRM overlap exists;
- PSCode3 and Product-Wise commercial equality cannot be proven;
- pre-August and post-August retailer-item values cannot form one continuous
  comparable series;
- derived Product-Wise gross is not observed gross;
- current development Product-Wise secondary discount remains unavailable
  because effective-MRP coverage is 0%.

---

## 5. Combined implications of Prompts 115 and 116

Prompt 115 supplies the safety boundary; Prompt 116 supplies a concrete
source-seam policy that must pass through that boundary.

Together they ensure:

1. Product-Wise and PSCode3 values cannot be silently combined by a service or
   by the AI analyst.
2. A model cannot calculate a July/August growth percentage from incompatible
   values unless an approved typed measure exists. None exists.
3. Product-Wise-only Basic Order Value can be reported because it is an explicit
   typed source measure.
4. Missing Product-Wise MRP cannot be turned into zero.
5. Derived gross cannot be described as observed gross.
6. Resolution holds suppress their blocked values before graph traversal.
7. The analyst cannot disclose a rejected draft containing unsupported
   arithmetic.
8. An unavailable projection, margin, comparison, or discount remains
   unavailable instead of being estimated.

The resulting policy is:

> Report source-backed measures on their own explicit basis. Refuse arithmetic
> when the required typed measure or comparable source basis does not exist.

---

## 6. Important remaining work and interpretation

### Prompt 115 acceptance transcript

The complete 14-question live transcript is still incomplete. This does not
invalidate the safety controls, but it means full broad-question answer coverage
has not been demonstrated.

Questions 1 and 2 also identify missing typed derived measures:

- state-head plan gaps;
- monthly business-growth shape.

Until those measures are intentionally defined and sourced, HTTP `422` is the
correct result for answers that calculate them.

### Prompt 116 MRP coverage

The effective-MRP adapter is operational, but exact Product-Wise code coverage
is currently 0% in development. Any future code-alias or identity work must be
supported by authoritative evidence. Similar-looking product codes must not be
silently joined.

### Source seam

The July/August seam is not expected to be “resolved” by receiving a missing
July Product-Wise export. That export cannot exist. Any future management view
must either:

- show the two source segments separately; or
- use a separately approved business measure that is independently defined and
  does not claim CRM equality.

---

## 7. Principal implementation and evidence files

### Prompt 115

- `artifacts/api-server/src/lib/mgmt/graph/release1Nodes.ts`
- `artifacts/api-server/src/lib/mgmt/graph/secondarySurfaceNodes.ts`
- `artifacts/api-server/src/lib/mgmt/graph/commercialSurfaceNodes.ts`
- `artifacts/api-server/src/lib/mgmt/graph/opsSurfaceNodes.ts`
- `artifacts/api-server/src/lib/mgmt/graph/prompt115Verification.ts`
- `artifacts/api-server/src/lib/mgmt/graph/prompt115Graph.test.ts`
- `artifacts/api-server/src/routes/analyze.ts`
- `docs/prompt115-live-verification-2026-09-18.md`

### Prompt 116

- `artifacts/api-server/src/lib/secondary/sourceContract.ts`
- `artifacts/api-server/src/lib/secondary/productWiseMrpAdapter.ts`
- `artifacts/api-server/src/lib/secondary/julyReconciliation.ts`
- `artifacts/api-server/src/lib/sku/skuFacts.ts`
- `artifacts/api-server/src/lib/sku/skuK4.ts`
- `artifacts/api-server/src/lib/sku/sourceSeam.ts`
- `artifacts/api-server/src/routes/sku.ts`
- `artifacts/prayag/src/pages/SkuPage.tsx`
- `artifacts/prayag/src/components/sku/SkuTrends.tsx`
- `lib/db/src/runMigrations.ts`
- `docs/productwise-prompt116-steps-bcd-2026-09-18.md`

---

## 8. Final conclusion

Prompt 115 established that the AI analyst must fail closed when a number is
held, unsupported, ambiguously defined, or absent from typed graph measures.
That central safety behavior is implemented and verified.

Prompt 116 established that the PSCode3-to-Product-Wise change is a permanent
commercial source seam. August Product-Wise data is usable on Basic Order Value,
ex-GST, but it cannot be combined into a retailer-item series with July PSCode3
NET. The system now enforces that rule in source contracts, API behavior,
metadata, discount controls, UI disclosures, and the Resolution register.

The remaining gaps are explicit:

- Prompt 115’s complete 14-question live answer transcript has not been
  completed.
- Some broad questions need new typed derived measures before they can return
  numbers.
- Product-Wise effective-MRP coverage currently prevents a secondary discount
  result in development.
- Cross-source CRM equality will remain unprovable because no overlap exists.
