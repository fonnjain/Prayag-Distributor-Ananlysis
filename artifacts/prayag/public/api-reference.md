# Prayag Sales Intelligence — API Reference

> **Base URL:** `https://<your-domain>/api`  
> **Auth header:** `Authorization: Bearer <key>`  
> **FY format:** `YYYY-YY` (e.g. `2026-27`)  
> Invalid or revoked keys return `401`. Same-origin browser requests do not require a key.  
> Export endpoints return `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (`.xlsx`).

---

## Authentication

Include the key in an `Authorization` header on every request.

```bash
# Dashboard summary
curl "https://<your-domain>/api/dashboard?fy=2026-27" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Company-wide sales report
curl "https://<your-domain>/api/company-reports?fy=2026-27" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Customer performance
curl "https://<your-domain>/api/customers/performance?fy=2026-27" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

```js
const headers = { "Authorization": "Bearer YOUR_API_KEY" };
const base = "https://<your-domain>/api";

const dashboard = await fetch(`${base}/dashboard?fy=2026-27`, { headers }).then(r => r.json());
const reports   = await fetch(`${base}/company-reports?fy=2026-27`, { headers }).then(r => r.json());
const perf      = await fetch(`${base}/customers/performance?fy=2026-27`, { headers }).then(r => r.json());
```

```python
import requests

BASE    = "https://<your-domain>/api"
HEADERS = {"Authorization": "Bearer YOUR_API_KEY"}

dashboard = requests.get(f"{BASE}/dashboard",          params={"fy": "2026-27"}, headers=HEADERS).json()
reports   = requests.get(f"{BASE}/company-reports",    params={"fy": "2026-27"}, headers=HEADERS).json()
perf      = requests.get(f"{BASE}/customers/performance", params={"fy": "2026-27"}, headers=HEADERS).json()
```

---

## Endpoint Reference

### Dashboard & Analytics

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/dashboard` | Full dashboard snapshot — OB, sales, targets, achievement, per-member summary. | `fy` |
| `GET` | `/analytics` | Secondary analytics data (monthly trends, customer states, velocity). | `fy, stateHead, period` |
| `GET` | `/analytics/export` | Analytics data as `.xlsx` download. | `fy, stateHead` |
| `GET` | `/healthz` | Server health check. Returns `200` with `status: ok`. | — |

---

### Company Reports

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/company-reports` | Full company-level sales & OB report with per-head and per-state breakdowns. | `fy, monthFrom, monthTo, stateHead, states, level` |
| `GET` | `/company-reports/filters` | Available filter options (state heads, states, levels) for the current FY. | `fy` |
| `GET` | `/company-reports/export` | Company report as `.xlsx` download. | `fy, monthFrom, monthTo, stateHead, states, level` |

---

### Regional Reports

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/regional-reports` | State-level aggregated sales and OB with per-member drill-down. | `fy, stateHead, monthFrom, monthTo` |
| `GET` | `/regional-reports/export` | Regional report as `.xlsx` download. | `fy, stateHead` |

---

### Coverage Reports

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/coverage-reports` | Retailer coverage metrics — active, dormant, unvisited, new additions. | `fy, stateHead, member` |
| `GET` | `/coverage-reports/export` | Coverage report as `.xlsx` download. | `fy, stateHead` |

---

### Product / SKU Reports

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/product-reports` | Brand and category sales breakdown with YoY comparison. | `fy, stateHead, member` |
| `GET` | `/product-reports/export` | Product report as `.xlsx` download. | `fy, stateHead` |

---

### Momentum

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/momentum/insights` | One-scope momentum panel — Grow, Maintain, Recover, Win-Back by period. | `fy, stateHead, monthFrom, monthTo` |
| `GET` | `/momentum-reports/export` | Momentum report as `.xlsx` download. | `fy, stateHead` |

---

