// Corrected analytics computed directly on sale_line.
//
// Rules (spec sections D-F):
// - Every YoY / trend figure excludes incomplete months. A month is complete
//   only if its max invoice date reaches the last calendar day of the month.
// - Territory and institutional revenue are never blended into one growth
//   number; they move in opposite directions.
// - Margins are computed only over codes present in cost_master. While it is
//   empty, margin_by_group is [] — there is NO fallback to any list price.
// - QTY is never summed across groups (mixed units); revenue is the only
//   cross-group aggregate used here.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, saleLines, costMaster } from "@workspace/db";
import { SAP_FY } from "../sap/config.js";
import { isSapVerified } from "../sap/verify.js";
import { getSapAggregate, type SapAggregate } from "../sap/source.js";

const MONTH_NAMES = [
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
  "Jan",
  "Feb",
  "Mar",
] as const;

// 'Apr-26' -> { name: 'Apr', fyIndex: 0 }. Fiscal order: Apr..Mar.
function parseMonthLabel(label: string): { name: string; fyIndex: number } | null {
  const name = label.slice(0, 3);
  const idx = (MONTH_NAMES as readonly string[]).indexOf(name);
  if (idx === -1) return null;
  return { name, fyIndex: idx };
}

// Last calendar day of the month a label like 'Apr-26' refers to.
function lastDayOfMonth(label: string): Date | null {
  const parsed = parseMonthLabel(label);
  const yy = Number(label.slice(4));
  if (!parsed || !Number.isFinite(yy)) return null;
  const year = 2000 + yy;
  const monthIdx = (3 + parsed.fyIndex) % 12; // Apr = 3 (0-based calendar)
  // Day 0 of the next month = last day of this month (UTC, date-only).
  return new Date(Date.UTC(year, monthIdx + 1, 0));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A month is complete when its max invoice date reaches the month's last
// calendar day. Some live register workbooks (historical FYs) have no
// per-invoice DATE column, so every row's invoice_date is null; for those
// months fall back to the calendar — the month is complete once it has fully
// elapsed.
export function isMonthComplete(
  monthLabel: string,
  maxInvoiceDate: string | null,
  now: number = Date.now(),
): boolean {
  const lastDay = lastDayOfMonth(monthLabel);
  if (lastDay == null) return false;
  if (maxInvoiceDate != null) {
    return (
      new Date(`${maxInvoiceDate}T00:00:00Z`).getTime() >= lastDay.getTime()
    );
  }
  // Fully elapsed means the whole last day is over, i.e. we are at or past
  // the first moment of the following month.
  return now >= lastDay.getTime() + MS_PER_DAY;
}

export type MonthStat = {
  monthLabel: string;
  monthName: string;
  amount: number;
  territoryAmount: number;
  institutionalAmount: number;
  maxInvoiceDate: string | null;
  complete: boolean;
};

async function monthlyStats(fy: string): Promise<MonthStat[]> {
  const rows = await db
    .select({
      monthLabel: sql<string>`coalesce(${saleLines.monthLabel}, '')`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      territoryAmount: sql<number>`coalesce(sum(${saleLines.amount}) filter (where ${saleLines.isTerritory}), 0)::float8`,
      maxDate: sql<string | null>`max(${saleLines.invoiceDate})::text`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(sql`1`);

  const stats: MonthStat[] = [];
  for (const row of rows) {
    const parsed = parseMonthLabel(row.monthLabel);
    if (!parsed) continue;
    const complete = isMonthComplete(row.monthLabel, row.maxDate);
    stats.push({
      monthLabel: row.monthLabel,
      monthName: parsed.name,
      amount: Math.round(row.amount),
      territoryAmount: Math.round(row.territoryAmount),
      institutionalAmount: Math.round(row.amount - row.territoryAmount),
      maxInvoiceDate: row.maxDate,
      complete,
    });
  }
  stats.sort(
    (a, b) =>
      (parseMonthLabel(a.monthLabel)?.fyIndex ?? 0) -
      (parseMonthLabel(b.monthLabel)?.fyIndex ?? 0),
  );
  return stats;
}

export type YoySplit = {
  current: number;
  prior: number;
  pct: number | null;
};

function yoy(current: number, prior: number): YoySplit {
  return {
    current: Math.round(current),
    prior: Math.round(prior),
    pct: prior === 0 ? null : Math.round(((current - prior) / prior) * 1000) / 10,
  };
}

export type HeadStat = {
  head: string;
  amount: number;
  sharePct: number;
  isTerritory: boolean;
};

export type GroupStat = {
  group: string;
  amount: number;
  sharePct: number;
};

// Product-group breakdown by revenue. Always sourced from sale_line.groupCanon
// regardless of whether SAP is the primary source — group classification lives
// in the register and is present in both FY26-27 SAP-verified and non-verified paths.
async function groupStats(fy: string): Promise<GroupStat[]> {
  const rows = await db
    .select({
      group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(sql`1`);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return rows
    .map((r) => ({
      group: r.group,
      amount: Math.round(r.amount),
      sharePct: total === 0 ? 0 : Math.round((r.amount / total) * 1000) / 10,
    }))
    .sort((a, b) => b.amount - a.amount);
}

async function headStats(fy: string): Promise<HeadStat[]> {
  const rows = await db
    .select({
      head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
      isTerritory: sql<boolean>`bool_or(coalesce(${saleLines.isTerritory}, false))`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(sql`1`);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return rows
    .map((r) => ({
      head: r.head,
      amount: Math.round(r.amount),
      sharePct: total === 0 ? 0 : Math.round((r.amount / total) * 1000) / 10,
      isTerritory: r.isTerritory,
    }))
    .sort((a, b) => b.amount - a.amount);
}

type CustomerPeriod = Map<string, number>;

async function customerRevenue(
  fy: string,
  monthLabels: string[],
): Promise<CustomerPeriod> {
  if (monthLabels.length === 0) return new Map();
  const rows = await db
    .select({
      customer: sql<string>`coalesce(${saleLines.customer}, '')`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), inArray(saleLines.monthLabel, monthLabels), eq(saleLines.versionStatus, "current")))
    .groupBy(sql`1`);
  const map: CustomerPeriod = new Map();
  for (const row of rows) {
    if (row.customer !== "") map.set(row.customer, row.amount);
  }
  return map;
}

export type Retention = {
  periodMonths: string[];
  retained: number;
  newCustomers: number;
  lost: number;
  retainedRevenue: number;
  newRevenue: number;
  lostPriorRevenue: number;
};

export type MarginGroup = {
  group: string;
  revenue: number;
  margin: number;
};

export type Margins = {
  byGroup: MarginGroup[];
  coveragePct: number;
  provisional: boolean;
  message: string | null;
};

// Margin = SUM(amount) - SUM(qty * fg_cost), only over codes in cost_master.
// Coverage = share of FY revenue whose codes have a cost.
async function margins(fy: string): Promise<Margins> {
  const [coverage] = await db
    .select({
      total: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      covered: sql<number>`coalesce(sum(${saleLines.amount}) filter (where ${costMaster.code} is not null), 0)::float8`,
    })
    .from(saleLines)
    .leftJoin(costMaster, eq(saleLines.code, costMaster.code))
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")));

  const total = coverage?.total ?? 0;
  const covered = coverage?.covered ?? 0;
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;

  if (covered === 0) {
    return {
      byGroup: [],
      coveragePct: 0,
      provisional: false,
      message: "Add a Cost Master to enable margins.",
    };
  }

  const rows = await db
    .select({
      group: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
      revenue: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      cost: sql<number>`coalesce(sum(${saleLines.qty} * ${costMaster.fgCost}), 0)::float8`,
    })
    .from(saleLines)
    .innerJoin(costMaster, eq(saleLines.code, costMaster.code))
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(sql`1`);

  return {
    byGroup: rows
      .map((r) => ({
        group: r.group,
        revenue: Math.round(r.revenue),
        margin: Math.round(r.revenue - r.cost),
      }))
      .sort((a, b) => b.revenue - a.revenue),
    coveragePct,
    provisional: coveragePct < 75,
    message:
      coveragePct < 75
        ? "Cost coverage is below 75 percent; margins are provisional."
        : null,
  };
}

async function saleLinePeriodCounts(
  fy: string,
  monthLabels: string[],
): Promise<{ invoices: number; customers: number }> {
  if (monthLabels.length === 0) return { invoices: 0, customers: 0 };
  const [row] = await db
    .select({
      invoices: sql<number>`count(distinct ${saleLines.invoiceNo})::int`,
      customers: sql<number>`count(distinct ${saleLines.customer})::int`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), inArray(saleLines.monthLabel, monthLabels), eq(saleLines.versionStatus, "current")));
  return { invoices: row?.invoices ?? 0, customers: row?.customers ?? 0 };
}

// A fiscal year's analytics can be sourced either from the invoice-line
// register (sale_line) or, once verified, from the uploaded SAP primary-sales
// files. Both implementations produce identical shapes so the /analytics route
// is agnostic to which source is active for a given FY.
export interface FyAnalyticsSource {
  monthlyStats(): Promise<MonthStat[]>;
  headStats(): Promise<HeadStat[]>;
  customerRevenue(monthLabels: string[]): Promise<Map<string, number>>;
  periodCounts(monthLabels: string[]): Promise<{ invoices: number; customers: number }>;
  margins(): Promise<Margins>;
}

function saleLineSource(fy: string): FyAnalyticsSource {
  return {
    monthlyStats: () => monthlyStats(fy),
    headStats: () => headStats(fy),
    customerRevenue: (labels) => customerRevenue(fy, labels),
    periodCounts: (labels) => saleLinePeriodCounts(fy, labels),
    margins: () => margins(fy),
  };
}

// Margins over the SAP aggregate: identical rule to sale_line — margin is
// revenue minus qty*fg_cost, only for codes present in cost_master. MRP/list
// price is NEVER used as a cost input.
async function sapMargins(agg: SapAggregate): Promise<Margins> {
  const total = agg.byCode.reduce((s, c) => s + c.revenue, 0);
  if (total === 0) {
    return {
      byGroup: [],
      coveragePct: 0,
      provisional: false,
      message: "Add a Cost Master to enable margins.",
    };
  }
  const codes = agg.byCode.map((c) => c.code);
  const costRows = codes.length
    ? await db
        .select({ code: costMaster.code, fgCost: costMaster.fgCost })
        .from(costMaster)
        .where(inArray(costMaster.code, codes))
    : [];
  const costMap = new Map<string, number>();
  for (const r of costRows) {
    if (r.fgCost != null) costMap.set(String(r.code).toUpperCase(), Number(r.fgCost));
  }
  let covered = 0;
  const byGroup = new Map<string, { revenue: number; cost: number }>();
  for (const c of agg.byCode) {
    const fgCost = costMap.get(c.code.toUpperCase());
    if (fgCost == null) continue;
    covered += c.revenue;
    const g = byGroup.get(c.group) ?? { revenue: 0, cost: 0 };
    g.revenue += c.revenue;
    g.cost += c.qty * fgCost;
    byGroup.set(c.group, g);
  }
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;
  if (covered === 0) {
    return {
      byGroup: [],
      coveragePct: 0,
      provisional: false,
      message: "Add a Cost Master to enable margins.",
    };
  }
  return {
    byGroup: [...byGroup.entries()]
      .map(([group, v]) => ({
        group,
        revenue: Math.round(v.revenue),
        margin: Math.round(v.revenue - v.cost),
      }))
      .sort((a, b) => b.revenue - a.revenue),
    coveragePct,
    provisional: coveragePct < 75,
    message:
      coveragePct < 75
        ? "Cost coverage is below 75 percent; margins are provisional."
        : null,
  };
}

function sapSource(agg: SapAggregate): FyAnalyticsSource {
  return {
    monthlyStats: async () => {
      const stats: MonthStat[] = agg.months
        .map((m) => ({
          monthLabel: m.monthLabel,
          monthName: m.monthName,
          amount: m.amount,
          territoryAmount: m.territoryAmount,
          institutionalAmount: m.institutionalAmount,
          maxInvoiceDate: m.maxInvoiceDate,
          complete: isMonthComplete(m.monthLabel, m.maxInvoiceDate),
        }))
        .filter((m) => parseMonthLabel(m.monthLabel) != null);
      stats.sort(
        (a, b) =>
          (parseMonthLabel(a.monthLabel)?.fyIndex ?? 0) -
          (parseMonthLabel(b.monthLabel)?.fyIndex ?? 0),
      );
      return stats;
    },
    headStats: async () => {
      const total = agg.byHead.reduce((s, h) => s + h.amount, 0);
      return agg.byHead
        .map((h) => ({
          head: h.head,
          amount: Math.round(h.amount),
          sharePct: total === 0 ? 0 : Math.round((h.amount / total) * 1000) / 10,
          isTerritory: h.isTerritory,
        }))
        .sort((a, b) => b.amount - a.amount);
    },
    customerRevenue: async (labels) => {
      const map = new Map<string, number>();
      for (const label of labels) {
        const cust = agg.customerByMonth.get(label);
        if (!cust) continue;
        for (const [name, amount] of cust) {
          map.set(name, (map.get(name) ?? 0) + amount);
        }
      }
      return map;
    },
    periodCounts: async (labels) => {
      let invoices = 0;
      const customers = new Set<string>();
      for (const label of labels) {
        invoices += agg.invoiceCountByMonth.get(label) ?? 0;
        const cust = agg.customerByMonth.get(label);
        if (cust) for (const name of cust.keys()) customers.add(name);
      }
      return { invoices, customers: customers.size };
    },
    margins: () => sapMargins(agg),
  };
}

export type AnalyticsReport = {
  fy: string;
  source: "sap" | "register";
  compareFy: string;
  months: MonthStat[];
  compareMonths: MonthStat[];
  comparableMonths: string[];
  yoy: {
    overall: YoySplit;
    territory: YoySplit;
    institutional: YoySplit;
  };
  invoicesInPeriod: number;
  customersInPeriod: number;
  byHead: HeadStat[];
  compareByHead: HeadStat[];
  retention: Retention;
  margins: Margins;
  groups: GroupStat[];
};

export function priorFy(fy: string): string {
  const start = Number(fy.slice(0, 4));
  const end = Number(fy.slice(5));
  return `${start - 1}-${String(end - 1).padStart(2, "0")}`;
}

export async function buildAnalytics(
  fy: string,
  compareFy: string,
): Promise<AnalyticsReport> {
  // Verification-gated cutover: FY2026-27 reads from the SAP primary-sales
  // upload only once it is verified; otherwise (and for every other FY) it
  // falls back to the invoice-line register. The comparison FY is ALWAYS
  // sourced from the register.
  const useSap = fy === SAP_FY && (await isSapVerified(fy));
  const currentSource: FyAnalyticsSource = useSap
    ? sapSource(await getSapAggregate(fy))
    : saleLineSource(fy);
  const compareSource = saleLineSource(compareFy);

  const [months, compareMonths, byHead, compareByHead, marginData, groups] =
    await Promise.all([
      currentSource.monthlyStats(),
      compareSource.monthlyStats(),
      currentSource.headStats(),
      compareSource.headStats(),
      currentSource.margins(),
      groupStats(fy),
    ]);

  // Comparable months: complete in the current FY AND complete in the prior
  // FY (matched by month name, e.g. Apr-26 vs Apr-25).
  const priorComplete = new Map(
    compareMonths.filter((m) => m.complete).map((m) => [m.monthName, m]),
  );
  const comparable = months.filter(
    (m) => m.complete && priorComplete.has(m.monthName),
  );
  const comparableMonths = comparable.map((m) => m.monthName);

  const sum = (arr: MonthStat[], pick: (m: MonthStat) => number) =>
    arr.reduce((s, m) => s + pick(m), 0);
  const priorComparable = comparableMonths
    .map((name) => priorComplete.get(name))
    .filter((m): m is MonthStat => m != null);

  const currentLabels = comparable.map((m) => m.monthLabel);
  const priorLabels = priorComparable.map((m) => m.monthLabel);

  const periodCounts = await currentSource.periodCounts(currentLabels);

  const [currentCustomers, priorCustomers] = await Promise.all([
    currentSource.customerRevenue(currentLabels),
    compareSource.customerRevenue(priorLabels),
  ]);

  let retained = 0;
  let retainedRevenue = 0;
  let newCustomers = 0;
  let newRevenue = 0;
  for (const [customer, revenue] of currentCustomers) {
    if (priorCustomers.has(customer)) {
      retained++;
      retainedRevenue += revenue;
    } else {
      newCustomers++;
      newRevenue += revenue;
    }
  }
  let lost = 0;
  let lostPriorRevenue = 0;
  for (const [customer, revenue] of priorCustomers) {
    if (!currentCustomers.has(customer)) {
      lost++;
      lostPriorRevenue += revenue;
    }
  }

  return {
    fy,
    source: useSap ? "sap" : "register",
    compareFy,
    months,
    compareMonths,
    comparableMonths,
    yoy: {
      overall: yoy(
        sum(comparable, (m) => m.amount),
        sum(priorComparable, (m) => m.amount),
      ),
      territory: yoy(
        sum(comparable, (m) => m.territoryAmount),
        sum(priorComparable, (m) => m.territoryAmount),
      ),
      institutional: yoy(
        sum(comparable, (m) => m.institutionalAmount),
        sum(priorComparable, (m) => m.institutionalAmount),
      ),
    },
    invoicesInPeriod: periodCounts?.invoices ?? 0,
    customersInPeriod: periodCounts?.customers ?? 0,
    byHead,
    compareByHead,
    retention: {
      periodMonths: comparableMonths,
      retained,
      newCustomers,
      lost,
      retainedRevenue: Math.round(retainedRevenue),
      newRevenue: Math.round(newRevenue),
      lostPriorRevenue: Math.round(lostPriorRevenue),
    },
    margins: marginData,
    groups,
  };
}
