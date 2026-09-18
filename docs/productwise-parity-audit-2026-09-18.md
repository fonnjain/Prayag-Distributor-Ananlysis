# Product-Wise / PSCode3 parity audit

**Audit date:** 18 September 2026  
**Mode:** read-only inspection and source/schema review. No ingestion code, database
rows, source files, or application behaviour was changed for this report.  
**Requirement audited:** `attached_assets/Pasted-PSCode3-is-discontinued-Product-Wise-is-the-sole-source_1789721725896.txt`.

## Executive conclusion

Product-Wise is capable of functional parity, and is a net gain in identity and
order-state detail. I found no capability that is irreproducible merely because
PSCode3 is discontinued. There are, however, two different kinds of parity:

1. **Analytical parity:** Product-Wise can supply the row, identity, period, and
   value needed by the existing calculations, provided each month keeps its
   source and value basis.
2. **Observed-field parity:** Product-Wise does not contain PSCode3's observed
   `mrp` and `gross_amount` columns. The existing effective-dated MRP catalogue
   can supply the MRP join, and gross can be reconstructed where the discount
   is valid, but reconstructed gross must not be represented as an observed CRM
   field.

The practical answer is therefore **YES WITH WORK**, not NO, for the secondary
discount and every dependent surface. The work is a source-aware adapter and
control test, not a replacement source. Until that control is accepted,
August Product-Wise must remain an isolated, explicitly labelled view and must
not be used in B3, secondary discount, or multi-month conclusions.

## Source and cutoff ledger

| Source / table | What it proves | Cutoff used in this audit |
|---|---|---|
| `secondary_sku_line`, source `pscode3_xlsx`, `artifacts/api-server/src/lib/secondary/pscode3Jul26.ts` | Legacy retailer × item rows, PSCode3 MRP/gross/net/discount, July control | Approved July 2026 PSCode3 archive; the loader's fixed month is `Jul-26` |
| `secondary_sku_line`, source `productwise_xlsx`, `artifacts/api-server/src/lib/secondary/productWiseAug26.ts` | Product-Wise rows mirrored into the legacy SKU shape; basic value is ex-GST net basis; MRP/gross are null by design | Approved 1–19 August 2026 Product-Wise CRM export; month `Aug-26` |
| `secondary_order_line`, Product-Wise source | CRM order identity, GST, status, geography, dealer/CP identity, basic order value | The Product-Wise loaded period; August onward only unless a separately reviewed month is loaded |
| `mrp_history` / `mrp_synced`, `artifacts/api-server/src/routes/mrp.ts` | Effective-dated closed-period MRP and current/open-FY MRP | Effective at the transaction period; `mrp_history` for closed periods and `mrp_synced` for the open FY |
| `person_registry` and distributor registry | Head/state attribution routes | Registry state at read time; attribution must be reported with its coverage and unresolved population |

## Exhaustive capability inventory

The inventory below covers every consumer found by tracing
`secondary_sku_line`, its SKU facts services, the secondary register mirror, and
the routes that expose those results. “YES” means the current Product-Wise
columns support the capability without a semantic change. “YES WITH WORK”
identifies a bounded adapter, control, or source-seam disclosure. “NO” is
reserved for a field-level impossibility; none was established.