### Customers

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/customers/performance` | Customer-level sales, OB, units, Laspeyres price index, YoY change. | `fy, stateHead, member, monthFrom, monthTo, level` |
| `GET` | `/customers/churn` | At-risk and dormant customer scoring with median-gap model. | `fy, stateHead` |
| `GET` | `/customers/history` | Full purchase history timeline for a single customer. | `fy, customer` |
| `GET` | `/customers/detail` | Single-customer detail — OB, sale, codes, scheme nudge. | `fy, customer` |
| `GET` | `/customers/shrinkers` | Hidden shrinkers — customers where value is up but quantity is down. | `fy, stateHead` |
| `GET` | `/customers/distributor-risk` | Distributor concentration risk per customer. | `fy, stateHead` |
| `GET` | `/customers/months` | Closed months available for a given FY (used to build month pickers). | `fy` |
| `GET` | `/customers/multiplier` | Per-customer category revenue multipliers for scheme engine. | `fy, stateHead` |
| `GET` | `/customers/export` | Customer performance data as `.xlsx` download. | `fy, stateHead, monthFrom, monthTo` |
| `GET` | `/customers/schemes` | List all scheme definitions. | `fy` |
| `GET` | `/customers/schemes/:id` | Single scheme — tiers, nudge list, tracking. | `fy` |
| `GET` | `/customers/schemes/:id/push-list` | Customers ranked by incremental billing needed to hit next scheme tier. | `fy` |
| `GET` | `/customers/schemes/:id/tracking` | Real-time scheme achievement tracking for all enrolled customers. | `fy` |

---

### SKU Deep Dive

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/sku/facts` | Item-level secondary sales facts — net, qty, discount, Laspeyres. | `fy, stateHead, member, level, page, limit` |
| `GET` | `/sku/capability` | Which SKU pages and filters are available for the requested scope. | `fy, stateHead` |
| `GET` | `/sku/catalogue` | Full product catalogue with ever-sold flags per channel. | `fy` |
| `GET` | `/sku/trend` | Monthly secondary sales trend by item code. | `fy, code, stateHead` |
| `GET` | `/sku/recommendations` | Peer-cohort SKU recommendations ranked by headroom. | `fy, stateHead` |
| `GET` | `/sku/distributors` | Distributor SKU spread — breadth, active brands, segment coverage. | `fy, stateHead` |
| `GET` | `/sku/push-list` | Per-distributor peer-cohort push list (K3 Review + Push tabs). | `fy, stateHead, distributor` |
| `GET` | `/sku/discounts` | Discount distribution and movement analysis. | `fy, stateHead` |
| `GET` | `/sku/breadth-trend` | Brand breadth over time — how many brands each customer buys. | `fy, stateHead` |
| `GET` | `/sku/first-orders` | First-order cohort analysis — new codes by month. | `fy, stateHead` |
| `GET` | `/sku/lost-codes` | Item codes bought in prior FY but absent in current FY. | `fy, stateHead` |
| `GET` | `/sku/seasonality` | Seasonal index by brand/segment from prior-year history. | `fy, stateHead` |
| `GET` | `/sku/export` | SKU facts as `.xlsx` download. | `fy, stateHead` |

---

### Comparison

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/comparison/entities` | List entities (distributors, state heads, states) available for comparison. | `fy, type` |
| `GET` | `/comparison/catalogue` | Metric definitions and basis notes for the comparison engine. | `fy` |
| `POST` | `/comparison` | Run a comparison between two entities — produces cost, sales, OB, and SKU spread metrics. | `body: { fy, entityA, entityB, type, monthFrom?, monthTo? }` |
| `POST` | `/comparison/cohort` | Cohort comparison — benchmark an entity against its territory peer group. | `body: { fy, entity, type }` |
| `POST` | `/comparison/export` | Export comparison results as `.xlsx`. | `body: { fy, entityA, entityB, type }` |

---

### Distributor Management

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/mgmt/distributor-directory` | Full distributor directory with identity registry status. | `fy` |
| `GET` | `/mgmt/distributor-identity` | Identity registry — DIST# resolutions, ambiguous name pairs. | `fy` |
| `GET` | `/mgmt/distributor-deep-dive` | Multi-section deep dive: flows, SKU spread, investment, tiering. | `fy, stateHead, monthFrom?, monthTo?` |
| `GET` | `/mgmt/distributor-recon` | Distribution reconciliation — secondary-out vs primary-in gap. | `fy, stateHead` |
| `GET` | `/mgmt/distributor-tab` | Secondary / SKU / Push tab data for one distributor or a full state-head scope. | `fy, dist? OR head=&states=, tab` |
| `GET` | `/mgmt/distributor-tier-override` | List active distributor tier overrides. | `fy, stateHead` |
| `PUT` | `/mgmt/distributor-tier-override` | Set a tier override for a distributor. | `body: { fy, dist, tier, reason }` |
| `DELETE` | `/mgmt/distributor-tier-override` | Remove a tier override. | `body: { fy, dist }` |

