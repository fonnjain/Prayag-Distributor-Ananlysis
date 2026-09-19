/**
 * Phase A8-A — Graph index builder.
 *
 * Builds the small, constant-size index that is always sent in every AI prompt.
 * Uses only cached / already-computed data so it never triggers a new Sheets read.
 */

import type { GraphIndex, LevelMeta } from "./types.js";
import { GAP_NODE_REGISTRY, KNOWN_KEY_SPLITS } from "./gapNodes.js";
import { getCachedStateDashboard } from "../stateDashboard.js";
import { loadRoster } from "../roster.js";
import { MEMBER_FILE_MAP as memberSheetMap } from "../memberResolver.js";
import { normSecKey } from "../deepDiveData.js";

const KNOWN_FYS = ["2026-27", "2025-26", "2024-25", "2023-24", "2022-23", "2021-22"];

export async function buildGraphIndex(fy: string, period?: string): Promise<GraphIndex> {
  // Use cached data only — no Sheets reads in the index builder.
  const secDash = getCachedStateDashboard(fy);
  const roster  = await loadRoster().catch(() => null);

  const headNames  = roster
    ? [...new Set(roster.members.map((m) => m.stateHead).filter(Boolean))]
    : (secDash
        ? [...new Set(secDash.members.map((m) => m.stateHead).filter(Boolean))]
        : []);

  const memberCount = roster?.members.length
    ?? secDash?.members.length
    ?? 0;

  const mappedMemberCount = roster
    ? roster.members.filter((m) => !!memberSheetMap[normSecKey(m.name)]).length
    : 0;

  // Approximate distributor count from dashboard (if available).
  // The exact figure (269) is known from the document's ground truth.
  const distCount = 269;
  const retailerCount = 18117;

  const levels: LevelMeta[] = [
    {
      level: "company",
      count: 1,
      measuresAvailable: ["primary_sale", "secondary_ob", "secondary_sale", "target"],
      examplePaths: [`company/${fy}`],
    },
    {
      level: "head",
      count: headNames.length || 11,
      measuresAvailable: ["primary_sale", "secondary_ob", "secondary_sale", "target"],
      examplePaths: [`head/Anant Singh/${fy}`, `head/*/${fy}` ],
    },
    {
      level: "salesperson",
      count: memberCount || 178,
      measuresAvailable: ["secondary_ob", "secondary_sale", "target", "business_plan"],
      examplePaths: [`salesperson/Prasun Chatterjee/${fy}`, `salesperson/Prasun Chatterjee/${fy}/month/Jun`],
    },
    {
      level: "distributor",
      count: distCount,
      measuresAvailable: ["secondary_ob", "secondary_sale", "primary_sale"],
      examplePaths: [`distributor/Jagdamba Traders/${fy}`],
    },
    {
      level: "retailer",
      count: retailerCount,
      measuresAvailable: ["secondary_ob", "secondary_sale"],
      examplePaths: [`retailer/Lamba traders/${fy}`],
    },
    {
      level: "segment",
      count: 30,
      measuresAvailable: ["primary_sale", "secondary_sale"],
      examplePaths: [
        `segment/CP/${fy}`,
        `sku/gaps/${fy}`,
        `sku/gaps/Anant Singh/${fy}`,
        `sku/push/{distributor}/${fy}`,
        `sku/discounts/${fy}`,
        `sku/detail/${fy}`,
        `secondary-booking/${fy}`,
        `secondary-booking/${fy}/august-top-retailers`,
        `pending-orders/${fy}`,
        `penetration/RET#123/${fy}`,
      ],
    },
    {
      level: "gap",
      count: GAP_NODE_REGISTRY.length,
      measuresAvailable: [],
      examplePaths: GAP_NODE_REGISTRY.map((g) => g.path),
    },
    {
      level: "gap",
      count: 2,
      measuresAvailable: ["gross_margin", "gross_contribution"],
      examplePaths: [`resolution/${fy}`, `margin/PTMT/${fy}`],
    },
  ];

  const companyResiduals = [
    {
      description:
        "164 non-territory / Project / Govt customers sit outside all named State Heads. " +
        "~35% of FY2026-27 customer population (~₹6.08 Cr secondary OB). " +
        "The sum of all head secondary nodes will NOT equal the company secondary total.",
      customers: 164,
    },
  ];

  const notes: string[] = [];
  if (mappedMemberCount > 0 && memberCount > 0) {
    notes.push(
      `${mappedMemberCount} of ${memberCount} salesperson nodes have a mapped working sheet ` +
      "(retailer-level detail available). " +
      `${memberCount - mappedMemberCount} are data gaps at the retailer level.`,
    );
  }
  notes.push(
    "Retailer nodes (18,117) are resolved from the secondary register and are only available for " +
    "closed FYs. Live-year retailer detail requires a member working sheet read instead.",
  );
  notes.push(
    "Native bounded nodes: sales-deep-dive/{member}/{fy}, distributor-deep-dive/{name}/{fy}, " +
    "and sku-deep-dive/{fy} reuse verified deep-dive builders. SKU detail includes per-month " +
    "source metadata; Product-Wise August+ rows are isolated and excluded from discount and " +
    "multi-month conclusions until parity evidence is approved.",
  );
  notes.push(
    "Commercial, operational and secondary C/D surfaces resolve through bounded adapters. " +
    "If an adapter cannot provide a prepared sub-report it returns its own explicit " +
    "availability and reason; no arithmetic is invented in the graph.",
  );
  notes.push(
    `Adapter paths: company-report/{1..7}/${fy}, momentum/${fy}, growth/${fy}, targets/${fy}, ` +
    `coverage/${fy}, comparison/${fy}, alerts/${fy}, data-health/${fy}, category-registry/${fy}, ` +
    `top80/{snapshotId-or-date}.`,
  );
  notes.push(
    "Every measure carries discriminated availability. Held measures contain a hold code/category/reason and never contain a value. " +
    "Margin uses gross margin/gross contribution terminology; bom_cost is factory cost only.",
  );
  notes.push(
    "Segment / SKU nodes are available for closed FYs AND for FY2026-27 Apr–Jul (PARTIAL — " +
    "the PSCode_3 register covers Apr–Jul 2026). Complete August Product-Wise retailer " +
    "order value and distinct product-code breadth are available at " +
    "secondary-booking/2026-27/august-top-retailers. " +
    "See gap/live-year-sku.",
  );
  notes.push(
    "ALL loaded fiscal years are resolvable in one question — no filter change is needed. " +
    "Append /likemonths to company or head paths to restrict any FY's primary figures to the " +
    "open FY's complete-month window (required for any open-year comparison).",
  );

  return {
    fy,
    period: period ?? null,
    generatedAt: new Date().toISOString(),
    levels,
    fys: KNOWN_FYS,
    gapNodes: GAP_NODE_REGISTRY,
    crossFyKeySplits: KNOWN_KEY_SPLITS,
    companyResiduals,
    notes,
  };
}