| Surface / capability | PSCode3 capability and required fields | Product-Wise result and field-level proof |
|---|---|---|
| Retailer detail / retailer × item drill-through | `retailer`, `retailer_id`, `item_code`, `qty`, `net_amount`, month, member/distributor | **YES WITH WORK.** Product-Wise has `Customer Name`, `Dealer ID`, `Product Code`, `Qty`, date/month, CP name/code, and Basic Order Value. Use `dealer_id` as the canonical retailer key; preserve the CRM name and source. |
| Item facts and SKU detail | Positive retailer-item pairs, code, qty/value, month, source metadata | **YES WITH WORK.** `skuFacts.ts` currently excludes `productwise_xlsx`; remove that exclusion only in a source-aware Product-Wise view. Do not silently coerce CRM basic value into the PSCode3 gross/net schema. |
| Breadth | Distinct codes bought divided by the authoritative “codes ever sold” denominator, by segment | **YES WITH WORK.** Product-Wise has `Product Code` and `Category Name`; reuse the catalogue denominator and label the August population separately. Do not use a mixed source population as one denominator. |
| Gaps / unbought value | Catalogue codes absent for a retailer, with a value basis for ranking | **YES WITH WORK.** Product-Wise supports absence/presence and category through `Product Code` and `Category Name`. Gap value requires either the effective MRP join or an explicitly unavailable value basis; it must not use a missing gross column as zero. |
| Push recommendations | Retailer-item gaps, distributor/territory scope, ranking value, coverage guard | **YES WITH WORK.** Identity is better (`Dealer ID`, CP code, geography). Keep the existing coverage/wipe guard and suppress recommendations if the Product-Wise month is incomplete or the MRP/value basis is unavailable. |
| Peer penetration | Peer cohort identity, retailer-item buyers, same-distributor/state scope, eligible denominator | **YES WITH WORK.** Product-Wise supplies stable dealer and CP identity, product code, state, and value for quintile refinement. Build peers within one source/month population; never join August Product-Wise peers to July PSCode3 facts. Cohorts under five remain unavailable under the existing safety rule. |
| B3 / multi-month retailer-item comparison | Month-by-month positive pairs and comparable value basis | **YES WITH WORK.** Product-Wise supports August onward facts, but August must remain isolated until the July control and source-basis seam are approved. It must not be appended to PSCode3 as if `basic_order_value` were proven identical to historical `net_amount`. |
| Secondary discount | Gross × (1 − discount) = register net; discount percentage and item MRP | **YES WITH WORK.** CRM has `Discount (%)`, `Discount Amount`, `Basic Order Value`, and `Product Code`, but no observed MRP/gross. Join Product Code to effective-dated MRP with the same `mrp_history`/`mrp_synced` and not-offered rules used by primary discount. Reconstruct only with an explicit “derived gross” label and a row-level completeness control. |
| Segment spread | Category/segment by retailer, member, and item | **YES WITH WORK.** Product-Wise has `Category Name`; use the registry/catalogue assignment and emit `Unmapped` when no reviewed assignment exists. Never infer category from product-code prefix or price. |
| Win-back / dormant retailer logic | Historical retailer-item absence/presence over months plus customer identity | **YES WITH WORK.** Product-Wise dealer IDs make identity stronger. The work is a source-separated monthly history and an explicit “not loaded” state, not treating missing CRM months as zero. |
| Trends / momentum | Monthly row/value/qty series with source and value basis | **YES WITH WORK.** Product-Wise supplies the post-August series; PSCode3 supplies pre-August history. Every multi-month chart must show the seam and must not sum the two bases before equivalence is established. |
| Secondary discount alerts | Discount anomaly, MRP availability, threshold, item and retailer identity | **YES WITH WORK.** Product-Wise provides discount and identity. The alert must require the effective-MRP join and must route missing MRP as unavailable, not as zero discount or zero value. |
| SKU breadth/gap alerts | Coverage denominator, retailer-item gaps, source freshness | **YES WITH WORK.** Existing alerts can consume Product-Wise after the completeness and frozen-month controls are wired. August rows must carry Product-Wise provenance. |
| B3 / SKU canary and reliability alerts | Reconciliation between SKU detail and register, freshness, source controls | **YES WITH WORK.** Product-Wise can be tested against its own CRM/order register. A PSCode3-vs-Product-Wise cross-source equality is not a row-for-row canary. |
| Secondary/order exports | Raw/detail fields and aggregate order values | **YES.** Product-Wise is richer: the order export includes order ID/date, sales user, dealer, CP, geography, GST, quantity, discounts, status, and basic value. Legacy exports remain source-labelled rather than pretending both eras have identical columns. |
| SKU facts export | Retailer, code, qty, value, breadth, gap and source metadata | **YES WITH WORK.** Add a Product-Wise source view and preserve per-month source/value-basis columns. Do not export a combined “net” column without the source seam. |
| Company/distributor/head reports consuming secondary SKU totals | Member/distributor/customer/item roll-ups | **YES WITH WORK.** Product-Wise has stronger identity routes. Existing report builders need a source-aware month adapter and separate coverage/unassigned fields. |
| Secondary target/achievement comparisons | Numerator, denominator, period, source and target basis | **YES WITH WORK.** Product-Wise can provide the order-booking numerator. Target and achievement must retain their own source and period; booking must never render as dispatch/sales. |

