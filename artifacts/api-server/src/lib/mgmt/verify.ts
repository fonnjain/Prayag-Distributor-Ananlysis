// Reconciliation of the computed secondary-order-booking Management Report
// against the anchors in config/verify_anchors.json.
//
// Money everywhere is NET Sub Total (never gross Order Value). The company
// total (saleReportTotal) and order count are externally validated ground
// truth; active retailer/member counts and the per-head split are regression
// locks. Per-head Sale is grouped by roster State Head via the shared head
// resolver so spelling drift never drops a head (the old "Biju C.O = 0" bug).
//
// The report is a roster spine: only order-booking names that match a roster
// member are attributed to a member/head. Names that do not match carry real
// money the file counts but the roster cannot place, so the cross-foot proves
// Σ(member Sale) == Σ(head Sale) and surfaces the unmatched remainder to the
// company total as data-health context rather than a failure.
import { readVerifyAnchors } from "../config/verifyAnchors.js";
import { loadOrderFile, type OrderFileAgg } from "./orders.js";
import { loadRoster } from "./roster.js";
import { buildHeadResolver } from "./names.js";

type Tolerances = {
  moneyPassPct: number;
  countPassPct: number;
  memberCountAbs: number;
  coverageMinPct: number;
};

type FyAnchor = {
  saleReportTotal: number;
  orders?: number;
  registeredRetailers?: number;
  activeRetailers?: number;
  registeredMembers?: number;
  activeMembers?: number;
  perHeadSale?: Record<string, number>;
};

type VerifyAnchors = {
  tolerances: Tolerances;
  fy_anchors: Record<string, FyAnchor>;
};

// Read fresh from disk on each invocation (not bundled, not cached).
// lock-month-anchor writes a new verify_anchors.json; the next call here
// picks it up without a server restart.
function getAnchors(): VerifyAnchors {
  return readVerifyAnchors<VerifyAnchors>();
}

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

// Registered vs Active + Active% (per the signed-off request). Registered counts
// are the roster/master sizes (retailer master is not loaded in-app, so its
// registered count is the anchor); active counts are computed from the file.
export type VerifyContext = {
  registeredRetailers: number | null;
  activeRetailers: number;
  activeRetailerPct: number | null;
  registeredMembers: number;
  activeMembers: number;
  activeMemberPct: number | null;
  unmatchedNames: number;
  unmatchedSale: number;
};

export type VerifyResult = {
  fy: string;
  available: boolean;
  reason?: string;
  overall: CheckStatus;
  checks: VerifyCheck[];
  context: VerifyContext | null;
  crossFoot: {
    memberSaleTotal: number;
    headSaleTotal: number;
    companyTotal: number;
    withinTolerance: boolean;
  } | null;
  missingHeads: string[];
};

export function hasVerifyAnchors(fy: string): boolean {
  return fy in getAnchors().fy_anchors;
}

