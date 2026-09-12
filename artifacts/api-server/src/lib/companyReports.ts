// Company-wide Reports 1-7 (PRIMARY sales only — from sale_line).
//
// Three rules enforced everywhere:
//   RULE 1 — LIKE MONTHS: only compare calendar months that exist in the
//     current FY so far. Never compare a full prior year against part-year
//     current year.
//   RULE 2 — LITRE RULE: quantity is NEVER summed across groups. Water tanks
//     are measured in litres, everything else in pieces. Each group reports its
//     own unit separately.
//   RULE 3 — LIVE DATA: reads from sale_line, which is populated from the live
//     register chain (SALE SHEET, Sale, State Head Sale, Order Sheet). Taxable
//     Value (amount column) is the measure; MRP/rate list is never used.
import { and, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { db, saleLines, itemMaster, customerMaster } from "@workspace/db";
import { isMonthComplete } from "./analytics/analytics.js";
import { priorFy as computePriorFy, fyStartYear } from "./mgmt/names.js";
import { entityConds, normStateExpr, resolvePriorEntityFilter } from "./saleLineFilter.js";

export { normStateExpr } from "./saleLineFilter.js";

// ── Month label helpers ───────────────────────────────────────────────────────

const MONTH_ORDER = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

// All month labels for a FY in fiscal order: ["Apr-26", "May-26", ..., "Mar-27"]
export function fyMonthLabels(fy: string): string[] {
  const y = fyStartYear(fy);
  return MONTH_ORDER.map((m, i) => `${m}-${String(i < 9 ? y : y + 1).slice(-2)}`);
}

// "Apr-26" → "Apr-25"  (same month, one calendar year earlier)
function toPriorLabel(label: string): string {
  const prefix = label.slice(0, 4); // "Apr-"
  const yy = Number(label.slice(4));
  return `${prefix}${String(yy - 1).padStart(2, "0")}`;
}

// ── Like-months detection ─────────────────────────────────────────────────────

export type LikeMonthsResult = {
  current: string[];  // e.g. ["Apr-26","May-26","Jun-26"]
  prior: string[];    // e.g. ["Apr-25","May-25","Jun-25"]
};

export async function computeLikeMonths(fy: string): Promise<LikeMonthsResult> {
  const rows = await db
    .select({
      monthLabel: saleLines.monthLabel,
      maxDate: sql<string | null>`max(${saleLines.invoiceDate})::text`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(saleLines.monthLabel);

  const order = fyMonthLabels(fy);
  const complete: string[] = [];
  for (const row of rows) {
    if (!row.monthLabel) continue;
    if (isMonthComplete(row.monthLabel, row.maxDate)) {
      complete.push(row.monthLabel);
    }
  }
  complete.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { current: complete, prior: complete.map(toPriorLabel) };
}

// ── Shared aggregation helpers ────────────────────────────────────────────────

function growthPct(cur: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((cur - prior) / Math.abs(prior)) * 1000) / 10;
}

export function normalizeCustomerKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Resolve only unambiguous exact customer_master matches.
 * This is intentionally pure so the export path can be tested without DB I/O. */
export function resolveCustomerDistricts(
  rows: Array<{ company: string | null; district: string | null }>,
): Map<string, string> {
  const candidates = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const key = normalizeCustomerKey(row.company);
    if (!key) continue;
    const district = row.district?.trim() ?? "";
    if (!district) continue;
    const districtKey = normalizeCustomerKey(district);
    const districts = candidates.get(key) ?? new Map<string, string>();
    districts.set(districtKey, district);
    candidates.set(key, districts);
  }
  return new Map(
    [...candidates.entries()]
      .filter(([, districts]) => districts.size === 1)
      .map(([key, districts]) => [key, [...districts.values()][0] ?? ""]),
  );
}

// Sum amounts from two arrays of rows keyed by a string field.
function mergeAmounts<K extends string>(
  cur: Array<{ key: K; amount: number }>,
  prior: Array<{ key: K; amount: number }>,
): Map<string, { thisFy: number; lastFy: number }> {
  const map = new Map<string, { thisFy: number; lastFy: number }>();
  for (const r of cur) {
    const k = r.key || "Unmapped";
    const ex = map.get(k) ?? { thisFy: 0, lastFy: 0 };
    ex.thisFy += Math.round(r.amount);
    map.set(k, ex);
  }
  for (const r of prior) {
    const k = r.key || "Unmapped";
    const ex = map.get(k) ?? { thisFy: 0, lastFy: 0 };
    ex.lastFy += Math.round(r.amount);
    map.set(k, ex);
  }
  return map;
}

function toDeepRows(map: Map<string, { thisFy: number; lastFy: number }>): ReportRow[] {
  const total = [...map.values()].reduce((s, v) => s + v.thisFy, 0);
  return [...map.entries()]
    .map(([label, { thisFy, lastFy }]) => ({
      label,
      thisFy,
      lastFy,
      diff: thisFy - lastFy,
      growthPct: growthPct(thisFy, lastFy),
      sharePct: total > 0 ? Math.round((thisFy / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.thisFy - a.thisFy);
}

// ── Filters ───────────────────────────────────────────────────────────────────

/** Optional entity/period filters. Names must match sale_line values:
 *  heads → head_canon, states → the NORMALISED state (normStateExpr output),
 *  customers → customer. months → current-FY month labels (subset). */
export type CompanyReportsFilter = {
  months?: string[];
  heads?: string[];
  states?: string[];
  customers?: string[];
  /** Match nothing — set when a prior-FY scope resolves to zero customers. */
  none?: boolean;
};

export function hasActiveFilter(f?: CompanyReportsFilter): boolean {
  if (!f) return false;
  return Boolean(f.months?.length || f.heads?.length || f.states?.length || f.customers?.length);
}

// ── Public types ──────────────────────────────────────────────────────────────

export type ReportRow = {
  label: string;
  thisFy: number;
  lastFy: number;
  diff: number;
  growthPct: number | null;
  sharePct: number;
};

export type QtyRow = {
  group: string;
  groupRaw: string;
  customer: string;
  state: string;
  qtyThisFy: number;
  qtyLastFy: number;
  amountThisFy: number;
  amountLastFy: number;
  unit: string;
};

export type SaleCustomerRow = {
  customer: string;
  state: string;
  head: string;
  thisFy: number;
  lastFy: number;
  diff: number;
};

export type Report1PartyRow = SaleCustomerRow & {
  /** Exact customer_master district, or blank when the match is ambiguous. */
  district: string;
};

export type Report2StateMonthRow = {
  state: string;
  month: string;
  thisFy: number | null;
  lastFy: number | null;
};

export type Report2PartyMonthRow = {
  state: string;
  customer: string;
  district: string;
  months: Array<{ month: string; thisFy: number | null; lastFy: number | null }>;
};

export type CompanyReportsPayload = {
  fy: string;
  priorFy: string;
  likeMonths: string[];
  likeMonthsPrior: string[];
  asOfDate: string;
  // Reports 1 & 2 — sale by state, like months
  r1r2_byState: ReportRow[];
  /** C1 export-only drill-down data. */
  c1_byState?: ReportRow[];
  r1_partyByCustomer?: Report1PartyRow[];
  r2_byStateMonth?: Report2StateMonthRow[];
  r2_byPartyMonth?: Report2PartyMonthRow[];
  // Report 3 — by segment/group, like months
  r3_byGroup: ReportRow[];
  // Report 3A — state × group, like months
  r3a_byStateGroup: Array<{ state: string; group: string; thisFy: number; lastFy: number }>;
  // Report 3B — party × group, like months
  r3b_byPartyGroup: Array<{ customer: string; state: string; group: string; thisFy: number; lastFy: number }>;
  // Report 3C — same group aggregation as 3 but showing both like-month and full prior year
  r3c_byGroupFull: Array<{ group: string; thisFyLike: number; lastFyLike: number; lastFyFull: number; growthLike: number | null }>;
  // Report 4 — QUANTITY per group+customer+state (Rule 2: never sum across groups)
  r4_byGroupQty: QtyRow[];
  // Report 5 — sale by customer (collection: not yet connected — PARTY O/S & PAYMENT 26-27)
  r5_byCustomer: SaleCustomerRow[];
  r5_collectionNote: string;
  // Report 6 — total by group (full prior year for purchase context)
  r6_byGroupFull: Array<{ group: string; thisFyLike: number; lastFyLike: number; lastFyFull: number; growthLike: number | null }>;
  // Report 7 — as-of date snapshot
  r7_asOf: {
    date: string;
    total: number;
    byGroup: Array<{ group: string; amount: number }>;
    byState: Array<{ state: string; amount: number }>;
    invoiceCount: number;
    customerCount: number;
    note: string;
  };
  // Monthly primary totals (for CombinedPerformanceDashboard like-months coverage)
  monthlyPrimary: Array<{ label: string; amount: number; byHead: Record<string, number> }>;
};

export type CompanyReportsBuildOptions = { includeC1ExportData?: boolean };

export function c1ExportDataEnabled(options?: CompanyReportsBuildOptions): boolean {
  return options?.includeC1ExportData === true;
}

async function resolvePriorFilter(
  fy: string,
  filter?: CompanyReportsFilter,
): Promise<CompanyReportsFilter | undefined> {
  return resolvePriorEntityFilter(fy, filter);
}
export async function buildCompanyReports(
  fy: string,
  asOfDate?: string,
  filter?: CompanyReportsFilter,
  options?: CompanyReportsBuildOptions,
): Promise<CompanyReportsPayload> {
  const includeC1ExportData = c1ExportDataEnabled(options);
  const priorFyStr = computePriorFy(fy);
  const like = await computeLikeMonths(fy);
  const { likeMonths, likeMonthsPrior } = applyMonthFilter(like.current, like.prior, filter);
  const today = asOfDate ?? new Date().toISOString().slice(0, 10);

  if (likeMonths.length === 0) {
    // No complete months yet — return empty but valid shape
    const empty: CompanyReportsPayload = {
      fy, priorFy: priorFyStr, likeMonths: [], likeMonthsPrior: [], asOfDate: today,
      r1r2_byState: [], r3_byGroup: [], r3a_byStateGroup: [], r3b_byPartyGroup: [],
      c1_byState: [], r1_partyByCustomer: [], r2_byStateMonth: [], r2_byPartyMonth: [],
      r3c_byGroupFull: [], r4_byGroupQty: [], r5_byCustomer: [],
      r5_collectionNote: "No collection data source connected.",
      r6_byGroupFull: [], r7_asOf: { date: today, total: 0, byGroup: [], byState: [], invoiceCount: 0, customerCount: 0, note: "No data" },
      monthlyPrimary: [],
    };
    return empty;
  }

  // Prior-FY entity scope — see resolvePriorFilter.
  const priorFilter = await resolvePriorFilter(fy, filter);

  // All DB queries run in parallel
  const [
    curByState,
    priorByState,
    curByGroup,
    priorByGroup,
    curByStateGroup,
    priorByStateGroup,
    curByPartyGroup,
    priorByPartyGroup,
    curQty,
    priorQty,
    curByCustomer,
    priorByCustomer,
    priorByGroupFull,
    asOfRows,
    monthlyRows,
    monthlyByHead,
    c1PriorByState,
    c1PriorByCustomer,
    c1CurrentByStateMonth,
    c1PriorByStateMonth,
    c1CurrentByCustomerMonth,
    c1PriorByCustomerMonth,
  ] = await Promise.all([
    // Reports 1+2: by state
    queryByState(fy, likeMonths, filter),
    queryByState(priorFyStr, likeMonthsPrior, priorFilter),
    // Report 3: by group
    queryByGroup(fy, likeMonths, filter),
    queryByGroup(priorFyStr, likeMonthsPrior, priorFilter),
    // Report 3A: state × group
    queryByStateGroup(fy, likeMonths, filter),
    queryByStateGroup(priorFyStr, likeMonthsPrior, priorFilter),
    // Report 3B: party × group
    queryByPartyGroup(fy, likeMonths, filter),
    queryByPartyGroup(priorFyStr, likeMonthsPrior, priorFilter),
    // Report 4: qty per group+customer+state
    queryQty(fy, likeMonths, filter),
    queryQty(priorFyStr, likeMonthsPrior, priorFilter),
    // Report 5: by customer
    queryByCustomer(fy, likeMonths, filter),
    queryByCustomer(priorFyStr, likeMonthsPrior, priorFilter),
    // Report 6 (3C): full prior year by group
    queryByGroupFull(priorFyStr, priorFilter),
    // Report 7: as-of
    queryAsOf(fy, today, filter),
    // Monthly primary (for Combined page)
    queryMonthlyTotal(fy, filter),
    queryMonthlyByHead(fy, filter),
    // C1 compares the same explicit head/state/customer scope in both years.
    // Do not apply resolvePriorEntityFilter here; that is web/Reports 3-7
    // territory semantics, not the export's direct historical scope.
    includeC1ExportData ? queryByState(priorFyStr, likeMonthsPrior, filter) : Promise.resolve([]),
    includeC1ExportData ? queryByCustomer(priorFyStr, likeMonthsPrior, filter) : Promise.resolve([]),
    includeC1ExportData ? queryByStateMonth(fy, likeMonths, filter) : Promise.resolve([]),
    includeC1ExportData ? queryByStateMonth(priorFyStr, likeMonthsPrior, filter) : Promise.resolve([]),
    includeC1ExportData ? queryByCustomerMonth(fy, likeMonths, filter) : Promise.resolve([]),
    includeC1ExportData ? queryByCustomerMonth(priorFyStr, likeMonthsPrior, filter) : Promise.resolve([]),
  ]);

  // Customer attribution is looked up only for parties already present in
  // Reports 1/2. Never load the full customer_master table for every export.
  const customerNames = includeC1ExportData ? [...new Set(
    [...curByCustomer, ...c1PriorByCustomer]
      .map((row) => normalizeCustomerKey(row.customer))
      .filter(Boolean),
  )] : [];
  const customerMasterRows = includeC1ExportData
    ? await queryCustomerMasterDistricts(customerNames)
    : [];

  // ── Reports 1 & 2 ──────────────────────────────────────────────────────────
  const stateMap = mergeAmounts(
    curByState.map((r) => ({ key: r.state as string, amount: r.amount })),
    priorByState.map((r) => ({ key: r.state as string, amount: r.amount })),
  );
  const r1r2_byState = toDeepRows(stateMap);

  // ── Report 3 ───────────────────────────────────────────────────────────────
  const groupMap = mergeAmounts(
    curByGroup.map((r) => ({ key: r.group as string, amount: r.amount })),
    priorByGroup.map((r) => ({ key: r.group as string, amount: r.amount })),
  );
  const r3_byGroup = toDeepRows(groupMap);

  // ── Report 3A ──────────────────────────────────────────────────────────────
  const sgMap = new Map<string, { thisFy: number; lastFy: number }>();
  for (const r of curByStateGroup) {
    const k = `${r.state}||${r.group}`;
    sgMap.set(k, { thisFy: Math.round(r.amount), lastFy: 0 });
  }
  for (const r of priorByStateGroup) {
    const k = `${r.state}||${r.group}`;
    const ex = sgMap.get(k) ?? { thisFy: 0, lastFy: 0 };
    ex.lastFy = Math.round(r.amount);
    sgMap.set(k, ex);
  }
  const r3a_byStateGroup = [...sgMap.entries()].map(([k, v]) => {
    const [state, group] = k.split("||");
    return { state: state ?? "", group: group ?? "", thisFy: v.thisFy, lastFy: v.lastFy };
  }).sort((a, b) => b.thisFy - a.thisFy);

  // ── Report 3B ──────────────────────────────────────────────────────────────
  const pgMap = new Map<string, { thisFy: number; lastFy: number; state: string }>();
  for (const r of curByPartyGroup) {
    const k = `${r.customer}||${r.group}||${r.state}`;
    pgMap.set(k, { thisFy: Math.round(r.amount), lastFy: 0, state: r.state });
  }
  for (const r of priorByPartyGroup) {
    const k = `${r.customer}||${r.group}||${r.state}`;
    const ex = pgMap.get(k) ?? { thisFy: 0, lastFy: 0, state: r.state };
    ex.lastFy = Math.round(r.amount);
    pgMap.set(k, ex);
  }
  const r3b_byPartyGroup = [...pgMap.entries()].map(([k, v]) => {
    const [customer, group] = k.split("||");
    return { customer: customer ?? "", group: group ?? "", state: v.state, thisFy: v.thisFy, lastFy: v.lastFy };
  }).sort((a, b) => b.thisFy - a.thisFy);

  // ── Report 3C + Report 6 — group with full prior year ──────────────────────
  const groupFullMap = new Map<string, { thisFyLike: number; lastFyLike: number; lastFyFull: number }>();
  for (const r of curByGroup) {
    const k = r.group || "Unmapped";
    const ex = groupFullMap.get(k) ?? { thisFyLike: 0, lastFyLike: 0, lastFyFull: 0 };
    ex.thisFyLike += Math.round(r.amount);
    groupFullMap.set(k, ex);
  }
  for (const r of priorByGroup) {
    const k = r.group || "Unmapped";
    const ex = groupFullMap.get(k) ?? { thisFyLike: 0, lastFyLike: 0, lastFyFull: 0 };
    ex.lastFyLike += Math.round(r.amount);
    groupFullMap.set(k, ex);
  }
  for (const r of priorByGroupFull) {
    const k = r.group || "Unmapped";
    const ex = groupFullMap.get(k) ?? { thisFyLike: 0, lastFyLike: 0, lastFyFull: 0 };
    ex.lastFyFull += Math.round(r.amount);
    groupFullMap.set(k, ex);
  }
  const groupFullRows = [...groupFullMap.entries()].map(([group, v]) => ({
    group,
    thisFyLike: v.thisFyLike,
    lastFyLike: v.lastFyLike,
    lastFyFull: v.lastFyFull,
    growthLike: growthPct(v.thisFyLike, v.lastFyLike),
  })).sort((a, b) => b.thisFyLike - a.thisFyLike);

  // ── Report 4 — quantity (Rule 2: never sum across groups) ──────────────────
  type QtyKey = string; // "group||groupRaw||customer||state"
  const qtyMap = new Map<QtyKey, QtyRow>();
  for (const r of curQty) {
    const k = `${r.group}||${r.groupRaw}||${r.customer}||${r.state}`;
    const ex = qtyMap.get(k) ?? {
      group: r.group, groupRaw: r.groupRaw, customer: r.customer, state: r.state,
      qtyThisFy: 0, qtyLastFy: 0, amountThisFy: 0, amountLastFy: 0, unit: r.unit,
    };
    ex.qtyThisFy += r.qty;
    ex.amountThisFy += Math.round(r.amount);
    if (r.unit && !ex.unit) ex.unit = r.unit;
    qtyMap.set(k, ex);
  }
  for (const r of priorQty) {
    const k = `${r.group}||${r.groupRaw}||${r.customer}||${r.state}`;
    const ex = qtyMap.get(k) ?? {
      group: r.group, groupRaw: r.groupRaw, customer: r.customer, state: r.state,
      qtyThisFy: 0, qtyLastFy: 0, amountThisFy: 0, amountLastFy: 0, unit: r.unit,
    };
    ex.qtyLastFy += r.qty;
    ex.amountLastFy += Math.round(r.amount);
    if (r.unit && !ex.unit) ex.unit = r.unit;
    qtyMap.set(k, ex);
  }
  const r4_byGroupQty = [...qtyMap.values()].sort((a, b) => b.amountThisFy - a.amountThisFy);

  // ── Report 5 — sale by customer ────────────────────────────────────────────
  const custMap = new Map<string, { thisFy: number; lastFy: number; state: string; head: string }>();
  for (const r of curByCustomer) {
    const k = r.customer || "";
    custMap.set(k, { thisFy: Math.round(r.amount), lastFy: 0, state: r.state, head: r.head });
  }
  for (const r of priorByCustomer) {
    const k = r.customer || "";
    const ex = custMap.get(k) ?? { thisFy: 0, lastFy: 0, state: r.state, head: r.head };
    ex.lastFy = Math.round(r.amount);
    custMap.set(k, ex);
  }
  const r5_byCustomer = [...custMap.entries()].map(([customer, v]) => ({
    customer,
    state: v.state,
    head: v.head,
    thisFy: v.thisFy,
    lastFy: v.lastFy,
    diff: v.thisFy - v.lastFy,
  })).sort((a, b) => b.thisFy - a.thisFy);

  // C1 uses direct historical filters, unlike the shared web/Reports 3-7
  // prior-entity scope above. Keep these datasets export-only.
  const c1_byState = includeC1ExportData
    ? toDeepRows(mergeAmounts(
      curByState.map((r) => ({ key: r.state as string, amount: r.amount })),
      c1PriorByState.map((r) => ({ key: r.state as string, amount: r.amount })),
    ))
    : [];
  const c1CustMap = new Map<string, { thisFy: number; lastFy: number; state: string; head: string }>();
  if (includeC1ExportData) {
    for (const r of curByCustomer) {
      const key = r.customer || "";
      c1CustMap.set(key, { thisFy: Math.round(r.amount), lastFy: 0, state: r.state, head: r.head });
    }
    for (const r of c1PriorByCustomer) {
      const key = r.customer || "";
      const existing = c1CustMap.get(key) ?? { thisFy: 0, lastFy: 0, state: r.state, head: r.head };
      existing.lastFy = Math.round(r.amount);
      c1CustMap.set(key, existing);
    }
  }
  const c1ByCustomer = [...c1CustMap.entries()].map(([customer, value]) => ({
    customer,
    state: value.state,
    head: value.head,
    thisFy: value.thisFy,
    lastFy: value.lastFy,
    diff: value.thisFy - value.lastFy,
  })).sort((a, b) => b.thisFy - a.thisFy);

  // District is attribution metadata, not a sales join. Resolve it in a
  // separate query and only retain an exact, unambiguous company match so a
  // duplicate customer_master row can never multiply a sale amount.
  const districtsByCustomer = resolveCustomerDistricts(customerMasterRows);
  const districtFor = (customer: string): string => districtsByCustomer.get(normalizeCustomerKey(customer)) ?? "";
  const r1_partyByCustomer: Report1PartyRow[] = c1ByCustomer.map((row) => ({
    ...row,
    district: districtFor(row.customer),
  }));

  // Month data is deliberately materialised only for complete, selected
  // current-FY months. The export uses the absence of a row as the live
  // formula's blank/future-month signal (never zero or -100%).
  const stateMonthMap = new Map<string, { state: string; month: string; thisFy: number | null; lastFy: number | null }>();
  for (const row of c1CurrentByStateMonth) {
    if (!row.month) continue;
    const key = `${row.state}||${row.month}`;
    stateMonthMap.set(key, { state: row.state, month: row.month, thisFy: Math.round(row.amount), lastFy: null });
  }
  for (const row of c1PriorByStateMonth) {
    if (!row.month) continue;
    const priorIndex = likeMonthsPrior.indexOf(row.month);
    const currentMonth = priorIndex >= 0 ? likeMonths[priorIndex] : row.month;
    const key = `${row.state}||${currentMonth}`;
    const existing = stateMonthMap.get(key) ?? { state: row.state, month: currentMonth, thisFy: null, lastFy: null };
    existing.lastFy = Math.round(row.amount);
    stateMonthMap.set(key, existing);
  }
  const r2_byStateMonth = [...stateMonthMap.values()]
    .sort((a, b) => a.state.localeCompare(b.state) || a.month.localeCompare(b.month));

  type PartyMonthAccum = {
    state: string;
    customer: string;
    thisFy: Map<string, number>;
    lastFy: Map<string, number>;
  };
  const partyMonthMap = new Map<string, PartyMonthAccum>();
  // Prefer the current-FY state for a customer. Prior-FY rows can carry the
  // historical state after entity resolution, but must still appear under the
  // selected current-FY state in the drill-down.
  const currentPartyStates = new Map<string, string>();
  for (const row of c1CurrentByCustomerMonth) {
    if (!row.month) continue;
    if (row.customer) currentPartyStates.set(row.customer, row.state);
    const key = row.customer || "";
    const existing = partyMonthMap.get(key) ?? {
      state: row.state,
      customer: key,
      thisFy: new Map<string, number>(),
      lastFy: new Map<string, number>(),
    };
    existing.state = currentPartyStates.get(key) ?? row.state;
    existing.thisFy.set(row.month, (existing.thisFy.get(row.month) ?? 0) + Math.round(row.amount));
    partyMonthMap.set(key, existing);
  }
  for (const row of c1PriorByCustomerMonth) {
    if (!row.month) continue;
    const key = row.customer || "";
    const existing = partyMonthMap.get(key) ?? {
      state: currentPartyStates.get(key) ?? row.state,
      customer: key,
      thisFy: new Map<string, number>(),
      lastFy: new Map<string, number>(),
    };
    existing.state = currentPartyStates.get(key) ?? existing.state;
    existing.lastFy.set(row.month, (existing.lastFy.get(row.month) ?? 0) + Math.round(row.amount));
    partyMonthMap.set(key, existing);
  }
  const r2_byPartyMonth: Report2PartyMonthRow[] = [...partyMonthMap.values()]
    .map((row) => ({
      state: row.state,
      customer: row.customer,
      district: districtFor(row.customer),
      months: likeMonths.map((month, index) => ({
        month,
        thisFy: row.thisFy.get(month) ?? null,
        lastFy: row.lastFy.get(likeMonthsPrior[index] ?? "") ?? null,
      })),
    }))
    .sort((a, b) => (b.months.reduce((s, m) => s + (m.thisFy ?? 0), 0) - a.months.reduce((s, m) => s + (m.thisFy ?? 0), 0)));

  // ── Report 7 — as-of ───────────────────────────────────────────────────────
  const asOfTotal = asOfRows.reduce((s, r) => s + Math.round(r.amount), 0);
  const asOfByGroup = new Map<string, number>();
  const asOfByState = new Map<string, number>();
  for (const r of asOfRows) {
    asOfByGroup.set(r.group, (asOfByGroup.get(r.group) ?? 0) + Math.round(r.amount));
    asOfByState.set(r.state, (asOfByState.get(r.state) ?? 0) + Math.round(r.amount));
  }

  // ── Monthly primary (for Combined page) ────────────────────────────────────
  const allFyLabels = fyMonthLabels(fy);
  const monthlyAmtMap = new Map<string, number>();
  for (const r of monthlyRows) {
    if (r.label) monthlyAmtMap.set(r.label, Math.round(r.amount));
  }
  const headMonthMap = new Map<string, Map<string, number>>();
  for (const r of monthlyByHead) {
    if (!r.label) continue;
    const hm = headMonthMap.get(r.label) ?? new Map<string, number>();
    hm.set(r.head || "Unmapped", Math.round(r.amount));
    headMonthMap.set(r.label, hm);
  }
  const monthlyPrimary = allFyLabels
    .filter((l) => monthlyAmtMap.has(l))
    .map((l) => ({
      label: l,
      amount: monthlyAmtMap.get(l) ?? 0,
      byHead: Object.fromEntries(headMonthMap.get(l) ?? new Map()),
    }));

  return {
    fy,
    priorFy: priorFyStr,
    likeMonths,
    likeMonthsPrior,
    asOfDate: today,
    r1r2_byState,
    c1_byState,
    r1_partyByCustomer: includeC1ExportData ? r1_partyByCustomer : [],
    r2_byStateMonth: includeC1ExportData ? r2_byStateMonth : [],
    r2_byPartyMonth: includeC1ExportData ? r2_byPartyMonth : [],
    r3_byGroup,
    r3a_byStateGroup,
    r3b_byPartyGroup,
    r3c_byGroupFull: groupFullRows,
    r4_byGroupQty,
    r5_byCustomer,
    r5_collectionNote:
      "Collection data not yet connected. Source: PARTY O/S & PAYMENT 26-27 " +
      "(spreadsheet 1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok).",
    r6_byGroupFull: groupFullRows,
    r7_asOf: {
      date: today,
      total: asOfTotal,
      byGroup: [...asOfByGroup.entries()].map(([group, amount]) => ({ group, amount })).sort((a, b) => b.amount - a.amount),
      byState: [...asOfByState.entries()].map(([state, amount]) => ({ state, amount })).sort((a, b) => b.amount - a.amount),
      invoiceCount: asOfRows.reduce((s, r) => s + r.invoices, 0),
      customerCount: new Set(asOfRows.map((r) => r.customerKey)).size,
      note: "Rows without invoice_date are included up to the current month.",
    },
    monthlyPrimary,
  };
}

// ── Private query functions ───────────────────────────────────────────────────

function whereClause(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  const conds = [eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"), ...entityConds(filter)];
  if (months.length > 0) conds.push(inArray(saleLines.monthLabel, months));
  return and(...conds);
}

async function queryByState(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    state: normStateExpr(),
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months, filter)).groupBy(sql`1`);
}

async function queryByGroup(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months, filter)).groupBy(sql`1`);
}

async function queryByGroupFull(fyStr: string, filter?: CompanyReportsFilter) {
  return db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"), ...entityConds(filter))).groupBy(sql`1`);
}

async function queryByStateGroup(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    state: normStateExpr(),
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months, filter)).groupBy(sql`1, 2`);
}

