---
name: Deep Dive filter chain + state canon expansion
description: Geography→Distributor→State Head filter chain, distributor directory endpoint, and derived sale_line state CASE
---

- `GET /api/mgmt/distributor-directory?fy=` (lib/mgmt/distributorDirectory.ts) merges all heads' deep-dive snapshots into one distributor index. Geography basis = the serving member's roster state (distributor's own territory), NOT the retailer's state — the page header states this.
- Head↔state coverage comes from roster member states (canonicalised), so Karnataka = Prashant + Sandeep, Rajasthan = Pawan + Sunil Mohanty, West UP = Anant + Anuj + Sunil Mohanty. EAST U.P / WEST U.P stay distinct on purpose (business treats them as territories).
- STATE_CANON_NORMALISE now also maps JAMMU/KASHMIR/J&K → JAMMU AND KASHMIR, CHATTISGARH → CHHATTISGARH, MAHARASHTRA 2 → MAHARASHTRA, AP → ANDHRA PRADESH. The frontend copy lives in prayag `components/ui/StateFilter.tsx` (keep both in sync); REGION_GROUPS there is the single region mapping.
- **saleLineFilter.ts derives its state CASE branches from STATE_CANON_NORMALISE** — never hand-edit CASE lists there again; adding a mapping to stateCanon.ts propagates to all sale_line report filters. normStateExpr composes around the drizzle column ref (table renders as sale_line_all), not a hardcoded table name.
- Deep Dive detail view: geography/distributor filters narrow ONLY the distributor table for a selected head; other panels remain whole-head — the header must (and does) say so, or figures are misleading.
