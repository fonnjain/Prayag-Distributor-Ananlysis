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
