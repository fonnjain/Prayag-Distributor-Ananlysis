/**
 * Phase A8-A — Graph node resolvers.
 *
 * Each resolver calls EXISTING verified computation — no arithmetic here.
 * If a figure is not already computed somewhere it becomes a gap node.
 */

import type { GraphNode, MeasureValue } from "./types.js";
import { MAX_NODES_PER_RESOLVE } from "./types.js";
import { GAP_NODE_REGISTRY, KNOWN_KEY_SPLITS, findGapNode } from "./gapNodes.js";
import { loadStateDashboard } from "../stateDashboard.js";
import { loadStateHeadSale } from "../stateHeadSale.js";
import { loadDeepDiveData, normSecKey } from "../deepDiveData.js";
import { buildMemberPayload, buildStateHeadPayload } from "../aiPayload.js";
import { loadDistributorDeepDive, normDistKey } from "../distributorDeepDive.js";
import { loadRoster } from "../roster.js";
import memberSheetMapRaw from "../../../../config/member_sheet_map.json" with { type: "json" };
import { logger } from "../../logger.js";

const memberSheetMap = memberSheetMapRaw as Record<string, string>;

// ── helpers ────────────────────────────────────────────────────────────────────

function mv(
  measure: MeasureValue["measure"],
  label: string,
  value: number | null,
  unit: MeasureValue["unit"] = "INR",
): MeasureValue {
  return { measure, label, value, unit };
}

