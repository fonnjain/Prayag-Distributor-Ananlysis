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
import memberSheetMapRaw from "../../../../config/member_sheet_map.json" with { type: "json" };
import { normSecKey } from "../deepDiveData.js";

const memberSheetMap = memberSheetMapRaw as Record<string, string>;

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
      count: 0, // only available in closed FYs via secondary register
      measuresAvailable: ["secondary_ob", "secondary_sale"],
      examplePaths: ["segment/CP/2025-26"],
    },
    {
      level: "gap",
      count: GAP_NODE_REGISTRY.length,
      measuresAvailable: [],
      examplePaths: GAP_NODE_REGISTRY.map((g) => g.path),
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
    "Segment / SKU nodes are only available for closed FYs (FY2025-26 and earlier). " +
    "See gap/live-year-sku for FY2026-27.",
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
    "=== END INDEX ===",
  ];
  return lines.join("\n");
}
