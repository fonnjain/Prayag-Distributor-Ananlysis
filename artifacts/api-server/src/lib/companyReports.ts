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
import { db, saleLines, itemMaster } from "@workspace/db";
import { isMonthComplete } from "./analytics/analytics.js";
import { priorFy as computePriorFy, fyStartYear } from "./mgmt/names.js";

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

export type CompanyReportsPayload = {
  fy: string;
  priorFy: string;
  likeMonths: string[];
  likeMonthsPrior: string[];
  asOfDate: string;
  // Reports 1 & 2 — sale by state, like months
  r1r2_byState: ReportRow[];
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

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildCompanyReports(
  fy: string,
  asOfDate?: string,
): Promise<CompanyReportsPayload> {
  const priorFyStr = computePriorFy(fy);
  const { current: likeMonths, prior: likeMonthsPrior } = await computeLikeMonths(fy);
  const today = asOfDate ?? new Date().toISOString().slice(0, 10);

  if (likeMonths.length === 0) {
    // No complete months yet — return empty but valid shape
    const empty: CompanyReportsPayload = {
      fy, priorFy: priorFyStr, likeMonths: [], likeMonthsPrior: [], asOfDate: today,
      r1r2_byState: [], r3_byGroup: [], r3a_byStateGroup: [], r3b_byPartyGroup: [],
      r3c_byGroupFull: [], r4_byGroupQty: [], r5_byCustomer: [],
      r5_collectionNote: "No collection data source connected.",
      r6_byGroupFull: [], r7_asOf: { date: today, total: 0, byGroup: [], byState: [], invoiceCount: 0, customerCount: 0, note: "No data" },
      monthlyPrimary: [],
    };
    return empty;
  }

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
  ] = await Promise.all([
    // Reports 1+2: by state
    queryByState(fy, likeMonths),
    queryByState(priorFyStr, likeMonthsPrior),
    // Report 3: by group
    queryByGroup(fy, likeMonths),
    queryByGroup(priorFyStr, likeMonthsPrior),
    // Report 3A: state × group
    queryByStateGroup(fy, likeMonths),
    queryByStateGroup(priorFyStr, likeMonthsPrior),
    // Report 3B: party × group
    queryByPartyGroup(fy, likeMonths),
    queryByPartyGroup(priorFyStr, likeMonthsPrior),
    // Report 4: qty per group+customer+state
    queryQty(fy, likeMonths),
    queryQty(priorFyStr, likeMonthsPrior),
    // Report 5: by customer
    queryByCustomer(fy, likeMonths),
    queryByCustomer(priorFyStr, likeMonthsPrior),
    // Report 6 (3C): full prior year by group
    queryByGroupFull(priorFyStr),
    // Report 7: as-of
    queryAsOf(fy, today),
    // Monthly primary (for Combined page)
    queryMonthlyTotal(fy),
    queryMonthlyByHead(fy),
  ]);

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

function whereClause(fyStr: string, months: string[]) {
  if (months.length === 0) return and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"));
  return and(eq(saleLines.fy, fyStr), inArray(saleLines.monthLabel, months), eq(saleLines.versionStatus, "current"));
}

async function queryByState(fyStr: string, months: string[]) {
  if (months.length === 0) return [];
  return db.select({
    state: sql<string>`coalesce(${saleLines.stateCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months)).groupBy(sql`1`);
}

async function queryByGroup(fyStr: string, months: string[]) {
  if (months.length === 0) return [];
  return db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months)).groupBy(sql`1`);
}

async function queryByGroupFull(fyStr: string) {
  return db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"))).groupBy(sql`1`);
}

async function queryByStateGroup(fyStr: string, months: string[]) {
  if (months.length === 0) return [];
  return db.select({
    state: sql<string>`coalesce(${saleLines.stateCanon}, 'Unmapped')`,
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months)).groupBy(sql`1, 2`);
}

async function queryByPartyGroup(fyStr: string, months: string[]) {
  if (months.length === 0) return [];
  return db.select({
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: sql<string>`coalesce(${saleLines.stateCanon}, 'Unmapped')`,
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months)).groupBy(sql`1, 2, 3`);
}

// Report 4: qty per group+customer+state, broken out by group_raw so WATER TANK
// litres are never merged with pipe pieces in the same row.
// RULE 2: results are grouped BY group — caller must never sum qty across groups.
async function queryQty(fyStr: string, months: string[]) {
  if (months.length === 0) return [];
  const rows = await db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    groupRaw: sql<string>`coalesce(${saleLines.groupRaw}, '')`,
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: sql<string>`coalesce(${saleLines.stateCanon}, 'Unmapped')`,
    qty: sql<number>`coalesce(case when max(coalesce(${saleLines.groupRaw}, '')) = 'WATER TANK' then sum(${saleLines.qtyLtr}::numeric) else sum(${saleLines.qty}::numeric) end, 0)::float8`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
    unit: sql<string>`case when max(${saleLines.groupRaw}) = 'WATER TANK' then 'Ltr' else coalesce(max(${itemMaster.unit}), '') end`,
  })
    .from(saleLines)
    .leftJoin(itemMaster, eq(saleLines.code, itemMaster.code))
    .where(whereClause(fyStr, months))
    .groupBy(sql`1, 2, 3, 4`);
  return rows;
}

async function queryByCustomer(fyStr: string, months: string[]) {
  if (months.length === 0) return [];
  return db.select({
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    state: sql<string>`coalesce(${saleLines.stateCanon}, 'Unmapped')`,
    head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(whereClause(fyStr, months)).groupBy(sql`1, 2, 3`);
}

// Report 7: totals up to and including asOfDate.
// Rows with NULL invoice_date fall back to: include if month_label <= asOfMonth.
async function queryAsOf(fyStr: string, asOfDate: string) {
  // Derive the month label for the asOf date (e.g. "2026-07-13" → "Jul-26")
  const dt = new Date(asOfDate + "T00:00:00Z");
  const MONTHS_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const asOfMonthLabel = `${MONTHS_ABBR[dt.getUTCMonth()]}-${String(dt.getUTCFullYear()).slice(-2)}`;

  const allMonths = fyMonthLabels(fyStr);
  const monthsUpTo = allMonths.filter((m) => m <= asOfMonthLabel);

  return db.select({
    group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
    state: sql<string>`coalesce(${saleLines.stateCanon}, 'Unmapped')`,
    customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    customerKey: sql<string>`coalesce(${saleLines.customer}, '')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
    invoices: sql<number>`count(distinct coalesce(${saleLines.invoiceNo}, ${saleLines.lineUid}))::int`,
  })
    .from(saleLines)
    .where(
      and(
        eq(saleLines.fy, fyStr),
        or(
          lte(saleLines.invoiceDate, asOfDate),
          and(isNull(saleLines.invoiceDate), monthsUpTo.length > 0 ? inArray(saleLines.monthLabel, monthsUpTo) : eq(saleLines.fy, fyStr)),
        ),
      ),
    )
    .groupBy(sql`1, 2, 3`);
}

async function queryMonthlyTotal(fyStr: string) {
  return db.select({
    label: sql<string>`coalesce(${saleLines.monthLabel}, '')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"))).groupBy(sql`1`);
}

async function queryMonthlyByHead(fyStr: string) {
  return db.select({
    label: sql<string>`coalesce(${saleLines.monthLabel}, '')`,
    head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
    amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
  }).from(saleLines).where(and(eq(saleLines.fy, fyStr), eq(saleLines.versionStatus, "current"))).groupBy(sql`1, 2`);
}