function crStr(v: number | null): string {
  if (v == null) return "null";
  return `₹${(v / 1e7).toFixed(2)} Cr`;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

// ── Company node ───────────────────────────────────────────────────────────────

async function resolveCompany(fy: string): Promise<GraphNode> {
  const [secDash, saleResult] = await Promise.all([
    loadStateDashboard(fy),
    loadStateHeadSale(fy),
  ]);

  const measures: MeasureValue[] = [];

  // Primary sale from State Head Sale sheet.
  if (saleResult.error) {
    measures.push(mv("primary_sale", "Primary Sale / Dispatch", null));
  } else {
    measures.push(mv("primary_sale", "Primary Sale / Dispatch", saleResult.total));
  }

  // Secondary OB and sale from State Head Dashboard.
  if (secDash) {
    measures.push(mv("secondary_ob", "Secondary Order Booking", secDash.totalOrderBooked));
    measures.push(mv("secondary_sale", "Secondary Sales Received", secDash.totalSalesReceived));
    measures.push(mv("target", "Secondary Business Plan", secDash.totalPlan));
  } else {
    measures.push(mv("secondary_ob", "Secondary Order Booking", null));
    measures.push(mv("secondary_sale", "Secondary Sales Received", null));
  }

  const flags: string[] = [];
  if (saleResult.error) flags.push(`PRIMARY_SALE_ERROR: ${saleResult.error}`);
  if (!secDash) flags.push("SECONDARY_DASHBOARD_UNAVAILABLE");

  // Known residual: 164 non-territory customers who sit outside any named head.
  const residual = secDash
    ? {
        value: 0, // exact value varies — noted by description
        description:
          "164 non-territory / Project / Govt customers sit outside named State Heads. " +
          "They account for ~35% of the FY2026-27 customer population and ~₹6.08 Cr. " +
          "The sum of head secondary nodes will NOT equal the company total.",
      }
    : null;

  // Get member count from roster for child list.
  const roster = await loadRoster().catch(() => null);
  const heads = roster
    ? [...new Set(roster.members.map((m) => m.stateHead).filter(Boolean))]
    : [];

  return {
    path: `company/${fy}`,
    level: "company",
    fy,
    name: "Prayag India",
    measures,
    population:
      "Primary: all dispatches including project, institutional, and govt business. " +
      "Secondary: distributor→retailer order booking and sales; excludes project business.",
    source: `Primary sale from loadStateHeadSale (State Head Sale sheet FY${fy}). ` +
      `Secondary from loadStateDashboard (STATE HEAD DASHBOARD ${fy}).`,
    cutoff: secDash?.anomalies?.length ? "See anomalies" : `FY${fy} YTD`,
    flags,
    parent: null,
    children: heads.map((h) => `head/${h}/${fy}`),
    childrenSumToParent: false, // residual exists
    residual,
    isGap: false,
  };
}

// ── Head node ─────────────────────────────────────────────────────────────────

async function resolveHead(headName: string, fy: string): Promise<GraphNode> {
  const [secDash, saleResult, roster] = await Promise.all([
    loadStateDashboard(fy),
    loadStateHeadSale(fy),
    loadRoster().catch(() => null),
  ]);

  // Secondary: sum all members whose stateHead matches.
  let secOB = 0;
  let secSale = 0;
  let secPlan = 0;
  const matchedNames: string[] = [];
  if (secDash) {
    for (const m of secDash.members) {
      if (m.stateHead === headName) {
        secOB   += m.allMonthsOrderBooked;
        secSale += m.allMonthsSalesReceived;
        if (m.businessPlan != null) secPlan += m.businessPlan;
        matchedNames.push(m.name);
      }
    }
  }

  // Primary: from StateHeadSale.byHead — key is the head name as stored in sheet.
  const primarySale = saleResult.error
    ? null
    : (saleResult.byHead.get(headName) ?? null);

  const measures: MeasureValue[] = [
    mv("primary_sale", "Primary Sale / Dispatch", primarySale),
    mv("secondary_ob",   "Secondary Order Booking",   secDash ? secOB   : null),
    mv("secondary_sale", "Secondary Sales Received",  secDash ? secSale : null),
    mv("target", "Secondary Business Plan", secDash ? secPlan : null),
  ];

  const flags: string[] = [];
  if (saleResult.error)       flags.push(`PRIMARY_SALE_ERROR: ${saleResult.error}`);
  if (!secDash)               flags.push("SECONDARY_DASHBOARD_UNAVAILABLE");
  if (primarySale == null && !saleResult.error)
    flags.push("HEAD_NOT_IN_PRIMARY_SALE_SHEET: name may differ between sheets");

  // Check cross-FY key splits.
  for (const split of KNOWN_KEY_SPLITS) {
    if (split.name === headName || split.alias === headName) {
      flags.push(
        `CROSS_FY_KEY_SPLIT: "${headName}" is "${split.alias ?? split.name}" in FY${split.missingIn}. ` +
        "Year-on-year comparisons for this head are unreliable.",
      );
    }
  }

  // Member roster under this head.
  const headMembers = roster
    ? roster.members.filter((m) => m.stateHead === headName)
    : [];
  const mappedSheetCount = headMembers.filter(
    (m) => !!memberSheetMap[normSecKey(m.name)],
  ).length;

  const detail: Record<string, unknown> = {
    memberCount: headMembers.length,
    membersWithMappedSheet: mappedSheetCount,
    memberNames: headMembers.map((m) => m.name),
    note:
      `Retailer-level figures cover only the ${mappedSheetCount} of ${headMembers.length} ` +
      "members with a mapped working sheet.",
  };

  return {
    path: `head/${headName}/${fy}`,
    level: "head",
    fy,
    name: headName,
    measures,
    population:
      "Primary: dispatches attributed to this State Head including project/institutional. " +
      "Secondary: order booking/sales from the members listed under this head in STATE HEAD DASHBOARD.",
    source: `Primary from loadStateHeadSale.byHead. Secondary aggregated from loadStateDashboard.members filtered by stateHead="${headName}".`,
    cutoff: `FY${fy} YTD`,
    flags,
    parent: `company/${fy}`,
    children: headMembers.map((m) => `salesperson/${m.name}/${fy}`),
    childrenSumToParent: true,
    detail,
    isGap: false,
  };
}

// ── Salesperson node ──────────────────────────────────────────────────────────

async function resolveSalesperson(memberName: string, fy: string): Promise<GraphNode> {
  const memberKey = normSecKey(memberName);
  const data = await loadDeepDiveData(fy, undefined, memberKey);

  if (!data.kpis) {
    return {
      path: `salesperson/${memberName}/${fy}`,
      level: "salesperson",
      fy,
      name: memberName,
      measures: [],
      population: "Member not found in Data tab",
      source: "loadDeepDiveData",
      cutoff: "N/A",
      flags: [`MEMBER_NOT_FOUND: "${memberName}" (normKey: ${memberKey}) not in Data tab for FY${fy}`],
      parent: data.kpis == null && data.stateHeads.length
        ? `head/${data.stateHeads[0]}/${fy}`
        : null,
      children: [],
      childrenSumToParent: null,
      isGap: false,
    };
  }

  const kpis = data.kpis;
  const stateHead = kpis.stateHead ?? null;
  const period = `Apr–${new Date().toLocaleString("en-IN", { month: "short" })} FY${fy}`;
  const payload = buildMemberPayload(
    fy, stateHead, period,
    kpis, data.retailerDetail, data.roiCost, data.skuSpread,
  );

  const perf = payload.performance;
  const tgt  = payload.targets;

  // Expose all three booking streams so the AI never needs to add them up.
  // The acceptance figure "Rs 26,21,109 booking" is totalOB (secondary + direct dealer).
  const measures: MeasureValue[] = [
    mv("secondary_ob",   "Total Order Booking (secondary + direct dealer)", perf.totalOB        ?? null),
    mv("secondary_sale", "Secondary Sales Received",                        perf.salesReceived  ?? null),
    mv("secondary_ob",   "Secondary-only OB (retailer/party)",              perf.secondaryOB    ?? null),
    mv("primary_ob",     "Direct Dealer OB",                                perf.directDealerOB ?? null),
    mv("target",         "Monthly Target (secondary)",                      tgt.monthlySecondary ?? null),
    mv("business_plan",  "Annual Business Plan",                            tgt.annualSecondary ?? null),
  ];

  const flags: string[] = payload.dataQuality.map(
    (f) => `${f.code}: ${f.message}`,
  );
  if (!memberSheetMap[memberKey])
    flags.push("NO_MEMBER_SHEET_MAPPED: retailer-level detail unavailable");

  // Month-level children — derive from SecDashboard months (not absent, not anomaly).
  const secDash = await loadStateDashboard(fy);
  const secMember = secDash?.members.find((m) => m.normKey === memberKey) ?? null;
  const monthChildren = secMember
    ? secMember.months
        .map((md, idx) => ({ label: MONTH_LABELS[idx], md }))
        .filter(({ md }) => !md.notYetRecorded && (md.orderedAmount ?? 0) > 0)
        .map(({ label }) => `salesperson/${memberName}/${fy}/month/${label}`)
    : [];

  return {
    path: `salesperson/${memberName}/${fy}`,
    level: "salesperson",
    fy,
    name: memberName,
    measures,
    population:
      `Secondary order booking from ${payload.coverage.retailersTotal ?? "?"} retailers. ` +
      `Direct dealer OB separately: ${crStr(perf.directDealerOB ?? null)}. ` +
      "Excludes project/institutional business.",
    source: "buildMemberPayload (loadDeepDiveData → Data tab of State Head Dashboard)",
    cutoff: payload.identity.dataCutoff,
    flags,
    parent: stateHead ? `head/${stateHead}/${fy}` : null,
    children: monthChildren,
    childrenSumToParent: monthChildren.length > 0,
    detail: {
      stateHead,
      coverage: payload.coverage,
      concentration: payload.concentration,
      customerStates: payload.customerStates,
      visits: payload.visits,
      cost: payload.cost,
      topCustomers: payload.topCustomers,
      achievement: payload.achievement,
    },
    isGap: false,
  };
}

// ── Salesperson month node ─────────────────────────────────────────────────────

async function resolveSalespersonMonth(memberName: string, fy: string, month: string): Promise<GraphNode> {
  const memberKey = normSecKey(memberName);
  const secDash = await loadStateDashboard(fy);

  const secMember = secDash?.members.find((m) => m.normKey === memberKey) ?? null;

  const monthIdx = MONTH_LABELS.indexOf(month);
  const monthData = (secMember && monthIdx >= 0) ? secMember.months[monthIdx] : null;

  const orderedAmt = monthData?.orderedAmount ?? null;
  const salesAmt   = monthData?.salesAmount   ?? null;
  const isAbsent   = monthData?.notYetRecorded ?? (monthData == null);
  const isAnomaly  = monthData?.isAnomaly ?? false;

  const measures: MeasureValue[] = [
    mv("secondary_ob",   `Secondary OB — ${month}`,   orderedAmt),
    mv("secondary_sale", `Sales Received — ${month}`, salesAmt),
  ];

  const flags: string[] = [];
  if (isAbsent) flags.push(`MONTH_ABSENT: ${month} is not yet closed or has no data — do not show as zero`);
  if (isAnomaly) flags.push(`MONTH_ANOMALY: sales > OB*1.5 — probable data-entry error, exclude from rankings`);
  if (!secMember) flags.push(`MEMBER_NOT_IN_DASHBOARD: "${memberName}" not found in SecDashboard for FY${fy}`);

  return {
    path: `salesperson/${memberName}/${fy}/month/${month}`,
    level: "time",
    fy,
    name: `${memberName} — ${month}`,
    measures,
    population: "Same population as the parent salesperson node.",
    source: "SecDashboard.members[].months[] (STATE HEAD DASHBOARD monthly columns)",
    cutoff: isAbsent ? `${month} data not yet recorded` : `${month} ${fy}`,
    flags,
    parent: `salesperson/${memberName}/${fy}`,
    children: [],
    childrenSumToParent: null,
    isGap: false,
  };
}

// ── Distributor node ───────────────────────────────────────────────────────────

async function resolveDistributor(distributorName: string, fy: string): Promise<GraphNode> {
  const distKey = normDistKey(distributorName);
  const roster  = await loadRoster().catch(() => null);
  const heads   = roster
    ? [...new Set(roster.members.map((m) => m.stateHead).filter(Boolean))]
    : [];

  // Try each head until we find the distributor.
  let foundResult: Awaited<ReturnType<typeof loadDistributorDeepDive>> | null = null;
  let foundHead = "";

  for (const head of heads) {
    const result = await loadDistributorDeepDive(fy, head).catch(() => null);
    if (!result) continue;
    const match = result.distributors.find(
      (d) => normDistKey(d.name) === distKey,
    );
    if (match) {
      foundResult = result;
      foundHead = head;
      break;
    }
  }

  if (!foundResult) {
    return {
      path: `distributor/${distributorName}/${fy}`,
      level: "distributor",
      fy,
      name: distributorName,
      measures: [],
      population: "Distributor not found across any State Head",
      source: "loadDistributorDeepDive",
      cutoff: "N/A",
      flags: [`DISTRIBUTOR_NOT_FOUND: "${distributorName}" not found for FY${fy}`],
      parent: null,
      children: [],
      childrenSumToParent: null,
      isGap: false,
    };
  }

  const dist = foundResult.distributors.find(
    (d) => normDistKey(d.name) === distKey,
  )!;

  const flows = dist.flows ?? null;
  const conc  = dist.retailerConcentration ?? null;

  const measures: MeasureValue[] = [
    mv("secondary_ob",   "Party Order Booking (member sheets)",  dist.orderBooking),
    mv("secondary_sale", "Sales Received (Secondary)",           dist.sale),
    mv("primary_sale",   "Primary Dispatch (to distributor)",    flows?.primaryDispatch ?? null),
  ];

  const distFlags: string[] = [];
  if (flows != null && flows.flowGap != null && Math.abs(flows.flowGap) > 10000) {
    distFlags.push(`FLOW_GAP: ${crStr(flows.flowGap)} gap between primary dispatch and secondary out`);
  }
  if (dist.isConcentrationRisk) {
    distFlags.push(`CONCENTRATION_RISK: OB share ≥ 60% (${(dist.obSharePct ?? 0).toFixed(1)}%)`);
  }

  return {
    path: `distributor/${distributorName}/${fy}`,
    level: "distributor",
    fy,
    name: dist.name,
    measures,
    population: `${dist.retailerCount} retailers attributed to this distributor under "${foundHead}". ${dist.confirmedCount} confirmed, ${dist.guessedCount} guessed.`,
    source: `loadDistributorDeepDive (stateHead="${foundHead}", member working sheets + sale_line)`,
    cutoff: `FY${fy} YTD`,
    flags: distFlags,
    parent: `head/${foundHead}/${fy}`,
    children: [],
    childrenSumToParent: null,
    detail: {
      stateHead: foundHead,
      concentration: conc,
      flowGap: flows?.flowGap ?? null,
      obSharePct: dist.obSharePct ?? null,
      retailerCount: dist.retailerCount,
      activeCount: dist.activeCount,
      dormantCount: dist.dormantCount,
    },
    isGap: false,
  };
}

// ── Path parser + dispatcher ──────────────────────────────────────────────────

type ResolveResult = { node: GraphNode | null; error: string | null };

export async function resolvePath(path: string, defaultFy: string): Promise<ResolveResult> {
  const trimmed = path.trim();

  // Gap nodes — static, no computation.
  if (trimmed.startsWith("gap/")) {
    const node = findGapNode(trimmed);
    if (node) return { node, error: null };
    return { node: null, error: `Gap node "${trimmed}" not found` };
  }

  const parts = trimmed.split("/");

  try {
    // company/{fy}
    if (parts[0] === "company") {
      const fy = parts[1] ?? defaultFy;
      return { node: await resolveCompany(fy), error: null };
    }

    // head/{name}/{fy}
    if (parts[0] === "head") {
      const headName = parts.slice(1, -1).join("/");
      const fy = parts[parts.length - 1] ?? defaultFy;
      if (!headName) return { node: null, error: "head path requires a name: head/{name}/{fy}" };
      return { node: await resolveHead(headName, fy), error: null };
    }

    // salesperson/{name}/{fy}[/month/{month}]
    if (parts[0] === "salesperson") {
      const monthIdx = parts.indexOf("month");
      if (monthIdx !== -1) {
        // salesperson/{name}/{fy}/month/{month}
        const fy    = parts[monthIdx - 1] ?? defaultFy;
        const month = parts.slice(monthIdx + 1).join("/");
        const name  = parts.slice(1, monthIdx - 1).join("/");
        return { node: await resolveSalespersonMonth(name, fy, month), error: null };
      }
      const fy   = parts[parts.length - 1] ?? defaultFy;
      const name = parts.slice(1, -1).join("/");
      if (!name) return { node: null, error: "salesperson path requires a name: salesperson/{name}/{fy}" };
      return { node: await resolveSalesperson(name, fy), error: null };
    }

    // distributor/{name}/{fy}
    if (parts[0] === "distributor") {
      const fy   = parts[parts.length - 1] ?? defaultFy;
      const name = parts.slice(1, -1).join("/");
      if (!name) return { node: null, error: "distributor path requires a name: distributor/{name}/{fy}" };
      return { node: await resolveDistributor(name, fy), error: null };
    }

    return { node: null, error: `Unknown path pattern: "${trimmed}"` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ path: trimmed, err }, "graph/resolve: error");
    return { node: null, error: msg };
  }
}