async function queryByPartyGroup(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: normStateExpr(),
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months, filter)).groupBy(sql`1, 2, 3`);
}

// Report 4: qty per group+customer+state, broken out by group_raw so WATER TANK
// litres are never merged with pipe pieces in the same row.
// RULE 2: results are grouped BY group — caller must never sum qty across groups.
async function queryQty(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  const rows = await db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    groupRaw: sql<string>`coalesce(${saleLines.groupRaw}, '')`,
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: normStateExpr(),
    qty: sql<number>`coalesce(case when max(coalesce(${saleLines.groupRaw}, '')) = 'WATER TANK' then sum(${saleLines.qtyLtr}::numeric) else sum(${saleLines.qty}::numeric) end, 0)::float8`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
    unit: sql<string>`case when max(${saleLines.groupRaw}) = 'WATER TANK' then 'Ltr' else coalesce(max(${itemMaster.unit}), '') end`,
  })
    .from(saleLines)
    .leftJoin(itemMaster, eq(saleLines.code, itemMaster.code))
    .where(whereClause(fyStr, months, filter))
    .groupBy(sql`1, 2, 3, 4`);
  return rows;
}

async function queryByCustomer(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: normStateExpr(),
    head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months, filter)).groupBy(sql`1, 2, 3`);
}

