# Product-Wise Prompt 116 — implementation and gate report

**Date:** 18 September 2026  
**Implementation scope:** corrected H2 permanent source-seam hold, source
contract, effective-MRP adapter, Product-Wise-only retailer facts/discount, and
an explicit refusal of cross-seam arithmetic.

## Freshness check — UGD codes

**Database queried:** Replit development PostgreSQL, active
`mrp_sync_generation` joined to `mrp_synced`, read on 18 September 2026.

- Active generation: **6,223 rows; 6,222 with non-null MRP**.
- None of the ten requested literal codes (`U-11CS` through `U-16CS`, and
  `U-11BS` through `U-14BS`) exists, including after punctuation-insensitive
  normalisation.
- The active cache does contain ten corresponding UGD pipe products under the
  source codes `U-11C`, `U-12C`, `U-13C`, `U-14C`, `U-15C`, `U-16C`,
  `U-11B`, `U-12B`, `U-13B`, and `U-14B`.
- Those rows are identified by `mrp_synced.product_name` as UGD pipes. The
  literal `...CS`/`...BS` spellings are therefore **not confirmed** as active
  cache codes; the cache uses the shorter `...C`/`...B` authority codes.

This also means the observed `6119/6119` header is not the row count of the
development active generation at this read time. No cache row was changed.

## Sections A and E — corrected H2 hold

A replay-safe migration corrects open H2 records without reopening a resolved
or closed administrator decision:

- H2 is a permanent Product-Wise source seam, not a missing-export or
  pending-reconciliation reminder.
- PSCode3 ended after July 2026; no August PSCode3 export is requested.
- Product-Wise retailer × item data exists in `secondary_order_line`, but its
  value basis differs permanently from the legacy SKU register.
- The scope is `Aug-26 onward`, and the owner is the internal parity build.
- The evidence records that PSCode3 ended 31 July and Product-Wise began
  1 August; no overlapping CRM month exists.
- The central hold resolver now applies open-ended month scopes to every
  concrete month and fiscal year from August 2026 onward.

Product-Wise-only periods are usable on their stated basis. Cross-seam
retailer × item arithmetic remains withheld rather than mixed or displayed as
zero.

## Section B — source contract

`artifacts/api-server/src/lib/secondary/sourceContract.ts` is the centralized
contract:

- PSCode3 (`pscode3_xlsx`) is authoritative through `Jul-26` with
  `net_amount`.
- Product-Wise (`productwise_xlsx`) is the expected source from `Aug-26`
  onward with `basic_order_value_ex_gst`.
- Every metadata object requires `source`, `value_basis`, `month`, `cutoff`,
  and `completeness`.
- Source-month and value-basis mismatches throw.
- Cross-source aggregation always throws. There is no CRM-overlap route to an
  approved-equivalence flag.
- `secondarySeam()` states `crmOverlapExists: false`,
  `comparability: "unprovable_from_crm"`, and emits the permanent July/August
  disclosure.

The contract is wired into retailer SKU facts. Product-Wise-only month
selections use Product-Wise rows and report source, value basis, month, cutoff,
completeness, identity coverage, and the permanent seam limitation. A request
that includes both a PSCode3 and Product-Wise month returns a structured
conflict instead of summing them.

## Section C — effective-MRP adapter

`artifacts/api-server/src/lib/secondary/productWiseMrpAdapter.ts` provides:

- Read-only lookup by Product-Wise `productCode` and transaction period.
- Closed-period lookup through effective-dated `mrp_history` for each
  product-code and transaction-date pair.
- Open-FY lookup through the active `mrp_synced` generation.
- Missing MRP treated as not offered/unpriced, never as zero.
- Product-Wise discount percentage and basic ex-GST value retained.
- Gross derived only for a valid positive discount denominator.
- Derived gross explicitly labelled `grossBasis: "derived"` and
  `observedGross: false`.
- Controls for row coverage, value coverage, missing-MRP rows/value, and
  excluded product codes.
- Mixed-period inputs retain the MRP source on every row; August 2026 is
  correctly classified as open FY2026-27 and uses the active synced generation.
