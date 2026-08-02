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
      "PARTIAL, not blocked: the FY2026-27 secondary register (PSCode_3 xlsx drop) covers " +
      "Apr–Jun 2026 and is loaded at item-code level in secondary_sku_line (mirrored at brand " +
      "level into secondary_register_line). SKU/segment/discount questions for Apr–Jun 2026 " +
      "CAN be answered — use sku/detail/2026-27, sku/gaps/2026-27, sku/discounts/2026-27. " +
      "July 2026 onward is absent (not zero) until a fresh export is loaded.",
    blocks:
      "SKU/segment questions for FY2026-27 months after Jun-26 only. Apr–Jun 2026 is answerable.",
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
// Source of truth: src/lib/headSplits.ts — keep in sync when adding/removing pairs.
//
// All six pairs resolved (five via DB UPDATE Jul 2026; Pawan Kumar → Pawan
// Sharma confirmed by geography and merged Aug 2026). Empty until the next
// split appears.
export const KNOWN_KEY_SPLITS: { level: "head"; name: string; missingIn: string; alias: string }[] = [];

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