async function queryCustomerMasterDistricts(normalizedNames: string[]) {
  if (normalizedNames.length === 0) return [];
  const normalizedCompany = sql<string>`upper(regexp_replace(trim(coalesce(${customerMaster.company}, '')), '\\s+', ' ', 'g'))`;
  const rows: Array<{ company: string; district: string | null }> = [];
  // Keep each IN list well below Postgres/driver parameter limits. The
  // normalized expression preserves exact matching while allowing source
  // company casing and repeated whitespace to vary safely.
  for (let offset = 0; offset < normalizedNames.length; offset += 500) {
    const chunk = normalizedNames.slice(offset, offset + 500);
    const result = await db.select({
      company: customerMaster.company,
      district: customerMaster.district,
    }).from(customerMaster).where(inArray(normalizedCompany, chunk));
    rows.push(...result);
  }
  return rows;
}

async function queryByStateMonth(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    state: normStateExpr(),
    month: saleLines.monthLabel,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines)
    .where(whereClause(fyStr, months, filter))
    .groupBy(sql`1, 2`);
}

async function queryByCustomerMonth(fyStr: string, months: string[], filter?: CompanyReportsFilter) {
  if (months.length === 0) return [];
  return db.select({
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: normStateExpr(),
    month: saleLines.monthLabel,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines)
    .where(whereClause(fyStr, months, filter))
    .groupBy(sql`1, 2, 3`);
}

// Report 7: totals up to and including asOfDate.
// Rows with NULL invoice_date fall back to: include if month_label <= asOfMonth.
async function queryAsOf(fyStr: string, asOfDate: string, filter?: CompanyReportsFilter) {
  // Derive the month label for the asOf date (e.g. "2026-07-13" → "Jul-26")
  const dt = new Date(asOfDate + "T00:00:00Z");
  const MONTHS_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const asOfMonthLabel = `${MONTHS_ABBR[dt.getUTCMonth()]}-${String(dt.getUTCFullYear()).slice(-2)}`;

  const allMonths = fyMonthLabels(fyStr);
  const monthsUpTo = allMonths.filter((m) => m <= asOfMonthLabel);

  return db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    state: normStateExpr(),
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    customerKey: sql<string>`coalesce(${saleLines.customer}, '')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
    invoices: sql<number>`count(distinct coalesce(${saleLines.invoiceNo}, ${saleLines.lineUid}))::int`,
  })
    .from(saleLines)
    .where(
      and(
        eq(saleLines.fy, fyStr),
        ...entityConds(filter),
        or(
          lte(saleLines.invoiceDate, asOfDate),
          and(isNull(saleLines.invoiceDate), monthsUpTo.length > 0 ? inArray(saleLines.monthLabel, monthsUpTo) : eq(saleLines.fy, fyStr)),
        ),
      ),
    )
    .groupBy(sql`1, 2, 3`);
}

async function queryMonthlyTotal(fyStr: string, filter?: CompanyReportsFilter) {
  return db.select({
    label: sql<string>`coalesce(${saleLines.monthLabel}, '')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"), ...entityConds(filter))).groupBy(sql`1`);
}

async function queryMonthlyByHead(fyStr: string, filter?: CompanyReportsFilter) {
  return db.select({
    label: sql<string>`coalesce(${saleLines.monthLabel}, '')`,
    head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"), ...entityConds(filter))).groupBy(sql`1, 2`);
}


function applyMonthFilter(
  likeMonths: string[],
  likeMonthsPrior: string[],
  filter?: CompanyReportsFilter,
): { likeMonths: string[]; likeMonthsPrior: string[] } {
  if (!filter?.months?.length) return { likeMonths, likeMonthsPrior };
  const wanted = new Set(filter.months);
  const keep = likeMonths.map((m, i) => [m, likeMonthsPrior[i]] as const).filter(([m]) => wanted.has(m));
  return { likeMonths: keep.map(([m]) => m), likeMonthsPrior: keep.map(([, p]) => p) };
}
