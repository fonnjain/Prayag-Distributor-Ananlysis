/**
 * Static gap node registry — A8-A.
 *
 * A gap node is a REAL answer. "Item-code detail is not available for FY2026-27
 * because no register exists for the live year" is far more useful than silence
 * or a fabricated number.
 */

import type { GapNodeMeta, GraphNode } from "./types.js";

export const GAP_NODE_REGISTRY: GapNodeMeta[] = [
  {
    path: "gap/live-year-sku",
    reason:
      "No FY2026-27 secondary register exists. The secondary register (distributor→retailer " +
      "line-level data) is only available for closed fiscal years FY2021-22 through FY2025-26.",
    blocks:
      "Item-code detail, segment NET, discount, day-level date ranges for the current year. " +
      "All SKU-level and segment-level questions for FY2026-27.",
  },
  {
    path: "gap/finished-goods-cost",
    reason:
      "No finished-goods cost master (fg_cost) is loaded. The cost_master table is empty.",
    blocks:
      "Gross margin, net margin, profit, ROI at every level (company, head, member, distributor, retailer).",
  },
  {
    path: "gap/receivables",
    reason: "No accounts-receivable source is wired to the application.",
    blocks:
      "Distributor investment, true cost to carry, receivables ageing, working-capital analysis.",
  },
  {
    path: "gap/scheme-definitions",
    reason:
      "scheme_def and scheme_slab tables are empty. The nudge engine reads a SEPARATE bundled " +
      "JSON (scheme_master.json); the two systems are unconnected.",
    blocks:
      "Scheme eligibility, scheme-ROI comparison, scheme-cost inclusion in true cost-to-serve.",
  },
  {
    path: "gap/mapping-confidence",
    reason:
      "customer_master has zero rows. The Confirmed-versus-Guessed split that D1 requires " +
      "cannot be computed.",
    blocks:
      "Attribution confidence scores, the 'confirmed' vs 'guessed' distributor split, " +
      "reliable customer deduplication across data sources.",
  },
  {
    path: "gap/direct-dealer-entity-filter",
    reason:
      "type_raw holds product groups, not entity types (Distributor / Direct Dealer / Retailer). " +
      "The entity-type filter therefore returns zero for every FY.",
    blocks:
      "Entity-type segmentation by sale_line. Use member-sheet channel column (blank = unassigned) " +
      "as the proxy instead.",
  },
];

// Known cross-FY key splits that produce CROSS_FY_KEY_SPLIT flags.
// All six pairs confirmed as never co-existing in the same FY (DB diff, Jul 2026).
// Source of truth: src/lib/headSplits.ts — keep in sync when adding new pairs.
export const KNOWN_KEY_SPLITS = [
  { level: "head" as const, name: "Sandeep Dadheech",  missingIn: "2025-26", alias: "Sandeep Ji"         },
  { level: "head" as const, name: "Syed Aqil Rizvi",   missingIn: "2025-26", alias: "Rizvi Ji"           },
  { level: "head" as const, name: "Pawan Sharma",       missingIn: "2025-26", alias: "Pawan Kumar"        },
  { level: "head" as const, name: "Biju C.O",           missingIn: "2025-26", alias: "Bijju"              },
  { level: "head" as const, name: "Lalan Kumar",        missingIn: "2025-26", alias: "Lalan"              },
  { level: "head" as const, name: "Nasir Hussain Khan", missingIn: "2025-26", alias: "Nasir Husain"       },
];

// Build a gap GraphNode from its registry entry.
export function makeGapNode(meta: GapNodeMeta): GraphNode {
  return {
    path: meta.path,
    level: "gap",
    fy: "*",
    name: meta.path,
    measures: [],
    population: "N/A",
    source: "static-registry",
    cutoff: "N/A",
    flags: ["GAP_NODE"],
    parent: null,
    children: [],
    childrenSumToParent: null,
    isGap: true,
    gapReason: meta.reason,
    gapBlocks: meta.blocks,
  };
}

export function findGapNode(path: string): GraphNode | null {
  const meta = GAP_NODE_REGISTRY.find(
    (g) => g.path === path || path.startsWith(g.path),
  );
  return meta ? makeGapNode(meta) : null;
}