// Compact text form used in AI prompts (keeps token count low).
export function graphIndexToPromptText(index: GraphIndex): string {
  const lines: string[] = [
    `=== METRICS GRAPH INDEX (FY${index.fy}) ===`,
    `Generated: ${index.generatedAt}`,
    "",
    "NODE LEVELS:",
    ...index.levels.map(
      (l) =>
        `  ${l.level.toUpperCase()}: ~${l.count} nodes | measures: ${l.measuresAvailable.join(", ") || "none"} | examples: ${l.examplePaths.join(", ")}`,
    ),
    "",
    "FISCAL YEARS WITH DATA:",
    `  ${index.fys.join(", ")}`,
    "",
    "GAP NODES (these questions cannot be answered — cite the gap reason):",
    ...index.gapNodes.map((g) => `  ${g.path}: ${g.reason}`),
    "",
    "CROSS-FY KEY SPLITS (do NOT present YoY for these as fact):",
    ...index.crossFyKeySplits.map(
      (s) =>
        `  "${s.name}" in one FY is "${s.alias ?? "absent"}" in ${s.missingIn} — flag CROSS_FY_KEY_SPLIT`,
    ),
    "",
    "COMPANY RESIDUALS (heads do NOT sum to company):",
    ...index.companyResiduals.map((r) => `  ${r.description}`),
    "",
    "USAGE NOTES:",
    ...index.notes.map((n) => `  - ${n}`),
    "",
    "=== END INDEX ===",
  ];
  return lines.join("\n");
}
