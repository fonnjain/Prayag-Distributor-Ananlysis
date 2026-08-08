---
name: Production master-load routes
description: How customer/product master CSVs get loaded into the production DB
---
The production DB is read-only from the workspace, so master CSV loads run **inside the deployed app** via admin routes (`POST /api/admin/masters/customer-load|product-load`, `GET .../load-status`), gated by `X-Admin-Secret: SESSION_SECRET`, background 202+poll jobs.

**Why:** first prod attempt failed on `customer_master.head_confidence` NOT NULL DEFAULT 'Guessed' — dev only passed because its rows had preserved attribution; never insert explicit NULL into a NOT NULL-with-default column.

**How to apply:**
- Loaders live in `src/lib/uploads/` (exported functions; scripts stayed as CLIs) and resolve the **latest** timestamped `attached_assets/<prefix>_*.csv` — deployments snapshot the workspace, so untracked CSVs ship.
- In-memory job gating is process-local only; cross-instance exclusion comes from `pg_advisory_xact_lock` (74011001 customer / 74011002 product) inside each loader's transaction.
- Any loader code fix requires a re-publish before the prod route reflects it.
- Expected counts: customer_master 79,994 / retailer_user 96,398 / retailer_distributor 80,200; product 6,059 variants / 5,536 codes.
