---
name: Shared entity filter rollout
description: Durable rules for applying the shared State Head/State/Distributor filter across sale_line-backed report pages
---

# Shared entity filter — durable rules

- **Filtered variants never snapshot** — the key space is unbounded; every snapshot condition must include a no-filter check.
- **Prior-FY semantics**: head/state filter values describe the CURRENT FY. Prior-FY (and cross-FY, e.g. at-risk recency) figures must be scoped by resolving the filter to the current-FY customer set — never by applying head/state values to prior-FY rows directly (parties get reassigned between FYs).
- **Param collision trap**: the shared bar sends `states` as a JSON array, but Customers routes historically accepted `states` as comma-separated raw state_canon values. When the shared filter is active, the legacy interpretation must be disabled or a JSON-array value gets applied verbatim and matches nothing (empty results that silently disagree with the export). Any future page adopting the shared params must check for legacy same-named params first.
- **Retailer/secondary channel**: the secondary register has no state or distributor dimensions — reject shared filters at that level (HTTP 400) and hide the bar, rather than silently ignoring them.
- **Exports**: filtered exports must be self-describing (Info cover sheet naming basis + active filters, `_filtered` filename suffix) and keep the row cap + concurrency guard.
- **SKU breadth denominators** (codesEverSold) intentionally stay company-wide under filters; state this on the export cover sheet.

## Sub-year period (months param) rollout — Aug 2026
- Products (/api/product-reports), Growth (/api/analytics) and the Momentum export accept `months=Apr-26,May-26` (comma labels). Validate with `parseMonthsParam` in api-server `lib/periodMonths.ts` — it rejects cross-FY labels (Apr-25 under fy 2026-27) and dedupes; never reduce labels to bare month names before validating.
- A months selection, like entity filters, always bypasses snapshots AND forces the register source in buildAnalytics (SAP aggregate has no month×head/month×cost dims).
- Pass the REQUESTED labels into head/margin/group queries, not labels derived from returned data — an empty derived array silently means "no filter" (full FY).
- Frontend: `usePeriodMonths()` in prayag `src/data/period-months.ts` (primary bound per PA1). Momentum slices client-side; its group chart stays full-FY (source has no month×group).