---

### Management Data

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/mgmt/data` | State head dashboard — OB, sale, team targets, plan vs actual. | `fy, stateHead` |
| `GET` | `/mgmt/primary` | Primary sales (SAP) for a state head with period filter. | `fy, stateHead, monthFrom, monthTo` |
| `GET` | `/mgmt/deep-dive` | State head deep dive — state-level correlation, intra-team analysis. | `fy, stateHead` |
| `GET` | `/mgmt/pending-orders` | Pending order book — not yet converted to sale. | `fy, stateHead` |
| `GET` | `/mgmt/options` | Available state heads and members for filter dropdowns. | `fy` |
| `GET` | `/mgmt/member-sheet-coverage` | Which members have working sheets and their last-read status. | `fy, stateHead` |
| `GET` | `/mgmt/retailer-drift` | Retailers that changed distributor assignment between FYs. | `fy, stateHead` |
| `GET` | `/mgmt/retailer-identity` | Retailer identity registry — RET# resolutions. | `fy, stateHead` |
| `GET` | `/mgmt/unmatched-names` | Names in secondary register that don't match any known member. | `fy, stateHead` |
| `GET` | `/mgmt/bridge/status` | Distributor-TM bridge build status (background task). | `fy` |
| `GET` | `/mgmt/verify` | Cross-check control totals against verified anchors. | `fy` |
| `POST` | `/mgmt/report` | Generate a management summary report for a state head. | `body: { fy, stateHead }` |

---

### AI Reports

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/ai/payload` | Raw analytics payload used as AI report input — useful for debugging. | `fy, stateHead, member` |
| `POST` | `/ai/statehead-report` | State head narrative report (sections + guard result). | `body: { fy, stateHead, period? }` |
| `POST` | `/ai/suggestions` | Ranked action suggestions for a member. | `body: { fy, member, stateHead }` |
| `POST` | `/ai/travel-plan` | AI-generated monthly visit plan for a member. | `body: { fy, member, stateHead, period? }` |
| `POST` | `/ai/performance-review` | Structured performance review narrative for a member. | `body: { fy, member, stateHead, period? }` |
| `POST` | `/ai/presentation` | Slide deck script for a member review meeting. | `body: { fy, member, stateHead, period? }` |
| `POST` | `/ai/distributor-report` | Distributor-level analytics narrative. | `body: { fy, stateHead, distributor }` |
| `POST` | `/ai/distributor-statehead-report` | Distributor state-head narrative. | `body: { fy, stateHead }` |
| `POST` | `/ai/distributor-suggestions` | Action suggestions focused on distributor improvement. | `body: { fy, stateHead, distributor }` |
| `POST` | `/ai/distributor-review` | Structured distributor review. | `body: { fy, stateHead, distributor }` |
| `POST` | `/ai/distributor-presentation` | Slide deck script for a distributor review meeting. | `body: { fy, stateHead, distributor }` |
| `POST` | `/ai/full-report/distributor` | Full structured distributor report (10 sections, numeric guard, PDF-ready). | `body: { fy, stateHead, distributor, monthFrom?, monthTo? }` |
| `POST` | `/ai/full-report/statehead` | Full structured state-head report (10 sections, numeric guard, PDF-ready). | `body: { fy, stateHead, monthFrom?, monthTo? }` |
| `POST` | `/ai/full-report/growth` | Master Growth Report — Activate, Widen, Recover, Protect, Close, Where-Not-To-Look (company / state-head / state scope). | `body: { fy, scope, stateHead?, state?, monthFrom?, monthTo?, dormantRevivalPct?, atRiskRecoveryPct?, rangeUptakePct? }` |
| `POST` | `/ai/batch` | Batch AI report generation for all members of a state head (SSE stream). | `body: { fy, stateHead, reportType }` |
| `POST` | `/ai/chat` | Conversational follow-up on an existing AI report. | `body: { fy, stateHead, member?, reportType, question }` |
| `POST` | `/ai/report` | Legacy single-section AI report (prefer `/ai/full-report/*` for new integrations). | `body: { fy, stateHead, member, reportType }` |

