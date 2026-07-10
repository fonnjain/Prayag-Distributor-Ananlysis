// Reconciliation of the computed secondary-order-booking Management Report
// against the signed-off dashboard anchors (config/verify_anchors.json).
//
// Every anchor is compared to the app's live value with a pass/warn/fail
// verdict (pass within tolerance, warn within twice tolerance, fail beyond).
// The report is built from the SAME source as GET /mgmt/report — the secondary
// order file (Sale Report = Σ Order Value) — so the verify result mirrors what
// a user would download. Per-head Sale is grouped by roster State Head via the
// shared head resolver so spelling drift never drops a head (the old
// "Biju C.O = 0" bug). An internal cross-foot confirms Σ(member Sale) equals
// Σ(head Sale) equals the company total within ₹1.
import verifyAnchorsJson from "../../../config/verify_anchors.json";
import { loadOrderFile, type OrderFileAgg } from "./orders.js";
import { loadRoster } from "./roster.js";
import { buildHeadResolver } from "./names.js";

type Tolerances = {
  moneyPassPct: number;
  countPassPct: number;
  memberCountAbs: number;
};

type FyAnchor = {
  saleReportTotal: number;
  retailers: number;
  orders: number;
  members: number;
  perHeadSale: Record<string, number>;
};

type VerifyAnchors = {
  tolerances: Tolerances;
  fy_anchors: Record<string, FyAnchor>;
};

// Statically imported so esbuild bundles it — a cwd-relative read breaks in
// production, where the server does not run from the artifact directory.
const anchors = verifyAnchorsJson as VerifyAnchors;

export type CheckStatus = "pass" | "warn" | "fail";

export type VerifyCheck = {
  key: string;
  label: string;
  unit: "money" | "count";
  expected: number;
  actual: number;
  deltaPct: number | null;
  status: CheckStatus;
};

export type VerifyResult = {
  fy: string;
  available: boolean;
  reason?: string;
  overall: CheckStatus;
  checks: VerifyCheck[];
  crossFoot: {
    memberSaleTotal: number;
    headSaleTotal: number;
    companyTotal: number;
    withinTolerance: boolean;
  } | null;
  missingHeads: string[];
};

export function hasVerifyAnchors(fy: string): boolean {
  return fy in anchors.fy_anchors;
}

export function verifyFyList(): string[] {
  return Object.keys(anchors.fy_anchors).sort().reverse();
}

// Percentage-tolerance verdict: pass within band, warn within twice, else fail.
function moneyStatus(actual: number, expected: number, passPct: number): CheckStatus {
  if (expected === 0) return actual === 0 ? "pass" : "fail";
  const pct = Math.abs((actual - expected) / expected) * 100;
  if (pct <= passPct) return "pass";
  if (pct <= passPct * 2) return "warn";
  return "fail";
}

function countPctStatus(actual: number, expected: number, passPct: number): CheckStatus {
  return moneyStatus(actual, expected, passPct);
}

function countAbsStatus(actual: number, expected: number, passAbs: number): CheckStatus {
  const d = Math.abs(actual - expected);
  if (d <= passAbs) return "pass";
  if (d <= passAbs * 2) return "warn";
  return "fail";
}

