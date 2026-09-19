# Prayag Operating Rules

**Canonical:** read this file before answering any data question, writing any
query, or building any surface. It takes precedence over recollection. Every
figure names its source and database.

## 1. Which table carries what

- Primary sale / dispatch: `sale_line_current`.
- Secondary order booking: `secondary_order_line` (RET# + DIST# here).
- Secondary SKU history: `secondary_sku_line` (no RET#/DIST#).
- Brand/segment mirror: `secondary_register_line` (no item code).
- Head monthly plan: `secondary_head_month`.
- Margin: `margin_fact` (to June 2026 only).
- Current MRP: active `mrp_synced` and `mrp_synced_division`, sourced from
  `https://prayag-price.com/api/v1/products`, paginated at 500.

The MRP refresh runs five minutes after production startup and every 24 hours.
It stages an immutable `mrp_sync_generation`, writes all rows, and activates
only the complete generation. Failure rolls back and records the latest error
in `mrp_sync_status.last_error`; the previous generation keeps serving.
Closed periods use effective-dated `mrp_history`; the open FY uses active
`mrp_synced`.

## 2. Environment

Every figure states development or production and its source table, file, or
API. Development is for builds/tests; production is the live decision surface.
Production reconciliation queries are read-only.

## 3. Empty, zero, and unavailable

Zero is a measured zero; empty is a source with no rows; unavailable is a
held/absent source or period. Never convert unavailable or unpriced data to
zero.

## 4. What a measure actually is

Primary sales are taxable dispatch values from `sale_line_current`. Secondary
booking is `secondary_order_line` basic order value. Secondary SKU value is the
Product-Wise register NET amount. Head-month plan, ordered, and received are
separate `secondary_head_month` measures.

**Secondary SKU source seam:** every retailer×item payload, chart, tooltip, and
export carries source, value basis, completeness, and identity coverage for
each month. A source change is visible and is never treated as a continuous
comparable series by default.

From August 2026 onward, Product-Wise retailer×item data is the supported
secondary source for every surface whose metric is defined on that source.
Each result must retain its source, value basis, month, cutoff, completeness,
and identity coverage. Product-Wise values use Basic Order Value ex-GST;
PSCode3 values through July use net amount. A view crossing the seam may
compare explicitly labelled counts, but must not add or compare rupees.
Discount/gross is **derived from MRP** where an effective price exists; a
missing price is unavailable for that period, never a zero.

**Implemented not-offered behaviour:** a closed-period sale with no
effective-dated MRP row is excluded from discount and realisation calculations.
Current MRP is never substituted for a past period. A product with no price in
a period was not offered in that period.

## 5. Units

Do not sum incompatible units. State litres, pieces, and other units
separately. Monetary values state their basis (taxable, basic-order, NET,
gross margin, or other).

## 6. Time

State fiscal year, month labels, timezone, and completeness. Open months are
provisional. Closed-period prices use the price effective in that period.

**RULE 6.1 — permanent secondary source seam:** PSCode3 ends on 31 July 2026; Product-Wise is the sole secondary source from 1 August 2026 (SORD-9) onward. There is no overlap month. Rupees are never summed or compared across the seam; counts may be compared when their population and completeness are named. Every new month loads from Product-Wise automatically.

This source change removes no capability. Historical PSCode3 observed MRP and gross columns remain historical observations; where an effective-dated MRP exists, discount/gross is rebuilt and labelled **derived from MRP**. A code without an effective price is not offered for that period. Product-Wise rows without a confirmed Item Type remain visible as **Unmapped**, never dropped.

## 7. Annualisation and projection

Do not annualise a partial FY without stating observed months and assumptions.
Projections are not actuals and never overwrite source figures.

## 8. Matching and identity

Use stable source identifiers before normalized names. Secondary RET#/DIST#
identity comes from `secondary_order_line`; `secondary_sku_line` has neither.
Exact-code absence and resolver-aware matching are different bases.

When both tables are fed from the same source, the tables themselves do not
create a retailer×item divergence. Production July 2026 PSCode3 reconciles
exactly: 32,378 retailer×item pairs and Rs 22,34,36,806 on both
`secondary_order_line.basic_order_value` and
`secondary_sku_line.net_amount`. Any future difference must first be treated
as a source difference, not a table difference. Source: production database,
July 2026 PSCode3 reconciliation accepted 18 September 2026.

## 9. Grouping vocabularies

Grouping assignments are explicit. A new size in an existing series may inherit
its Item Type; a new series may not. A new series in a price list needs a
grouping-master entry before first sale.

Every MRP refresh checks the active catalogue against the grouping master.
Priced codes without an assignment are reported, not inferred from prefix,
division, series, or MRP.

## 10. Margin

Margin/contribution is not profit. Cost basis, effective-price basis, period,
excluded rows, and coverage accompany every result. `margin_fact` is available
only through June 2026 unless a newer source is named.

## 11. The Resolution register

The register is the audit history of pending questions, holds, evidence, and
decisions. PENDING never changes calculations. Only an open HOLD with
`blocks_api = true` can make a named factual measure unavailable. Closed
records are immutable in meaning; later evidence uses a new linked record.

Priority is constrained (`urgent`, `high`, `medium`, `low`) and relationships
use stable resolution codes and constrained relation types.

## 12. Evidence discipline

**Unit and outlier tests are row-level. One bad row never excludes a code.**
For Product-Wise MRP controls, a row is `UNIT_MISMATCH` only when its implied
MRP / effective catalogue MRP ratio is outside 0.5 through 2.0 inclusive.
Rows more than 5% from their code's modal implied MRP are `PRICE_OUTLIER`
controls, but remain priced and included.

Unpriced code counts differ by **basis**. Exact-code absence and
resolver-unresolved are different measures and must never be compared without
stating which is which. The accepted P021 comparison was 814
resolver-unresolved versus 870 and 871 exact-code; the 54-code / Rs 1.56 Cr
difference was definitional, not data movement. Source: P021 production
reconciliation.

The 70-code discontinued annex is no longer retained, so the Rs 7.69 Cr
residue is arithmetic subtraction, not row-level classification. Same
limitation as P30, P40, and P49; their register evidence remains authoritative.

## 13. Publish and schema

Development migrations are replay-safe and transactional, with stable ledger
IDs and conditional writes that do not overwrite administrator edits.
Production schema changes use Publish. Keep production objects represented in
development and do not rely on NULLS NOT DISTINCT constraints.

## 14. Known blocked or absent

The accepted P021 exact-code authority gap was 871 codes / Rs 11,05,90,833.82;
the resolver-unresolved measure was 816 codes / Rs 9,49,25,358.94. The 55-code
formatting recovery is part of the resolver distinction. These are dated
measurements from the P021 production reconciliation and are not interchangeable.

The UGD Self Fit Pipe series has ten codes, prices effective 10 August 2026,
and no grouping-master assignment. Production's active MRP generation fetched
18 September 2026 contains all ten; development's 20 August 2026 generation
is stale and lacks them. This is a category-assignment pending item, not a
production price-sync failure.

## 15. How to answer a question

Lead with the answer and name environment, source/database, period, measure,
basis, and completeness. Separate competing definitions. State whether each
number is actual, provisional, excluded, unavailable, or pending. Keep
superseded figures in the Resolution register rather than rewriting rules.