---

### Organisation

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/org/state-heads` | Full roster of state heads with members, targets, and designation. | `fy` |
| `GET` | `/org/state-heads/alias-check` | Detect `head_canon` aliases that span multiple state heads. | `fy` |
| `GET` | `/org/state-heads/audit` | Roster audit — missing members, mismatched designations. | `fy` |
| `POST` | `/org/state-heads` | Add a new state head to the roster. | `body: { name, state, fy }` |
| `PATCH` | `/org/state-heads/:id` | Update state head fields (name, state, targets). | `body: partial StateHead` |

---

### Salespeople

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/salespeople/tree` | Org tree of state heads and their members (used for dropdowns). | `fy` |
| `GET` | `/salespeople/deep-dive` | Deep performance dive for one salesperson. | `fy, member` |
| `GET` | `/salespeople/verify` | Verify a salesperson's data integrity. | `fy, member` |

---

### Primary Sales (SAP)

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/primary-targets` | FY primary sales targets per state head. | `fy` |
| `GET` | `/drive/files` | List SAP `.xlsx` files available in Google Drive for upload. | `fy` |

---

### Audit & Verification

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/audit` | Full 10-group data audit — cross-foots, SAP lag, register health, truncation checks. | `fy` |
| `GET` | `/audit/download` | Audit report as `.xlsx` download. | `fy` |
| `GET` | `/verify` | Quick anchor-vs-DB verification for a given FY. | `fy` |

---

### Customer Master

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/customer-master` | Full customer master list with deduplication status. | `fy, stateHead` |
| `GET` | `/customer-master/:id` | Single customer master record. | — |
| `PUT` | `/customer-master/:id` | Update a customer master record (name, channel, mapping). | `body: partial CustomerMaster` |
| `GET` | `/customer-master/mismatch` | Customers whose master record conflicts with register data. | `fy` |
| `GET` | `/customer-master/mismatch/count` | Count of active mismatches. | `fy` |
| `GET` | `/customer-master/export` | Customer master as `.xlsx` download. | `fy` |

---

### API Keys

| Method | Path | Description | Params |
|--------|------|-------------|--------|
| `GET` | `/keys` | List all API keys (hashes never returned). | — |
| `POST` | `/keys` | Create a new API key. Raw key returned once only. | `body: { name, description? }` |
| `DELETE` | `/keys/:id` | Revoke a key by its numeric ID. | — |

---

## Common Query Parameters

| Parameter | Format | Description |
|-----------|--------|-------------|
| `fy` | `YYYY-YY` | Financial year, e.g. `2026-27`. Required on almost every endpoint. |
| `stateHead` | string | Normalised state head name (use `/org/state-heads` to list). |
| `member` | string | Normalised member/salesperson name. |
| `monthFrom` | `MMM-YY` | Period start, e.g. `Apr-26`. Inclusive. |
| `monthTo` | `MMM-YY` | Period end, e.g. `Jun-26`. Inclusive. |
| `level` | string | Aggregation level: `territory`, `state`, `company`. |
| `states` | string | Comma-separated state names for geography filter. |
| `page` | integer | 1-based page number for paginated endpoints. |
| `limit` | integer | Page size (default varies by endpoint). |

---

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `202` | Accepted — long-running build started; poll the same URL |
| `401` | Missing, invalid, or revoked API key |
| `403` | Valid key but insufficient permissions |
| `404` | Resource not found |
| `423` | Locked — register is frozen and the operation requires an unfreeze |
| `429` | Google Sheets quota exhausted; `retryAfter` in body |
| `500` | Internal server error |
| `503` | Service temporarily unavailable (quota or upstream failure) |

---

*Last updated: August 2026 · 14 endpoint groups · 100+ routes*