- The secondary-discount endpoint now uses this adapter for Product-Wise-only
  period selections. Its response labels gross as derived/never observed and
  exposes the MRP controls. Mixed-source discount periods return unavailable
  with the permanent-seam reason.
- Development runtime check: all 8,602 August rows currently lack a matching
  effective-MRP record, so secondary discount is correctly returned as not
  offered with 0% value coverage. No zero MRP, zero gross, or fabricated
  discount is emitted.

## Section D — CRM reconciliation is impossible

`artifacts/api-server/src/lib/secondary/julyReconciliation.ts` provides:

- Strict Product-Wise workbook header and July-date parsing.
- SHA-256 source fingerprinting.
- Row, item, retailer, and total comparison output, including monetary deltas,
  when a file is supplied.
- Non-July rows, missing identity, and missing quantity/value fail closed rather
  than being skipped or converted to zero.
- Inclusion-rule reporting for status, missing identity/value, and the two
  still-unproven commercial questions.
- No loader calls, SQL writes, or `secondary_sku_line` references.

The current result is:

**IMPOSSIBLE — no independent July Product-Wise export can exist.**

PSCode3 ended on 31 July 2026. The lowest Product-Wise CRM order, `SORD-9`, is
dated 1 August 2026, and the August export has no earlier rows. The approved
PSCode3 target control remains 34,147 rows, ₹223,436,806 net, and
₹442,326,730.10 observed gross. Those values are not treated as evidence of
Product-Wise parity.

### Independent bridge check

**Database queried:** Replit production PostgreSQL read replica, 18 September
2026.

| Dataset/source | July 2026 | August 2026 | Finding |
|---|---:|---:|---|
| `secondary_head_month` member dashboard | 162 members; ₹20.72 Cr ordered; ₹20.91 Cr received | 162 members; ₹14.41 Cr ordered; ₹15.37 Cr received | Spans the seam at member/month grain only; no retailer or item keys |
| `sale_line_current` primary dispatch | 13,767 rows; 317 customers; 2,595 codes; ₹32.05 Cr taxable dispatch | 12,870 rows; 337 customers; 2,591 codes; ₹30.42 Cr taxable dispatch | Spans the seam at customer/item grain, but measures primary dispatch, not secondary booking |
| `secondary_register_line` register mirror | 34,147 rows; ₹22.34 Cr net; ₹44.23 Cr gross | No rows | July control only; no August bridge |
| `secondary_order_line` | 34,147 legacy-CRM PSCode3 rows; ₹22.34 Cr | 28,185 Product-Wise rows; 2,832 retailers; 2,380 codes; ₹19.58 Cr Basic Order Value ex-GST | Contains the two seam sources themselves; not independent evidence |

The member dashboard and primary dispatch can contextualise the business change
between months, but neither can establish a conversion ratio between PSCode3
NET and Product-Wise Basic Order Value. Demand, dispatch timing, population,
and cutoff can all change between July and August. The seam is therefore
permanent and commercially undeterminable from available data.

## Verification

Focused tests passed against the source contract, adapter, July gate, H2 hold,
and an existing H2 analytics consumer:

- `sourceContract.test.ts` — 3 tests
- `productWiseMrpAdapter.test.ts` — 4 tests
- `julyReconciliation.test.ts` — 2 tests
- Latest focused verification: **5 files, 22 tests passed**
- Development runtime: August-only retailer facts return ₹5,64,03,177 Basic
  Order Value across 14 segments, 100% identified rows, and explicit partial
  source completeness. A July+August facts request raises
  `SECONDARY_SOURCE_SEAM_NOT_COMPARABLE`.

API TypeScript typecheck passed and `git diff --check` passed.

API and database package TypeScript checks passed. `git diff --check` passed.

## Final disposition

- Sections A and E: implemented and verified in code.
- Section B: source metadata is active for retailer facts; mixed-source
  arithmetic is refused.
- Section C: effective-MRP adapter is active for Product-Wise-only secondary
  discount, with derived-gross and coverage controls.
- Section D: **IMPOSSIBLE from CRM exports**, not pending. Independent
  aggregate bridges exist but cannot prove commercial equality.
- Permanent rule: pre-August and post-August retailer × item series are not
  comparable and must say so.