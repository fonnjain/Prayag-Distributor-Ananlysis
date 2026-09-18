# Product-Wise Prompt 116 — implementation and gate report

**Date:** 18 September 2026  
**Implementation scope:** corrected H2 source-change hold, source contract,
read-only effective-MRP adapter, and isolated July reconciliation gate.  
**Consumer status:** no existing consumer, route, UI surface, ingestion loader,
or database table was changed or enabled.

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

- H2 is a permanent Product-Wise source-change hold, not a missing-export
  reminder.
- PSCode3 ended after July 2026; no August PSCode3 export is requested.
- Product-Wise retailer × item data exists in `secondary_order_line`, but its
  value basis differs from the legacy SKU register.
- The scope is `Aug-26 onward`, and the owner is the internal parity build.
- The evidence lists the blocked SKU surfaces and records that only PSCode3's
  observed MRP/gross fields are irreproducible; the calculation is rebuildable.
- The central hold resolver now applies open-ended month scopes to every
  concrete month and fiscal year from August 2026 onward.

The surface remains withheld rather than displaying zero.

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
- Cross-source aggregation throws unless an explicit approved-equivalence flag
  is supplied.
- `secondarySeam()` emits the required July/August disclosure.

The contract is pure and is not yet wired into existing consumers. This is
intentional: Section D6 prohibits changing consumer surfaces before the D2–D4
report. Therefore Section B's contract/enforcement layer is implemented, but
its “every row and every node” rollout remains gated by the missing July
comparison.

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

## Section D — isolated reconciliation gate

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

The current result is intentionally:

**BLOCKED — no independent July Product-Wise export is present.**

The approved PSCode3 target control remains 34,147 rows,
₹223,436,806 net, and ₹442,326,730.10 gross. Those values are not treated as
evidence of Product-Wise parity.

## Verification

Focused tests passed against the source contract, adapter, July gate, H2 hold,
and an existing H2 analytics consumer:

- `sourceContract.test.ts` — 3 tests
- `productWiseMrpAdapter.test.ts` — 4 tests
- `julyReconciliation.test.ts` — 2 tests
- Total combined verification: **5 files, 27 tests passed**

API TypeScript typecheck passed and `git diff --check` passed.

API and database package TypeScript checks passed. `git diff --check` passed.

## Final disposition

- Sections A and E: implemented and verified in code.
- Section B: central contract and cross-seam refusal implemented; rollout into
  existing rows/nodes is correctly stopped at D6.
- Section C: read-only MRP adapter implemented and verified; not activated on a
  consumer.
- Section D: **BLOCKED** because no independent July Product-Wise export is
  present. D2–D4 and commercial-basis equivalence are not claimed.

The independent July file is required before the D2–D4 report can be produced
or any existing secondary consumer may be changed.