### Capabilities genuinely not reproducible

No required business capability is proven impossible. The following **observed
fields** are not present in Product-Wise and cannot be recovered from the CRM
row itself: historical PSCode3's original `mrp` as observed on that export, and
historical PSCode3's original `gross_amount` as observed on that export. They
can be replaced for calculations by effective-dated MRP and a derived gross
where the discount/value controls pass, but the result is not the original
observed field. If the requirement is specifically “show the original CRM
gross column,” that is **NO**, because the Product-Wise schema has no such
column. This does not create capability loss for the discount calculation.

## MRP, gross, and secondary discount

The candidate gap is narrower than it first appears:

* PSCode3 writes `mrp`, `grossAmount`, `netAmount`, and `discountPct` from the
  July workbook (`pscode3Jul26.ts`, parser fields at the approved July cutoff).
* Product-Wise's reviewed header contains Product Code, GST, quantity, Discount
  %, Discount Amount, Dealer Order Value, and Basic Order Value. The loader
  intentionally maps **Basic Order Value (ex-GST)** to `netAmount` and writes
  `mrp = null` and `grossAmount = null`
  (`productWiseAug26.ts`, Product-Wise August cutoff).
* Primary discount already resolves `sale_line.code` against `mrp_history` for
  closed periods and `mrp_synced` for the open FY, while applying the
  not-offered exclusion (`routes/mrp.ts`, effective-period query paths).
  Product-Wise `product_code` is the same item-code join key as `sale_line.code`.

Therefore the same catalogue join **can serve secondary discount**:

1. Select the effective MRP by Product Code and transaction month.
2. Apply the same not-offered and missing-MRP rules.
3. Retain Product-Wise discount percentage and basic ex-GST value.
4. Derive a gross basis only when the row has a valid discount and the
   denominator is non-zero; label it derived, not observed.
5. Reconcile the derived net against the Product-Wise Basic Order Value and
   expose row counts, missing-MRP counts, and excluded codes.

### July control

The known July control is **only** the approved PSCode3 accepted total. The
loader records **34,147 accepted rows and ₹223,436,806 net** (₹22,34,36,806 in
Indian grouping), with **₹442,326,730.10 gross**; source and cutoff are the
approved `Jul-26` PSCode3 archive and the fixed controls in
`pscode3Jul26.ts`. No independent July Product-Wise export or Product-Wise July
control was found and queried during this read-only audit.

Consequently, **cross-source equality is NOT YET PROVEN**. The Product-Wise
parity run remains required: query an independently loaded July CRM/order
register with the same item/date/value filters, reconcile it to the approved
PSCode3 control, and compare row-level inclusion/exclusion rules before the
secondary discount adapter is approved. The PSCode3 total is a target control,
not evidence that Product-Wise already matches it.

The July run must also establish whether `net_amount` and
`basic_order_value` have the same commercial definition and whether
GST/returns/status exclusions are identical. Until that run and its evidence
are accepted, semantic value-basis identity and cross-source schema equality
must both be treated as unproven, and every multi-month series must disclose
the seam.

