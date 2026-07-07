---
name: Prayag dataset shapes
description: Non-obvious shapes in prayag_data.json's manifest that broke naive .map rendering
---
The Prayag sales dataset JSON is `{ data, manifest }`.

- `manifest.primary_sources` is a **nested object** keyed by source name (e.g. `product_itemwise_sales`), each value `{ desc, files_by_year, tab }`. Iterate with `Object.entries`, not `.map`.
- `manifest.sales_files` and `manifest.order_and_support_files` are **arrays of objects** (`{ name, category, fy|period, type, url, ... }`), not arrays of strings. Render specific fields.

**How to apply:** inspect actual JSON field shapes before wiring any list rendering; a subagent assumed string arrays and produced "object is not a valid ReactNode" type errors.
