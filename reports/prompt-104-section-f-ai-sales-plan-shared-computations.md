# Prompt 104 — Section F
## Future AI Sales Plan shared-computation design

**Status:** design only. No AI Sales Plan page, endpoint, database object, or
production register row is created by this specification.

**Related design:** `exports/prompt-101-ai-sales-plan-section-a.docx` contains
the read-only findings and the six-tab page design. This document narrows the
shared computation contract that must precede that page.

## Purpose and ownership

The future AI Sales Plan may consume one shared API surface for reusable,
source-labelled computations. Deep Dive pages remain the factual record of
what happened for an entity. AI Sales Plan owns visit-level recommendations,
rankings, and the reason for each recommendation. It must not silently
redefine a Deep Dive measure or present a recommendation as historical fact.

Every response and every exported figure must include `source` and `basis`
metadata. “Unavailable” is distinct from zero.

## Proposed API surface (design, not implementation)

One future read-only surface should accept a common request envelope:

```ts
type SharedSalesPlanRequest = {
  fy: string;
  period: { from: string; to: string; labels?: string[] };
  retailerId?: string;
  distributorId?: string;
  state?: string;
  peerBasis?: "same-distributor" | "same-state" | "national";
  portfolioSnapshotId?: string;
};
```

The response should expose four named computations. Each computation returns
its result plus:

```ts
type Basis = {
  source: string;          // table, view, or approved snapshot
  sourceVersion?: string;
  period: string;
  filters: Record<string, string | number | boolean | null>;
  population: string;
  coverage: { matched: number; total: number; pct: number | null };
  unavailableReason?: string;
};
```

### 1. Peer sets

- Default basis: **same distributor**, because it resolves for the full active
  retailer population in the approved analysis.
- Default coverage requirement: **100%** of eligible active retailers have a
  distributor key; a response must expose the matched and total counts rather
  than assuming coverage.
- Optional alternatives: same state where canonical geography resolves, then
  national.
- Return contributing distributor(s), peer IDs/count, inclusion/exclusion
  rules, and the size/value basis used for any refinement such as annual-value
  quintile.
- Source: `secondary_sku_line.distributor` for the default peer set; state
  peers must name their canonical customer/geography source and coverage.

### 2. Customer–SKU penetration

Return which retailers in the selected peer set buy each item code:

- `buyingRetailers`, `eligibleRetailers`, and `penetrationPct`;
- quantity and value basis, with the selected period;
- item-code normalization and unavailable-code counts;
- peer basis and peer count in the same response.

Source: `secondary_sku_line`, grouped by canonical retailer and `item_code`.
Do not substitute primary dispatch or a portfolio threshold for customer
purchase evidence.

### 3. Category-level adjacency

Return the subcategories a customer buys, the subcategories absent from that
customer, and coverage as `touched / registryTotal`, with the code assignment
coverage and registry version.

Source: the approved 31-subcategory code registry joined to
`secondary_sku_line.item_code`. This is **category-level only**.

The registry does not provide a code-level pipe/fittings split. Therefore the
API must not claim “buys CPVC fittings, no CPVC pipe” (or the inverse) until
Prayag supplies and approves a code-level registry split. At present it may
only say, for example, that CPVC is touched or not touched.

### 4. Versioned frozen top-80 portfolio snapshot

The top-80 set is a dated, immutable input to recommendations, never a live
threshold recalculated during a visit or export. A snapshot record must include:

- `snapshotId`, `frozenAt`, source and source period;
- exact code membership and the cumulative threshold method;
- code count and total value;
- category composition, if shown;
- supersedes/superseded-by links.

Two distinct references must be retained:

| Snapshot | Status | Codes | Value | Basis |
|---|---|---:|---:|---|
| `top80-reference-560` | prior reference | 560 | ₹107.54 Cr | Prompt 101 reference snapshot |
| `top80-live-566` | updated live reference to freeze before build | 566 | ₹110.99 Cr | Prompt 104 live analysis reference |

The second row is not a silent correction of the first. A future build must
choose one approved snapshot ID, display that ID/date/period, and preserve the
other version for reproducibility. Until the second snapshot is formally
frozen with its source date and period, recommendations must not call either
set “the current top 80%” without qualification.

## Required register follow-ups (not executed here)

These are exact proposed entries for the existing resolution register. They
require an approved production-register write in a separate task.

### F3 — no code-level pipe/fittings split

- **Code/title:** `F3_PIPE_FITTINGS_REGISTRY_SPLIT`
- **Owner:** Prayag
- **Priority:** low
- **Status:** open / design limitation
- **Evidence:** The approved 31-subcategory registry contains CPVC but does not
  split pipe from fittings.
- **Decision needed:** provide and approve a code-level registry split before
  any AI Sales Plan recommendation may claim “CPVC fittings, no CPVC pipe” (or
  the inverse).
- **Interim rule:** category-level adjacency only; do not infer the finer
  pitch.

### E5 — Composite source value is unmapped

- **Code/title:** `E5_COMPOSITE_UNMAPPED_SOURCE_VALUE`
- **Owner:** Prayag
- **Priority:** low
- **Status:** open / awaiting mapping decision
- **Evidence/source:** `sale_line_current` in both the development and
  production databases, filtered to `fy = '2026-27'`,
  `month_label = 'Sep-26'`, `source = 'sheets'`, and
  `LOWER(BTRIM(group_raw)) = 'composite'`. The relevant columns are
  `group_raw` (the source value), `group_canon` (blank), `amount` (the
  measure), `fy`, `month_label`, and `source`. The read-only evidence query
  is:

  ```sql
  SELECT fy, month_label, source, group_raw, group_canon,
         COUNT(*) AS lines,
         COUNT(DISTINCT code) AS codes,
         COALESCE(SUM(amount::numeric), 0) AS amount
    FROM sale_line_current
   WHERE fy = '2026-27'
     AND LOWER(BTRIM(group_raw)) = 'composite'
   GROUP BY fy, month_label, source, group_raw, group_canon;
  ```

  It returns `Sep-26 / sheets / Composite / 16 lines / 14 codes /
  ₹2,41,571.00` in both environments. The active
  `canonical_item_category_registry` has no `source_value`, `canonical_category`,
  or `item_code` row for `Composite`, so it has no registry assignment.
- **Decision needed:** determine the canonical registry assignment, or approve
  retaining it as `Unmapped`.
- **Interim rule:** keep it visible as `Unmapped`; do not silently map it in
  shared computations.

No production data or resolution-register row was changed while recording this
design.