export function verifyFyList(): string[] {
  return Object.keys(getAnchors().fy_anchors).sort().reverse();
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

// Share of the company net total that the roster spine could attribute to a
// member. Pass at/above the floor, warn within 10 points below it, else fail —
// so a growing pool of unmatched-name money cannot pass silently.
function coverageStatus(covered: number, total: number, minPct: number): CheckStatus {
  if (total <= 0) return "pass";
  const p = (covered / total) * 100;
  if (p >= minPct) return "pass";
  if (p >= minPct - 10) return "warn";
  return "fail";
}

function deltaPct(actual: number, expected: number): number | null {
  if (expected === 0) return null;
  return Math.round(((actual - expected) / expected) * 1000) / 10;
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
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
  const anchors = getAnchors();
  const anchor = anchors.fy_anchors[fy];
  if (!anchor) {
    return {
      fy,
      available: false,
      reason: `No verification anchors are configured for ${fy}.`,
      overall: "fail",
      checks: [],
      context: null,
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
      context: null,
      crossFoot: null,
      missingHeads: [],
    };
  }
  const tol = anchors.tolerances; // anchors read at top of this function
  const checks: VerifyCheck[] = [];

  // Company total (NET Sub Total) — the workbook's own grand total. Passing
  // this proves the report sums net money over the whole file.
  checks.push({
    key: "saleReportTotal",
    label: "Total Sale (net)",
    unit: "money",
    expected: anchor.saleReportTotal,
    actual: agg.totalSaleAmount,
    deltaPct: deltaPct(agg.totalSaleAmount, anchor.saleReportTotal),
    status: moneyStatus(agg.totalSaleAmount, anchor.saleReportTotal, tol.moneyPassPct),
  });

  const { retailers: activeRetailers, orders } = unionCounts(agg);
  if (anchor.orders != null) {
    checks.push({
      key: "orders",
      label: "Total orders",
      unit: "count",
      expected: anchor.orders,
      actual: orders,
      deltaPct: deltaPct(orders, anchor.orders),
      status: countPctStatus(orders, anchor.orders, tol.countPassPct),
    });
  }
  if (anchor.activeRetailers != null) {
    checks.push({
      key: "activeRetailers",
      label: "Active retailers (>=1 order)",
      unit: "count",
      expected: anchor.activeRetailers,
      actual: activeRetailers,
      deltaPct: deltaPct(activeRetailers, anchor.activeRetailers),
      status: countPctStatus(activeRetailers, anchor.activeRetailers, tol.countPassPct),
    });
  }

  // Distinct team-member names that booked orders in the file. This is a file
  // statistic (it includes names the roster cannot place), not the roster-active
  // count — kept as a regression lock on name aggregation.
  const orderBookingNames = agg.perTm.size;
  if (anchor.activeMembers != null) {
    checks.push({
      key: "orderBookingNames",
      label: "Members booking orders (file)",
      unit: "count",
      expected: anchor.activeMembers,
      actual: orderBookingNames,
      deltaPct: deltaPct(orderBookingNames, anchor.activeMembers),
      status: countAbsStatus(orderBookingNames, anchor.activeMembers, tol.memberCountAbs),
    });
  }

  // Per-head Sale: sum each roster member's NET Sale into their State Head
  // bucket. The resolver aligns spelling drift so no head drops.
  const canonicalHeads = new Set(
    roster.members.map((m) => m.stateHead).filter((h) => h.trim() !== ""),
  );
  const resolveHead = buildHeadResolver(canonicalHeads);
  const rosterKeys = new Set(roster.members.map((m) => m.normKey));
  const headSale = new Map<string, number>();
  let memberSaleTotal = 0;
  let matchedMembers = 0;
  for (const m of roster.members) {
    const tm = agg.perTm.get(m.normKey);
    if (!tm) continue;
    matchedMembers++;
    memberSaleTotal += tm.saleAmount;
    const head = resolveHead(m.stateHead) ?? m.stateHead.trim();
    if (!head) continue;
    headSale.set(head, (headSale.get(head) ?? 0) + tm.saleAmount);
  }
  let headSaleTotal = 0;
  for (const v of headSale.values()) headSaleTotal += v;
  void headSaleTotal;

  const missingHeads: string[] = [];
  for (const [name, expected] of Object.entries(anchor.perHeadSale ?? {})) {
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

  // Names in the file that no roster member matched carry real (net) money the
  // roster spine cannot place. Surface it, do not fail on it.
  let unmatchedNames = 0;
  for (const key of agg.perTm.keys()) {
    if (!rosterKeys.has(key)) unmatchedNames++;
  }
  const companyTotal = agg.totalSaleAmount;
  const unmatchedSale = Math.max(0, companyTotal - memberSaleTotal);

  // Coverage: what share of the company net total the roster spine attributed to
  // a member. A shrinking share means more unmatched-name money — flag it so the
  // known gap cannot quietly grow.
  checks.push({
    key: "attributedCoverage",
    label: "Roster-attributed Sale coverage",
    unit: "money",
    expected: companyTotal,
    actual: memberSaleTotal,
    deltaPct: deltaPct(memberSaleTotal, companyTotal),
    status: coverageStatus(memberSaleTotal, companyTotal, tol.coverageMinPct),
  });

  // Cross-foot: the roster spine is internally consistent when the member split
  // equals the head split (±₹1). The remainder to the company total is the
  // unmatched-name money reported in context.
  const withinTolerance = Math.abs(memberSaleTotal - headSaleTotal) <= 1;

  const registeredMembers = roster.members.length;
  const context: VerifyContext = {
    registeredRetailers: anchor.registeredRetailers ?? null,
    activeRetailers,
    activeRetailerPct: pct(activeRetailers, anchor.registeredRetailers ?? 0),
    registeredMembers,
    activeMembers: matchedMembers,
    activeMemberPct: pct(matchedMembers, registeredMembers),
    unmatchedNames,
    unmatchedSale,
  };

  const overall = worst([...checks.map((c) => c.status), withinTolerance ? "pass" : "fail"]);

  return {
    fy,
    available: true,
    overall,
    checks,
    context,
    crossFoot: {
      memberSaleTotal,
      headSaleTotal,
      companyTotal,
      withinTolerance,
    },
    missingHeads,
  };
}
