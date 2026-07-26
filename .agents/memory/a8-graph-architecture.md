---
name: Phase A8 metrics graph architecture
description: Graph-traversal AI analyst (A8-A + A8-B) — routes, node types, resolver wiring, and key field names.
---

## What was built

**A8-A** — Two new API routes:
- `GET /api/graph/index?fy=&period=` — returns GraphIndex (shape, gap nodes, counts, cross-FY splits). Uses cached data only; never triggers new Sheets reads.
- `POST /api/graph/resolve` — resolves a list of paths to GraphNode objects. Hard cap: 20 nodes per call. Supports wildcards: `head/*/2026-27`.

Node levels implemented: `company`, `head`, `salesperson`, `distributor`, `time` (month), `gap`.

**A8-B** — `/api/analyze` (analyze.ts) now uses graph traversal instead of a fixed snapshot:
1. Builds graph index (fast, cached).
2. Defines a `resolve_nodes` tool for Claude.
3. Multi-round loop (max 5 rounds): Claude calls the tool, server resolves, Claude answers.
4. Numeric guard runs on the final answer.

## File locations

```
artifacts/api-server/src/lib/mgmt/graph/
  types.ts      — GraphNode, GraphIndex, MeasureValue, etc.
  gapNodes.ts   — GAP_NODE_REGISTRY, KNOWN_KEY_SPLITS, makeGapNode()
  resolvers.ts  — resolvePath(), resolveWildcard(), all node resolvers
  graphIndex.ts — buildGraphIndex(), graphIndexToPromptText()

artifacts/api-server/src/routes/graph.ts   — express routes
artifacts/api-server/src/routes/analyze.ts — A8-B (replaces old snapshot-based route)
```

## Key field name correctness (easy to get wrong)

- `DataQualityFlag.message` (NOT `.description`)
- `DistributorGroup.name` (NOT `.distributorName`)
- `DistributorGroup.retailerConcentration` (NOT `.concentration`)
- `DistributorGroup.orderBooking` for party OB (NOT `flows.partyOb`)
- `DistributorFlows.primaryDispatch` for primary in-flow
- Month data: `SecDashboard.members[].months[idx].orderedAmount / .salesAmount` (SecMonthData)
- MemberKpis has NO monthly arrays — use SecDashboard for month-level breakdown
- `loadStateHeadSale(fy).byHead` is a `Map<string, number>` (head name → primary sale)

## Path format

```
company/{fy}
head/{name}/{fy}
head/*/{fy}                          ← wildcard, all heads
salesperson/{name}/{fy}
salesperson/{name}/{fy}/month/{Mon}  ← "Apr","May","Jun",...
distributor/{name}/{fy}              ← searches all heads to find it
gap/live-year-sku
gap/finished-goods-cost
gap/receivables
gap/scheme-definitions
gap/mapping-confidence
gap/direct-dealer-entity-filter
```

## Known gap nodes (6 total)

1. `gap/live-year-sku` — no FY2026-27 secondary register
2. `gap/finished-goods-cost` — no fg_cost master
3. `gap/receivables` — no AR source
4. `gap/scheme-definitions` — scheme_def empty
5. `gap/mapping-confidence` — customer_master has zero rows
6. `gap/direct-dealer-entity-filter` — type_raw holds product groups

## Known cross-FY key splits

- "Sandeep Dadheech" (FY2026-27) = "Sandeep Ji" (FY2025-26)

## Company residuals

- 164 non-territory/Project/Govt customers sit outside named State Heads.
- ~35% of FY2026-27 customer population, ~₹6.08 Cr secondary OB.
- Sum of head secondary nodes ≠ company secondary total.

## Acceptance anchors verified

- `company/2026-27` secondary OB = ₹57.37 Cr, sales = ₹62.08 Cr, plan = ₹360.22 Cr
- `head/Anant Singh/2026-27` secondary OB = ₹2.52 Cr, primary sale = ₹2.74 Cr, 12 members
- `salesperson/Prasun Chatterjee/2026-27` secondary OB = ₹18.35L, children Apr/May/Jun
- Wildcard `head/*/2026-27` returns all 12 heads correctly
- Gap nodes returned with correct reasons

## A8-C (not yet built)

A8-C widens AI Reports page to generate from graph nodes. Depends on A8-A and A8-B. Not started.
