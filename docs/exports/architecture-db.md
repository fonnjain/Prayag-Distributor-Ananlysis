## 1) Architecture Components

| Component | Technology | Responsibility | Key Files |
| :--- | :--- | :--- | :--- |
| **Frontend** | React, TypeScript, Tailwind CSS, Shadcn UI | Sales intelligence dashboard, SKU analytics, customer performance, AI report generation UI. | `artifacts/prayag/src/pages/Dashboard.tsx`, `artifacts/prayag/src/components/sku/SkuOverview.tsx` |
| **API Server** | Node.js, Express, TypeScript | Business logic, Google Sheets ingestion, SAP data processing, AI orchestration, PDF/Excel report generation. | `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/` |
| **Database** | Postgres (via Drizzle ORM) | Structured storage for sales records (primary/secondary), customer master, targets, and dashboard snapshots. | `lib/db/src/schema/`, `lib/db/src/index.ts` |
| **Ingestion Engine** | Google Sheets API, XLSX Streams | Incremental sync of sales registers, order books, and roster data from live spreadsheets. | `artifacts/api-server/src/lib/registers/`, `artifacts/api-server/src/lib/customers/registerSync.ts` |
| **AI Integration** | Anthropic (Claude 3.5 Sonnet) | Generates narrative sales reports from structured data payloads; includes a "Numeric Guard" for verification. | `lib/integrations-anthropic-ai/`, `artifacts/api-server/src/lib/mgmt/aiPayload.ts` |
| **Reporting** | ExcelJS | Generates formatted multi-tab Management Report Excel workbooks. | `artifacts/api-server/src/lib/mgmt/report.ts`, `artifacts/api-server/src/lib/mgmt/dashboardXlsx.ts` |

## 2) API Routes Inventory (Selected Key Routes)

| Method | Path | Purpose | Key Source File |
| :--- | :--- | :--- | :--- |
| GET | `/api/dashboard` | Fetches the latest aggregated dashboard snapshot (or triggers rebuild if stale). | `routes/dashboard.ts` |
| POST | `/api/dashboard/refresh` | Force-rebuilds the dashboard snapshot from live Google Sheets. | `routes/dashboard.ts` |
| POST | `/api/registers/sync/:fy` | Manually triggers a sync for a specific fiscal year's sales register. | `routes/registers.ts` |
| GET | `/api/customers/list` | Lists customers with performance metrics (quantity, value, risk scoring). | `routes/customers.ts` |
| POST | `/api/ai/report` | Orchestrates the generation of an AI-narrative sales report with numeric validation. | `routes/aiReport.ts` |
| POST | `/api/sap/upload-url` | Provides a signed URL for direct browser upload of SAP XLSX files to object storage. | `routes/sap.ts` |
| GET | `/api/mgmt/report` | Generates and downloads the multi-tab State Head Management Report Excel file. | `routes/mgmt.ts` |
| GET | `/api/sku/overview` | Provides SKU-level sales trends and focus-item analytics. | `routes/sku.ts` |

## 3) Database Tables & Views

| Table/View | Purpose | Key Columns with Types | Notes |
| :--- | :--- | :--- | :--- |
| `sale_line_all` | Invoice-line sales register (Primary). | `line_uid` (PK), `fy` (text), `invoice_no` (text), `amount` (numeric), `version_status` (text) | Uses `version_status` ('current'/'superseded') for idempotency. |
| `primary_order_line` | Primary order booking records. | `line_uid` (PK), `fy` (text), `qty` (numeric), `qty_unit` ('Pcs'/'Ltr'), `taxable_value` (numeric) | Differentiates tanks by Liter (Ltr) vs Pieces (Pcs). |
| `secondary_register_line` | Distributor-to-Retailer sales records. | `line_uid` (PK), `fy` (text), `customer` (text), `gross_amount` (numeric) | Distinct from primary sales; must not be summed together. |
| `customer_master` | Source of truth for customer attribution. | `id` (PK), `company` (text), `state_head` (text), `status` (text) | Used to flag mismatches between sale sheets and official attribution. |
| `dashboard_snapshot` | Cached dashboard aggregate JSON. | `id` (PK), `data` (jsonb), `manifest` (jsonb), `synced_at` (timestamp) | Built from a blend of DB and live Sheets. |
| `sap_sales` | Records processed from SAP XLSX uploads. | `id` (PK), `fy` (text), `month_label` (text), `amount` (numeric) | Used for historical comparison and data verification. |
| `primary_targets` | Sales targets (Primary). | `fy` (text), `month_label` (text), `head_canon` (text), `target_rupees` (numeric) | |

## 4) Data Sources (Ingestion Pipelines)

| Source | What it feeds | Sync Cadence | Files / ID (partial) |
| :--- | :--- | :--- | :--- |
| **Itemwise Sales FY24-25** | Dashboard (Legacy Primary) | On Dashboard Refresh | `1HgWelw...` |
| **Order Book FY26-27** | Primary Order Lines DB / Dashboard | Real-time interval (Open FY) | `1HFBAtv...` |
| **Retailer-Distributor Roster** | Dashboard Attribution / Management Reports | On Dashboard Refresh | `1EbWoXm...` |
| **State Head Dashboard FY26-27** | Secondary Order Booking Data | On Dashboard Refresh | `1E1jEY_...` |
| **Sale Registers (Multi-FY)** | `sale_line_all` (Primary Sales DB) | Startup Sync + Scheduled Timer | Defined in `register_sheets.json` |
| **Secondary Registers** | `secondary_register_line` DB | Manual / Force-Sync | Defined in `secondary_sheets.json` |
| **SAP Export (XLSX)** | `sap_sales` DB | Manual Browser Upload | Processed via `sapStream.ts` |

## 5) Background Jobs / Caches

| Name | Trigger | TTL / Freeze Rules | Description |
| :--- | :--- | :--- | :--- |
| **Register Sync Timer** | Server Startup | `OPEN_FY_RESYNC_MS` (interval) | Continually polls active FY sales registers for new rows. |
| **Dashboard Staleness Guard** | GET `/api/dashboard` | Conditional (Rebuild if DB > Snapshot) | Rebuilds snapshot if DB row counts exceed the snapshot manifest. |
| **AI Batch Result Cache** | AI Report Request | 1h (Open FY) / 24h (Closed FY) | Caches structured AI report outputs to avoid redundant LLM calls. |
| **Register Freeze** | Admin Config | Immutable once 'frozen' | Prevents any sync or manual writes to finalized fiscal years (in `frozen_registers.json`). |
| **Numeric Guard** | AI Generation | N/A (Validation Step) | Compares AI-generated numbers against source payload to flag hallucinations. |