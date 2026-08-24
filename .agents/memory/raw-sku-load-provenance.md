---
name: Raw SKU load provenance
description: Durable rules for traceable protected raw-SKU loads and raw-SKU freshness reporting.
---

Protected raw-SKU archive loads must retain source note, operator, upload instant, archive SHA-256, fiscal month, row count, and NET total as load-level evidence only after the guarded data replacement succeeds.

**Why:** B3 and S1 depend on retailer-level raw SKU transactions. A reviewed one-off archive cannot be audited or safely interpreted later if the origin and reconciled result are lost.

**How to apply:** Keep this evidence separate from transaction rows and write it inside the successful load transaction. Require the human-readable source note and operator before processing a binary archive.

Alert freshness must use the newest distributor-level raw-SKU line ingestion timestamp rather than a particular archive record.

**Why:** The protected July archive is only one valid source. Future approved loaders or schedulers must update the same visible freshness signal without source discovery or a hidden fallback.

**How to apply:** Return latest raw-SKU month, load timestamp, and age with B3/S1 coverage. Render an explicit unavailable state when no timestamp exists; do not infer freshness from MRP, aggregate dashboards, or primary-month availability.