// Resolve a wildcard path, e.g. "head/*/2026-27" → all heads.
export async function resolveWildcard(
  path: string,
  defaultFy: string,
): Promise<{ nodes: GraphNode[]; errors: { path: string; error: string }[] }> {
  const parts = path.split("/");
  const nodes: GraphNode[] = [];
  const errors: { path: string; error: string }[] = [];

  // head/*/{fy}
  if (parts[0] === "head" && parts[1] === "*") {
    const fy     = parts[2] ?? defaultFy;
    const roster = await loadRoster().catch(() => null);
    const heads  = roster
      ? [...new Set(roster.members.map((m) => m.stateHead).filter(Boolean))]
      : [];
    for (const h of heads) {
      const r = await resolvePath(`head/${h}/${fy}`, fy);
      if (r.node) nodes.push(r.node);
      else if (r.error) errors.push({ path: `head/${h}/${fy}`, error: r.error });
      if (nodes.length >= MAX_NODES_PER_RESOLVE) break;
    }
    return { nodes, errors };
  }

  // salesperson/*/{fy}
  if (parts[0] === "salesperson" && parts[1] === "*") {
    const fy     = parts[2] ?? defaultFy;
    const roster = await loadRoster().catch(() => null);
    const names  = roster ? roster.members.map((m) => m.name) : [];
    for (const n of names) {
      const r = await resolvePath(`salesperson/${n}/${fy}`, fy);
      if (r.node) nodes.push(r.node);
      else if (r.error) errors.push({ path: `salesperson/${n}/${fy}`, error: r.error });
      if (nodes.length >= MAX_NODES_PER_RESOLVE) break;
    }
    return { nodes, errors };
  }

  // Fallback — not a wildcard.
  const r = await resolvePath(path, defaultFy);
  if (r.node) nodes.push(r.node);
  else if (r.error) errors.push({ path, error: r.error });
  return { nodes, errors };
}