## Product-Wise additions

These fields were not available in the PSCode3 capability described by the
legacy SKU line:

* GST type/category, GST rate, and GST amount;
* employee/sales-user identity and reporting-manager route;
* dealer mobile, district, city, and pincode;
* channel-partner name and CP code on every accepted CRM row;
* order status, including approved versus pending;
* stable Dealer ID and order ID, improving retailer/order deduplication and
  source auditability.

At the approved August Product-Wise cutoff, the loader controls report **8,602
rows, ₹56,403,177 basic order value, 322,465 quantity, 1,132 retailers, 128
distributors, 1,605 item codes, 121 salespeople, 1,361 orders, and 430 pending
rows**. These figures are from `productWiseAug26.ts`'s reviewed August CRM
control, not extrapolations to later months. They demonstrate that the source
change is a net identity and workflow gain, while the value basis remains
explicitly ex-GST basic order value.

Geography is richer but not complete: the H4 audit records **46.27% geography
resolved** at its reported audit cutoff. The unresolved remainder must stay
unavailable/unmapped; the new columns do not justify inferred geography.

## Head and state attribution

PSCode3 carried canonical head and state directly on its accepted SKU rows.
Product-Wise carries CP code, channel-partner identity, sales-user/employee
identity, reporting manager, and state. Canonical attribution is derivable by
two independent routes:

1. Resolve `cp_code` through the distributor registry to canonical distributor
   and state.
2. Resolve employee ID through `person_registry` to the salesperson/reporting
   manager and then the canonical state-head route.

The result should be classified as direct, registry-derived, conflicting, or
unassigned. Never select one route silently when the two disagree. The
reconciliation must expose counts and value by route and the unresolved
population. Product-Wise can therefore be stronger than PSCode3, but only
after registry coverage and conflict controls are measured at the read cutoff.

## Ordered plan: effort versus value

| Order | Work | Effort | Value / acceptance evidence |
|---:|---|---|---|
| 1 | Freeze a source contract: PSCode3 through July; Product-Wise from August; source, value basis, month, cutoff, and completeness on every row/node | Low | Prevents silent mixed-era arithmetic; every multi-month response names the seam |
| 2 | Build the Product-Wise-to-MRP effective-date adapter with not-offered rules and derived-gross disclosure | Medium | Secondary discount parity; row-level MRP coverage and July net control at ₹22,34,36,806 |
| 3 | Add July dual-source reconciliation at row, item, retailer, and total levels | Medium | Proves the control population, while explicitly not overclaiming semantic equivalence |
| 4 | Replace SKU facts, breadth, gaps, push, B3, segment spread, and trends with source-aware monthly adapters | Medium–High | Restores the highest-use SKU surfaces without contaminating historical bases |
| 5 | Wire Product-Wise identity to retailer/distributor/person registries; expose conflicts/unassigned | Medium | Stronger head/state attribution and reliable geography/status filters |
| 6 | Add source-aware alerts, canaries, and exports; distinguish unavailable from zero and preserve frozen-month provenance | Medium | Prevents false recommendations and makes the new source auditable |
| 7 | Add peer penetration, win-back, dormant, and multi-month comparisons on same-source populations | High | Restores cohort and longitudinal decisions safely |
| 8 | Run a full parity regression over every consumer listed above and publish the evidence/control manifest | Medium | Demonstrates no capability loss and catches future source-seam drift |

## Final disposition

**Parity status:** Product-Wise is **YES WITH WORK** for all required business
capabilities; **NO** only for reproducing PSCode3's original observed
`mrp`/`gross_amount` fields as literal CRM columns. Those fields are not needed
to preserve the secondary discount capability if the effective-dated MRP and
derived-gross controls pass.

**Source policy:** PSCode3 is discontinued as an August source. Product-Wise is
the sole August-onward source. This audit is a report only; no source loader,
database table, ingestion route, or application calculation was changed.