function deltaPct(actual: number, expected: number): number | null {
  if (expected === 0) return null;
  return Math.round(((actual - expected) / expected) * 1000) / 10;
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

// Distinct retailers and orders across the whole file — union the per-member
// sets so a retailer/order served by several members is counted once.
function unionCounts(agg: OrderFileAgg): { retailers: number; orders: number } {
  const retailers = new Set<string>();
  const orders = new Set<string>();
  for (const tm of agg.perTm.values()) {
    for (const rid of tm.retailers.keys()) retailers.add(rid);
    for (const oid of tm.orderIds) orders.add(oid);
  }
  return { retailers: retailers.size, orders: orders.size };
}

export async function runVerify(fy: string): Promise<VerifyResult> {
  const anchor = anchors.fy_anchors[fy];
  if (!anchor) {
    return {
      fy,
      available: false,
      reason: `No verification anchors are configured for ${fy}.`,
      overall: "fail",
      checks: [],
      crossFoot: null,
      missingHeads: [],
    };
  }
  const [agg, roster] = await Promise.all([loadOrderFile(fy), loadRoster()]);
  if (!agg) {
    return {
      fy,
      available: false,
      reason: `The secondary order booking file for ${fy} could not be read, so there is nothing to verify.`,
      overall: "fail",
      checks: [],
      crossFoot: null,
      missingHeads: [],
    };
  }
  const tol = anchors.tolerances;
  const checks: VerifyCheck[] = [];

  // Company totals.
  checks.push({
    key: "saleReportTotal",
    label: "Total Sale Report",
    unit: "money",
    expected: anchor.saleReportTotal,
    actual: agg.totalSaleAmount,
    deltaPct: deltaPct(agg.totalSaleAmount, anchor.saleReportTotal),
    status: moneyStatus(agg.totalSaleAmount, anchor.saleReportTotal, tol.moneyPassPct),
  });

  const { retailers, orders } = unionCounts(agg);
  checks.push({
    key: "retailers",
    label: "Total retailers",
    unit: "count",
    expected: anchor.retailers,
    actual: retailers,
    deltaPct: deltaPct(retailers, anchor.retailers),
    status: countPctStatus(retailers, anchor.retailers, tol.countPassPct),
  });
  checks.push({
    key: "orders",
    label: "Total orders",
    unit: "count",
    expected: anchor.orders,
    actual: orders,
    deltaPct: deltaPct(orders, anchor.orders),
    status: countPctStatus(orders, anchor.orders, tol.countPassPct),
  });

  // Members = team members with in-FY orders that also match the roster.
  const rosterKeys = new Set(roster.members.map((m) => m.normKey));
  let matchedMembers = 0;
  for (const key of agg.perTm.keys()) {
    if (rosterKeys.has(key)) matchedMembers++;
  }
  checks.push({
    key: "members",
    label: "Members",
    unit: "count",
    expected: anchor.members,
    actual: matchedMembers,
    deltaPct: deltaPct(matchedMembers, anchor.members),
    status: countAbsStatus(matchedMembers, anchor.members, tol.memberCountAbs),
  });

  // Per-head Sale: sum each roster member's Sale (Σ Order Value) into their
  // State Head bucket. The resolver aligns spelling drift so no head drops.
  const canonicalHeads = new Set(
    roster.members.map((m) => m.stateHead).filter((h) => h.trim() !== ""),
  );
  const resolveHead = buildHeadResolver(canonicalHeads);
  const headSale = new Map<string, number>();
  let memberSaleTotal = 0;
  for (const m of roster.members) {
    const tm = agg.perTm.get(m.normKey);
    if (!tm) continue;
    memberSaleTotal += tm.saleAmount;
    const head = resolveHead(m.stateHead) ?? m.stateHead.trim();
    if (!head) continue;
    headSale.set(head, (headSale.get(head) ?? 0) + tm.saleAmount);
  }
  let headSaleTotal = 0;
  for (const v of headSale.values()) headSaleTotal += v;

  const missingHeads: string[] = [];
  for (const [name, expected] of Object.entries(anchor.perHeadSale)) {
    const resolved = resolveHead(name) ?? name;
    const actual = headSale.get(resolved) ?? 0;
    if (actual === 0) missingHeads.push(name);
    checks.push({
      key: `head:${name}`,
      label: `${name} Sale`,
      unit: "money",
      expected,
      actual,
      deltaPct: deltaPct(actual, expected),
      status: moneyStatus(actual, expected, tol.moneyPassPct),
    });
  }

  // Cross-foot: member split, head split, and company total must agree ±₹1.
  const companyTotal = agg.totalSaleAmount;
  const withinTolerance =
    Math.abs(memberSaleTotal - headSaleTotal) <= 1 &&
    Math.abs(memberSaleTotal - companyTotal) <= Math.max(1, companyTotal * 0.001);

  const overall = worst([...checks.map((c) => c.status), withinTolerance ? "pass" : "fail"]);

  return {
    fy,
    available: true,
    overall,
    checks,
    crossFoot: {
      memberSaleTotal,
      headSaleTotal,
      companyTotal,
      withinTolerance,
    },
    missingHeads,
  };
}
