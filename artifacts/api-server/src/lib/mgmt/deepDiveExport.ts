import ExcelJS from "exceljs";
import { SALES_DEEP_DIVE_EXTRA_MANIFEST as SHARED_EXTRA_MANIFEST } from "@workspace/api-zod";
import type { MemberKpis } from "./deepDiveData.js";
import type { MemberSheetData } from "./memberSheet.js";
import type { RoiCost } from "./roiCost.js";
import type { SkuSpread } from "./skuSpread.js";
import type { WinBackItem } from "./winBack.js";

/**
 * The export consumes the already-resolved page payload.  It intentionally has
 * no Sheets or database dependency: exporting must not produce a second,
 * potentially different, read of the underlying registers.
 */
export type DeepDiveMonthlyRow = {
  monthLabel: string;
  monthIdx: number;
  planAmount: number | null;
  orderedAmount: number | null;
  receivedAmount: number | null;
  /** Received / plan as a 0–1 ratio from the resolved monthly payload. */
  achievementPct: number | null;
  notYetRecorded: boolean;
};

export type DeepDivePeriodRow = {
  label: string;
  plan: number | null;
  orderBooking: number | null;
  sale: number | null;
  achievementNumerator: number | null;
  achievementDenominator: number | null;
};

export type DeepDivePeriodAnalysis = {
  currentYtdSales: number | null;
  priorSamePeriodSales: number | null;
  currentYtdOb: number | null;
  priorSamePeriodOb: number | null;
  fullYearSales?: number | null;
  fullYearOb?: number | null;
  priorFullYearSales?: number | null;
  priorFullYearOb?: number | null;
  selectedPeriodSales?: number | null;
  selectedPeriodOb?: number | null;
  selectedMonthSales?: number | null;
  selectedMonthOb?: number | null;
  selectedMonthPlan?: number | null;
  selectedMonthLabel?: string;
  currentYtdPlan?: number | null;
  selectedPeriodPlan?: number | null;
  fullYearPlan?: number | null;
  aggregationNote?: string;
  quarters?: DeepDivePeriodRow[];
  currentPeriodLabel?: string;
  priorPeriodLabel?: string;
};

/**
 * An explicitly resolved peer benchmark.  The exporter never derives a
 * benchmark from the selected member or from an unnamed "company average".
 * Callers must provide the population and period that were actually loaded.
 */
export type DeepDiveBenchmark = {
  metric: "attainment" | "sales" | "orderBooking" | "costRatio" | "businessPerRetailer";
  median: number | null;
  population: string;
  peerCount: number;
  period: string;
  source: string;
  /** Cost benchmark denominator/basis, when metric is costRatio. */
  basis?: "ctcOnly" | "fullCost" | string;
  reason?: string;
};

export type DeepDiveExportInput = {
  fy: string;
  kpis: MemberKpis;
  monthlyRows: DeepDiveMonthlyRow[];
  periodLabel?: string;
  periodMonths?: number[];
  generatedAt?: Date;
  dataReadAt?: number | null;
  provisionalMonths?: string;
  monthlySource?: string;
  dataSource?: string;
  fromDbSnapshot?: boolean;
  stale?: boolean;
  retailerDetailStatus?: "ok" | "loading" | "not-mapped" | "error" | "not-loaded";
  retailerRowCount?: number | null;
  retailerDetail?: MemberSheetData | null;
  roiCost?: RoiCost | null;
  skuSpread?: SkuSpread | null;
  winBack?: WinBackItem[] | null;
  periodAnalysis?: DeepDivePeriodAnalysis;
  skuSpreadIncluded?: boolean;
  winBackIncluded?: boolean;
  /** Backward-compatible single benchmark input for focused exports. */
  benchmark?: DeepDiveBenchmark;
  benchmarks?: DeepDiveBenchmark[];
  /** Closed reporting-month count used by the selected sales metric. */
  reportingMonthCount?: number | null;
  /** A resolved page field; no workbook-layer source lookup is performed. */
  omissions?: string[];
};

type Scalar = string | number | Date | null;
const GREY = "FFE7E7E7";
const NAVY = "FF17365D";
const BLUE = "FFD9EAF7";

function state(v: number | null): "value" | "zero" | "unavailable" {
  return v == null ? "unavailable" : v === 0 ? "zero" : "value";
}

function grey(cell: ExcelJS.Cell): void {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
}

function money(cell: ExcelJS.Cell, v: number | null): void {
  if (v == null) {
    cell.value = null;
    grey(cell);
    return;
  }
  cell.value = v;
  cell.numFmt = '"₹"#,##,##0;[Red]-"₹"#,##,##0';
}

function numberCell(cell: ExcelJS.Cell, v: number | null): void {
  cell.value = v;
  if (v == null) grey(cell);
  else cell.numFmt = "#,##,##0.00";
}

function pctCell(cell: ExcelJS.Cell, pct: number | null): void {
  cell.value = pct == null ? null : pct / 100;
  if (pct == null) grey(cell);
  cell.numFmt = "0.00%";
}

function title(ws: ExcelJS.Worksheet, text: string, headers: string[]): void {
  ws.addRow([text]);
  ws.mergeCells(1, 1, 1, Math.max(1, headers.length));
  const t = ws.getCell(1, 1);
  t.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  ws.getRow(1).height = 24;
  ws.addRow(headers);
  const h = ws.getRow(2);
  h.font = { bold: true };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  h.alignment = { wrapText: true, vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 2 }];
}

function finish(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.eachRow((r, n) => { if (n > 2) r.alignment = { wrapText: true, vertical: "top" }; });
  if (widths.length > 0) ws.autoFilter = { from: "A2", to: `${String.fromCharCode(64 + Math.min(26, widths.length))}2` };
}

function metric(
  ws: ExcelJS.Worksheet,
  label: string,
  value: number | null,
  source: string,
  reason: string,
  kind: "money" | "number" = "number",
): void {
  const r = ws.addRow([label, null, null, null, null, state(value), source, value == null ? reason : ""]);
  if (kind === "money") money(r.getCell(2), value);
  else numberCell(r.getCell(2), value);
}

function percentage(
  ws: ExcelJS.Worksheet,
  label: string,
  numerator: number | null,
  denominator: number | null,
  source: string,
  reason: string,
  kind: "money" | "number" = "money",
): void {
  const pct = numerator != null && denominator != null && denominator > 0
    ? numerator / denominator * 100 : null;
  const r = ws.addRow([label, null, null, null, null, state(pct), source, pct == null ? reason : ""]);
  if (kind === "money") {
    money(r.getCell(3), numerator);
    money(r.getCell(4), denominator);
  } else {
    numberCell(r.getCell(3), numerator);
    numberCell(r.getCell(4), denominator);
  }
  pctCell(r.getCell(5), pct);
}

function dateSerial(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const serial = Number(value.trim());
  if (Number.isFinite(serial)) return serial;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getTime() / 86400000 + 25569;
}

function resolvedDoj(kpis: MemberKpis): number | null {
  const ex = kpis.extra ?? {};
  for (const key of ["DATEOFJOINING", "DOJ", "DATEJOINING"]) {
    const v = dateSerial(ex[key]);
    if (v != null) return v;
  }
  return null;
}

function sourceFor(input: DeepDiveExportInput): string {
  return input.dataSource ?? "Resolved State Head Dashboard page payload";
}

function extraNumber(kpis: MemberKpis, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = kpis.extra?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(/[,\s₹]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function extraText(kpis: MemberKpis, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = kpis.extra?.[key];
    if (value != null && String(value).trim() !== "") return String(value);
  }
  return null;
}

function friendlyExtraLabel(key: string): string | null {
  const labels: Record<string, string> = {
    STATE: "State",
    WORKINGSTATE: "Working state",
    EMPLOYEECODE: "Employee code",
    EMP_CODE: "Employee code",
    OLDNEW: "Old / new",
    OLDORNEW: "Old / new",
    CHANNEL: "Channel",
    CHANNELTYPE: "Channel",
    TARGETRANGE: "Target range",
    TARGETBAND: "Target range",
    STATUS: "Status",
  };
  if (labels[key]) return labels[key];
  if (/^A\d+$/.test(key) || /^COL\d+$/.test(key) || key.includes("INTERNAL")) return null;
  return null;
}

type MappedExtraSpec = {
  label: string;
  unit: "money" | "number" | "percent" | "text";
};

// Explicit page-field allowlist. Unknown extras are never dumped with their
// source header: they are reported as omissions in Info instead.
const LOCAL_EXTRA_MANIFEST: Record<string, MappedExtraSpec> = {
  // The page's EXTRA_LABELS manifest (profile / achievement).
  STATE: { label: "State", unit: "text" },
  WORKINGSTATE: { label: "Working State", unit: "text" },
  DOJ: { label: "Date of Joining", unit: "text" },
  EMPCODE: { label: "Employee Code", unit: "text" },
  ACTIVELEFT: { label: "Active / Left", unit: "text" },
  OLDNEW: { label: "Old / New", unit: "text" },
  SECONDARYPRIMARY: { label: "Channel (Secondary / Primary)", unit: "text" },
  TARGETRANGE: { label: "Target Range", unit: "text" },
  JUN: { label: "Jun (month indicator)", unit: "number" },
  ACHIEVEMENT: { label: "Secondary Order Booking (achieved amount)", unit: "money" },
  TARGETACHIEVEMENT: { label: "Target Achievement", unit: "percent" },
  TARGETACHIEVEMENTSALE: { label: "Target Achievement (Sale)", unit: "percent" },
  DIRECTDEALERPRIMARYTARGETACHIEVEMENT: { label: "DD Primary Target Achievement", unit: "percent" },
  BELOW60DEALER: { label: "Dealers Below 60% Achievement", unit: "number" },
  BUSINESSACHIEVED50ANDABOVE: { label: "Parties — 50%+ Achievement", unit: "number" },
  TARGETCROSSCHECK: { label: "Target Cross-check", unit: "money" },
  // Business breakdown.
  BUSINESSACHIEVEDBY: { label: "Business Achieved By (parties)", unit: "number" },
  BUSINESSACHIVEDBYNOOFOLDPARTIES: { label: "Business — Old Parties", unit: "number" },
  BUSINESSACHIVEDBYNOOFNEWPARTIES: { label: "Business — New Parties", unit: "number" },
  BUSINESSACHIEVEDBYDIRECTDEALER: { label: "Business — Direct Dealer", unit: "number" },
  BUSINESSBREAKDOWN: { label: "Business breakdown", unit: "money" },
  OLDPARTYBUSINESS: { label: "Business — old party", unit: "money" },
  NEWPARTYBUSINESS: { label: "Business — new party", unit: "money" },
  DIRECTDEALERBUSINESS: { label: "Business — direct dealer", unit: "money" },
  SECONDARYBUSINESS: { label: "Business — secondary", unit: "money" },
  TOTALBUSINESS: { label: "Business — total", unit: "money" },
  BUSINESSRECEIVEDPARTIESVISITS: { label: "Parties Giving Business", unit: "number" },
  NEWRETAILERS: { label: "New Retailers", unit: "number" },
  NEWPARTYORDERS: { label: "New Party Orders", unit: "number" },
  // Counterwise / visit breakdown.
  TOTALLEADCOUNTERS: { label: "Lead Counters", unit: "number" },
  TOTALLEADVISITS: { label: "Lead Visits", unit: "number" },
  TOTALNONLEADVISITS: { label: "Non-Lead Visits", unit: "number" },
  DISTRIBUTORCOUNTER: { label: "Distributor Counter", unit: "number" },
  DISTRIBUTORVISITS: { label: "Distributor Visits", unit: "number" },
  DIRECTDEALERCOUNTER: { label: "Direct Dealer Counter", unit: "number" },
  DIRECTDEALERVISITS: { label: "Direct Dealer Visits", unit: "number" },
  DISTRIBUTORDIRECTDEALERLEADCOUNTER: { label: "Distributor DD Lead Counter", unit: "number" },
  DISTRIBUTORDIRECTDEALERLEADVISITS: { label: "Distributor DD Lead Visits", unit: "number" },
  ACTIVEPARTIESVISITS: { label: "Active Parties Visited", unit: "number" },
  TOTALVISITS: { label: "Total Visits", unit: "number" },
  VISITEDBUTNOBUSINESSRECEIVED: { label: "Visited — No Business", unit: "number" },
  NOVISITNOBUSINESSRECEIVED: { label: "No Visit, No Business", unit: "number" },
  // Activity & effort.
  AVERAGESALESPERDAY: { label: "Avg. Sales Per Day", unit: "money" },
  AVERAGEVISITPERDAY: { label: "Avg. Visits Per Day", unit: "number" },
  NOOFORDERS: { label: "No. of Orders", unit: "number" },
  TOTALWORKINGHOURS: { label: "Total Working Hours", unit: "number" },
  TOTALGPSKM: { label: "Total GPS km", unit: "number" },
  AVGDISTANCEKM: { label: "Avg. Distance (km)", unit: "number" },
  CTC: { label: "CTC", unit: "money" },
  CTC2025: { label: "CTC (FY 24-25)", unit: "money" },
  // Prior period and current totals.
  SALE2526: { label: "Sales FY 25-26", unit: "money" },
  TOTALORDER2526: { label: "Order Booking FY 25-26", unit: "money" },
  Q1: { label: "Q1 (Apr-Jun)", unit: "money" },
  Q2: { label: "Q2 (Jul-Sep)", unit: "money" },
  Q3: { label: "Q3 (Oct-Dec)", unit: "money" },
  Q4: { label: "Q4 (Jan-Mar)", unit: "money" },
  MONTHYDIRECTDEALERPRIMARYTARGET: { label: "Monthly DD Primary Target", unit: "money" },
  DIRECTDEALERPRIMARYTARGET: { label: "DD Primary Target", unit: "money" },
  SALE: { label: "Sale FY2025-26 (full year)", unit: "money" },
  TOTALORDER: { label: "Order Booking FY2025-26 (full year)", unit: "money" },
  SALENOWYTD: { label: "Sale YTD (current FY)", unit: "money" },
  TOTALORDERNOWYTD: { label: "Order Booking YTD (current FY)", unit: "money" },
  COUNTERWISEVISITS: { label: "Counterwise visits", unit: "number" },
  COUNTERWISECOUNTERS: { label: "Counterwise counters", unit: "number" },
  TOTALCOUNTERS: { label: "Total counters", unit: "number" },
  COUNTERSVISITED: { label: "Counters visited", unit: "number" },
  ACTIVITYHOURS: { label: "Activity hours", unit: "number" },
  MARKETWORKINGHOURS: { label: "Market working hours", unit: "number" },
  GPSDISTANCE: { label: "GPS distance (km)", unit: "number" },
  DISTANCE: { label: "Distance (km)", unit: "number" },
  TOTALORDERS: { label: "Total orders", unit: "number" },
  ORDERS: { label: "Orders", unit: "number" },
  AVERAGEORDER: { label: "Average order value", unit: "money" },
  AVGORDER: { label: "Average order value", unit: "money" },
  AVERAGEBUSINESS: { label: "Average business", unit: "money" },
  AVERAGEVISITS: { label: "Average visits", unit: "number" },
  AVGVISITS: { label: "Average visits", unit: "number" },
  ACHIEVEMENTPCT: { label: "Achievement detail (%)", unit: "percent" },
  SALESACHIEVEMENT: { label: "Sales achievement (%)", unit: "percent" },
  ORDERACHIEVEMENT: { label: "Order achievement (%)", unit: "percent" },
  ACHIEVEMENTSECONDARY: { label: "Secondary achievement (%)", unit: "percent" },
  ACHIEVEMENTDIRECTDEALER: { label: "Direct dealer achievement (%)", unit: "percent" },
  ACHIEVEMENTTOTAL: { label: "Total achievement (%)", unit: "percent" },
  ACHIEVEMENTSALE: { label: "Sales achievement detail (%)", unit: "percent" },
  TOTALSALE: { label: "Current total sales", unit: "money" },
  CURRENTTOTALORDER: { label: "Current total order", unit: "money" },
  CURRENTTOTALSALE: { label: "Current total sales", unit: "money" },
  PRIORTOTALORDER: { label: "Prior total order", unit: "money" },
  PRIORTOTALSALE: { label: "Prior total sales", unit: "money" },
  LASTYEARTOTAL: { label: "Prior total", unit: "money" },
  LASTYEARQ1: { label: "Prior FY Q1 total", unit: "money" },
  LASTYEARQ2: { label: "Prior FY Q2 total", unit: "money" },
  LASTYEARQ3: { label: "Prior FY Q3 total", unit: "money" },
  LASTYEARQ4: { label: "Prior FY Q4 total", unit: "money" },
};

// The shared manifest is authoritative for every page-named field. Local
// aliases cover additional resolved DTO headers not rendered by the page.
export const SALES_DEEP_DIVE_EXTRA_MANIFEST: Record<string, MappedExtraSpec> = {
  ...LOCAL_EXTRA_MANIFEST,
  ...SHARED_EXTRA_MANIFEST,
};

const EXTRA_DUPLICATE_KEYS = new Set([
  "PRIMARYTARGET", "SECONDARYTARGET", "MONTHLYTARGET", "ORDERBOOKING",
  "DIRECTDEALERSORDER", "NEWPARTYORDERBOOKING", "SALEREPORT",
  "CTCMONTHLY", "MONTHLYCTC", "CTCANNUAL", "TABILLSTCOST", "TABILLCOST",
  "TOTALRETAILERS", "VISITEDRETAILERS", "NONVISITED",
  "BUSINESSPERRETAILER", "DIRECTDEALERCOUNT", "WORKINGDAYS",
]);

function mappedExtraSpec(key: string): MappedExtraSpec | null {
  if (SALES_DEEP_DIVE_EXTRA_MANIFEST[key]) return SALES_DEEP_DIVE_EXTRA_MANIFEST[key];
  if (/^Q[1-4]$/.test(key)) {
    return { label: `Current/prior ${key} total`, unit: "money" };
  }
  if (/^TOTAL(ORDER|SALE)\d{4}$/.test(key)) {
    return { label: key.startsWith("TOTALORDER") ? `Prior total order (${key.slice(-4)})` : `Prior total sales (${key.slice(-4)})`, unit: "money" };
  }
  return null;
}

function rawExtraNumber(value: number | string | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const percent = value.trim().endsWith("%");
  const parsed = Number(value.replace(/[,%\s₹]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return percent ? parsed / 100 : parsed;
}

function addMappedExtraRows(
  ws: ExcelJS.Worksheet,
  kpis: MemberKpis,
  source: string,
): string[] {
  const omissions: string[] = [];
  const usedLabels = new Set<string>();
  for (const [key, value] of Object.entries(kpis.extra ?? {})) {
    const upper = key.toUpperCase();
    const profileLabel = friendlyExtraLabel(upper);
    if (profileLabel) continue;
    if (["DOJ", "DATEOFJOINING", "DATEJOINING"].includes(upper)) {
      omissions.push(`${key}: raw source key omitted because it is represented by the typed Date of Joining row.`);
      continue;
    }
    if (/^A\d+$/.test(upper) || /^COL\d+$/.test(upper) || upper.includes("INTERNAL")) {
      omissions.push(`${key}: omitted internal source field.`);
      continue;
    }
    if (upper.includes("COSTRATIO") || (upper.includes("COST") && upper.includes("RATIO"))) {
      omissions.push(`${key}: unverified source field; suppressed from all numeric KPI rows.`);
      continue;
    }
    if (EXTRA_DUPLICATE_KEYS.has(upper)) {
      omissions.push(`${key}: omitted duplicate of a typed KPI.`);
      continue;
    }
    const spec = mappedExtraSpec(upper);
    if (!spec) {
      omissions.push(`${key}: omitted because it is not in the approved mapped-extra allowlist.`);
      continue;
    }
    if (usedLabels.has(spec.label)) {
      omissions.push(`${key}: omitted duplicate label ${spec.label}.`);
      continue;
    }
    usedLabels.add(spec.label);
    const r = ws.addRow([spec.label, null, null, null, null, "unavailable", source, ""]);
    const n = rawExtraNumber(value);
    if (spec.unit === "text") {
      r.getCell(2).value = value == null ? null : String(value);
      if (value != null) r.getCell(6).value = "value";
    } else if (spec.unit === "money") {
      money(r.getCell(2), n);
      r.getCell(6).value = state(n);
    } else if (spec.unit === "percent") {
      const sourceRatio = n == null ? null : Math.abs(n) <= 5 ? n : n / 100;
      r.getCell(2).value = sourceRatio;
      r.getCell(2).numFmt = "0.00%";
      if (sourceRatio == null) grey(r.getCell(2));
      r.getCell(6).value = state(sourceRatio);
      const operands: [number | null, number | null] =
        upper === "TARGETACHIEVEMENT" ? [
          kpis.orderBooking == null && kpis.newPartyOrderBooking == null && kpis.directDealersOrder == null
            ? null : (kpis.orderBooking ?? 0) + (kpis.newPartyOrderBooking ?? 0) + (kpis.directDealersOrder ?? 0),
          kpis.totalTargetToDate,
        ] : upper === "TARGETACHIEVEMENTSALE" ? [kpis.sale, kpis.totalTargetToDate]
          : upper === "DIRECTDEALERPRIMARYTARGETACHIEVEMENT" ? [kpis.directDealersOrder, kpis.primaryTarget]
            : [null, null];
      if (operands[0] != null || operands[1] != null) {
        money(r.getCell(3), operands[0]);
        money(r.getCell(4), operands[1]);
        const audited = operands[0] != null && operands[1] != null && operands[1] > 0
          ? operands[0] / operands[1] * 100 : null;
        pctCell(r.getCell(5), audited);
        r.getCell(8).value = "Source percentage is metadata; authoritative audited percentage is in the final column.";
      } else {
        r.getCell(8).value = "Source percentage unverified; no numerator/denominator was available.";
      }
    } else {
      numberCell(r.getCell(2), n);
      r.getCell(6).value = state(n);
    }
    if (n == null && spec.unit !== "text") r.getCell(8).value = "Mapped source value was not numeric.";
  }
  return omissions;
}

export type DeepDivePeriodMonthSource = {
  month: string;
  plan?: number | null;
  orderBooking: number | null;
  sale: number | null;
  notYetRecorded?: boolean;
};

/**
 * Builds the same period basis used by the page from its resolved month DTO.
 * Prior values are accepted only when a resolved prior-period payload supplies
 * them; this helper never treats a current plan as prior actuals.
 */
export function buildDeepDivePeriodAnalysis(
  months: DeepDivePeriodMonthSource[] | null | undefined,
  periodMonths?: number[],
  fallbackRows: DeepDiveMonthlyRow[] = [],
  prior?: Pick<DeepDivePeriodAnalysis, "priorSamePeriodSales" | "priorSamePeriodOb" | "priorFullYearSales" | "priorFullYearOb">,
): DeepDivePeriodAnalysis {
  const monthIndex = new Map(["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
    .map((name, i) => [name.toUpperCase(), i + 1]));
  const source = months && months.length > 0
    ? months.map((m, i) => ({ month: m.month, monthIdx: monthIndex.get(m.month.slice(0, 3).toUpperCase()) ?? i + 1, plan: m.plan ?? null, orderBooking: m.orderBooking, sale: m.sale, notYetRecorded: m.notYetRecorded }))
    : fallbackRows.map((r) => ({ month: r.monthLabel, monthIdx: r.monthIdx + 1, plan: r.planAmount, orderBooking: r.orderedAmount, sale: r.receivedAmount, notYetRecorded: r.notYetRecorded }));
  const sum = (rows: typeof source, field: "orderBooking" | "sale" | "plan"): number | null => {
    if (rows.length === 0 || rows.some((r) => r[field] == null)) return null;
    return rows.reduce((total, r) => total + (r[field] ?? 0), 0);
  };
  const exactMonths = (rows: typeof source, expected: number[]): boolean =>
    rows.length === expected.length
    && new Set(rows.map((r) => r.monthIdx)).size === expected.length
    && expected.every((month) => rows.some((r) => r.monthIdx === month))
    && rows.every((r) => r.plan != null && r.orderBooking != null && r.sale != null && !r.notYetRecorded);
  const contiguousYtd = source.length >= 3
    && exactMonths(source, Array.from({ length: Math.max(...source.map((r) => r.monthIdx)) }, (_, i) => i + 1));
  const selected = periodMonths == null ? source : source.filter((r) => periodMonths.includes(r.monthIdx));
  const selectedMonth = periodMonths?.length === 1 ? selected[0] : undefined;
  const comparisonMonths = periodMonths ? [...new Set(periodMonths)].sort((a, b) => a - b) : [];
  const exactComparisonQuarter = comparisonMonths.length === 3
    && comparisonMonths[2] - comparisonMonths[0] === 2
    && comparisonMonths.every((month, i) => month === comparisonMonths[0] + i)
    && (comparisonMonths[0] - 1) % 3 === 0;
  const exactComparisonFullYear = comparisonMonths.length === 12
    && comparisonMonths.every((month, i) => month === i + 1);
  const comparisonSource = source.filter((r) => comparisonMonths.includes(r.monthIdx));
  const priorComparisonAllowed = (exactComparisonQuarter || exactComparisonFullYear)
    && exactMonths(comparisonSource, comparisonMonths);
  const quarterRows = [0, 1, 2, 3].map((quarter) => {
    const expected = [quarter * 3 + 1, quarter * 3 + 2, quarter * 3 + 3];
    const quarterMonths = source.filter((r) => expected.includes(r.monthIdx));
    const completeQuarter = exactMonths(quarterMonths, expected);
    const qPlan = completeQuarter ? sum(quarterMonths, "plan") : null;
    const qOb = completeQuarter ? sum(quarterMonths, "orderBooking") : null;
    const qSale = completeQuarter ? sum(quarterMonths, "sale") : null;
    return {
      label: `Q${quarter + 1}`,
      plan: qPlan,
      orderBooking: qOb,
      sale: qSale,
      achievementNumerator: qSale,
      achievementDenominator: qPlan,
    };
  });
  const sumPlan = (rows: typeof source): number | null => {
    if (rows.length === 0 || rows.every((r) => r.plan == null)) return null;
    return rows.reduce((total, r) => total + (r.plan ?? 0), 0);
  };
  const fullYearComplete = exactMonths(source, Array.from({ length: 12 }, (_, i) => i + 1));
  const aggregationNote = source.length === 0
    ? "Monthly source unavailable; no aggregate was calculated."
    : [
      !contiguousYtd ? "Partial monthly source; YTD aggregate remains unavailable until the resolved closed-month boundary is complete." : "",
      !fullYearComplete ? "Partial monthly source; full-year aggregate requires all 12 distinct FY months." : "",
    ].filter(Boolean).join(" ");
  return {
    currentYtdSales: contiguousYtd ? sum(source, "sale") : null,
    currentYtdOb: contiguousYtd ? sum(source, "orderBooking") : null,
    priorSamePeriodSales: priorComparisonAllowed ? prior?.priorSamePeriodSales ?? null : null,
    priorSamePeriodOb: priorComparisonAllowed ? prior?.priorSamePeriodOb ?? null : null,
    fullYearSales: fullYearComplete ? sum(source, "sale") : null,
    fullYearOb: fullYearComplete ? sum(source, "orderBooking") : null,
    priorFullYearSales: exactComparisonFullYear ? prior?.priorFullYearSales ?? null : null,
    priorFullYearOb: exactComparisonFullYear ? prior?.priorFullYearOb ?? null : null,
    selectedPeriodSales: sum(selected, "sale"),
    selectedPeriodOb: sum(selected, "orderBooking"),
    selectedMonthSales: selectedMonth?.sale ?? null,
    selectedMonthOb: selectedMonth?.orderBooking ?? null,
    selectedMonthPlan: selectedMonth?.plan ?? null,
    selectedMonthLabel: selectedMonth?.month,
    currentYtdPlan: contiguousYtd ? sumPlan(source) : null,
    selectedPeriodPlan: sumPlan(selected),
    fullYearPlan: fullYearComplete ? sumPlan(source) : null,
    quarters: quarterRows,
    aggregationNote,
    currentPeriodLabel: periodMonths == null ? "Full Year / current FY" : "Selected period",
    priorPeriodLabel: "Same period prior FY",
  };
}

function addDecision(
  ws: ExcelJS.Worksheet,
  question: string,
  value: number | null,
  comparison: string,
  verdict: string,
  source: string,
  numerator: number | null = null,
  denominator: number | null = null,
  pct: number | null = null,
  reason = "",
  kind: "money" | "number" = "money",
): void {
  const r = ws.addRow(["", question, null, comparison, null, null, null, verdict, source, reason]);
  if (kind === "money") money(r.getCell(3), value);
  else numberCell(r.getCell(3), value);
  money(r.getCell(5), numerator);
  money(r.getCell(6), denominator);
  pctCell(r.getCell(7), pct);
}

export function buildDeepDiveWorkbook(input: DeepDiveExportInput): ExcelJS.Workbook {
  const { kpis } = input;
  const sourceA = sourceFor(input);
  const sourceB = "Resolved member working-sheet page payload";
  const sourceBStatus = input.retailerDetail?.status ?? input.retailerDetailStatus ?? "not-loaded";
  const sourceBStatusReason = sourceBStatus === "loading" || sourceBStatus === "not-loaded"
    ? "Source B not yet loaded."
    : sourceBStatus === "not-mapped" ? "Source B is not mapped for this member."
      : sourceBStatus === "error" ? "Source B failed to load; no inference made."
        : "";
  const detail = input.retailerDetail?.status === "ok" ? input.retailerDetail : null;
  const spread = detail?.spread;
  const roi = input.roiCost ?? null;
  const effectiveRows = detail?.rows ?? [];
  const effectiveDormant = input.winBack;
  const typedOrderInputs = [kpis.orderBooking, kpis.newPartyOrderBooking, kpis.directDealersOrder];
  const totalOb = typedOrderInputs.every((v): v is number => v != null)
    ? typedOrderInputs.reduce((sum, value) => sum + value, 0)
    : kpis.orderBooking;
  const totalTarget = kpis.totalTargetToDate;
  const totalSale = kpis.sale;
  const totalVisits = spread?.totalVisits ?? kpis.totalVisitsYtd;
  // CTC_MONTHLY × the authoritative elapsed-month field is the source of
  // truth for YTD cost.  Do not prefer a stale/absent ROI snapshot when the
  // resolved Data-tab payload has both operands; targets and peer benchmarks
  // use the same elapsed-month value.
  const costElapsed = input.reportingMonthCount ?? kpis.elapsedMonthsFromSheet ?? kpis.elapsedMonths ?? roi?.elapsedCompleteMonths ?? null;
  const ytdCtc = kpis.ctcMonthly != null && costElapsed != null
    ? kpis.ctcMonthly * costElapsed
    : roi?.ctcCostYtd ?? null;
  // A null Data-tab T.A. is unavailable, not a resolved zero from RoiCost
  // (that shared helper intentionally uses zero only for its own legacy math).
  const ytdTa = kpis.taBillStCost ?? null;
  const taAvailable = ytdTa != null;
  // A known CTC remains reportable as a known-cost lower bound. Missing T.A.
  // is disclosed below rather than silently poisoning the CTC calculation.
  const totalCost = ytdCtc != null ? ytdCtc + (ytdTa ?? 0) : null;
  // Prompt 81 cost KPI: denominator is resolved Sales Received, never OB.
  const denominator = kpis.sale;
  const ratio = totalCost != null && denominator != null && denominator > 0 ? totalCost / denominator * 100 : null;
  const salesCostMultiple = totalCost != null && totalSale != null && totalCost > 0 ? totalSale / totalCost : null;
  const obCostMultiple = totalCost != null && totalOb != null && totalCost > 0 ? totalOb / totalCost : null;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = input.generatedAt ?? new Date();
  wb.modified = wb.created;

  // 1. Summary for Decision.  This is intentionally a four-column decision
  // sheet.  Operands and source proof live in Working detail; the first sheet
  // must remain readable when printed.
  const summary = wb.addWorksheet("Summary for Decision");
  title(summary, "Sales Deep Dive — decisions", [
    "Decision block", "Figure / question", "Value / basis", "Verdict",
  ]);
  const period = input.periodAnalysis ?? buildDeepDivePeriodAnalysis(
    detail?.months,
    input.periodMonths,
    input.monthlyRows,
  );
  const priorTotal = kpis.lastYearQ1 != null || kpis.lastYearQ2 != null || kpis.lastYearQ3 != null || kpis.lastYearQ4 != null
    ? (kpis.lastYearQ1 ?? 0) + (kpis.lastYearQ2 ?? 0) + (kpis.lastYearQ3 ?? 0) + (kpis.lastYearQ4 ?? 0) : null;
  const totalRetailers = kpis.totalRetailers;
  const visited = kpis.visitedRetailers;
  const nonVisited = kpis.nonVisitedRetailers;
  const dashboardPartiesGivingBusiness = extraNumber(kpis, "BUSINESSACHIEVEDBY", "PARTIESGIVINGBUSINESS");
  const partiesGivingBusiness = detail
    ? effectiveRows.filter((r) => r.orderBooking > 0).length
    : dashboardPartiesGivingBusiness;
  const newRetailers = extraNumber(kpis, "NEWRETAILERS", "NEWPARTIES", "NEWRETAILERCOUNT");
  const orderCount = extraNumber(kpis, "NOOFORDERS", "TOTALORDERS", "ORDERS");
  const workingDays = kpis.workingDaysActual;
  const salesPerDay = workingDays != null && workingDays > 0 && totalSale != null ? totalSale / workingDays : null;
  const obPerDay = workingDays != null && workingDays > 0 && totalOb != null ? totalOb / workingDays : null;
  const ordersPerDay = workingDays != null && workingDays > 0 && orderCount != null ? orderCount / workingDays : null;
  const shortfall = (actual: number | null, target: number | null): number | null =>
    actual != null && target != null ? Math.max(0, target - actual) : null;
  const verdict = (value: number | null, unavailable: string, zero = "Genuine zero"): string =>
    value == null ? `Unavailable — ${unavailable}` : value === 0 ? zero : "Positive contribution";
  const pctAgainst = (actual: number | null, target: number | null): number | null =>
    actual != null && target != null && target > 0 ? actual / target * 100 : null;
  const benchmark = (metric: DeepDiveBenchmark["metric"]): DeepDiveBenchmark | null =>
    (input.benchmarks ?? []).find((b) => b.metric === metric)
      ?? (input.benchmark?.metric === metric ? input.benchmark : null);
  const benchmarkText = (b: DeepDiveBenchmark | null): string =>
    b == null
      ? "Benchmark unavailable: no explicit resolved peer population and period."
      : b.median == null
        ? `Benchmark unavailable: ${b.population} has no resolved median for ${b.period}. Basis ${b.basis ?? "unspecified"}. Source: ${b.source}.`
        : `Benchmark median ${b.median.toFixed(2)}; population ${b.population} (${b.peerCount} peers), period ${b.period}; basis ${b.basis ?? "unspecified"}; source ${b.source}.`;
  const addSummary = (
    blockName: string, question: string, value: number | null, basis: string, verdictText: string,
    kind: "money" | "number" | "percent" = "money",
  ) => {
    // Keep the basis visible without adding columns: operand/source text is
    // attached to the question, while column C remains a typed Excel value.
    const r = summary.addRow([blockName, `${question} — ${basis}; source: Working detail`, null, verdictText]);
    if (value != null) {
      if (kind === "money") money(r.getCell(3), value);
      else if (kind === "percent") pctCell(r.getCell(3), value);
      else numberCell(r.getCell(3), value);
    } else grey(r.getCell(3));
  };
  const block = (name: string) => summary.addRow([name, "", "", ""]);
  const addAttainment = (label: string, actual: number | null, target: number | null, source: string) => {
    const gap = shortfall(actual, target);
    addSummary("Attainment", label, actual,
      `${source}; target ${target == null ? "unavailable" : `₹${target.toLocaleString("en-IN")}`}; shortfall ${gap == null ? "unavailable" : `₹${gap.toLocaleString("en-IN")}`}`,
      actual == null || target == null ? "Unavailable — actual or target missing" : actual >= target ? "On track" : `Below target by ₹${gap!.toLocaleString("en-IN")}`);
    const achievement = pctAgainst(actual, target);
    addSummary("Attainment", `${label} achievement %`, achievement,
      `${source}; actual ÷ target`, achievement == null ? "Unavailable — denominator missing or not positive" : "Achievement calculated", "percent");
    addSummary("Attainment", `${label} shortfall`, gap,
      `${source}; max(target − actual, 0)`, gap == null ? "Unavailable — actual or target missing" : gap === 0 ? "No rupee shortfall" : `Below target by ₹${gap.toLocaleString("en-IN")}`);
  };

  block("Cost / ROI");
  addSummary("Cost / ROI", "Monthly cost (CTC)", kpis.ctcMonthly,
    `Monthly CTC; source ${sourceA}`, verdict(kpis.ctcMonthly, "monthly CTC missing"));
  addSummary("Cost / ROI", "Sales received", totalSale,
    `SALES_RECEIVED; source ${sourceA}`, verdict(totalSale, "sales received missing"));
  addSummary("Cost / ROI", "Order booking", totalOb,
    `Committed order value (OB), distinct from sales received; source ${sourceA}`,
    verdict(totalOb, "order booking missing"));
  addSummary("Cost / ROI", "YTD cost vs Sales Received", totalCost,
    `CTC_MONTHLY ₹${kpis.ctcMonthly?.toLocaleString("en-IN") ?? "unavailable"} × ${costElapsed ?? "unavailable"} authoritative reporting months + YTD T.A. ${taAvailable ? `₹${ytdTa!.toLocaleString("en-IN")}` : "unavailable (excluded)"} = ${taAvailable ? "total" : "known CTC"} ₹${totalCost?.toLocaleString("en-IN") ?? "unavailable"}; SALES_RECEIVED ₹${denominator?.toLocaleString("en-IN") ?? "unavailable"}; ${taAvailable ? "cost" : "known-cost"} ratio ${ratio == null ? "unavailable" : `${ratio.toFixed(2)}%`}`,
    ratio == null ? "Unavailable — SALES_RECEIVED denominator missing or not positive" : ratio <= 10 ? "Efficient" : "Review cost efficiency");
  const costBenchmark = benchmark("costRatio");
  addSummary("Cost / ROI", "Cost ratio vs peer median", ratio,
    `${benchmarkText(costBenchmark)}; denominator type SALES_RECEIVED`,
    ratio == null || costBenchmark?.median == null ? "Unavailable — explicit cost benchmark unresolved"
      : ratio > costBenchmark.median ? `Review — ${(ratio / costBenchmark.median).toFixed(1)}× peer median`
    : "At or below peer median", "percent");
  const obSalesNarrative = totalOb == null || totalSale == null
    ? "Order booking versus sales received is unavailable; the two measures require a matched basis."
    : totalOb > totalSale
      ? "Order booking exceeds sales received; these are distinct source/timing measures and the gap requires conversion/basis review."
      : totalOb < totalSale
        ? "Sales received exceeds order booking; these are distinct source/timing measures and the difference requires basis review."
        : "Order booking and sales received are equal on this extract; they remain distinct source/timing measures.";
  const plainSentence = `${taAvailable ? "Costs" : "Known CTC"} ₹${totalCost == null ? "unavailable" : (totalCost / 100000).toFixed(2)} L year to date${taAvailable ? "" : " (T.A. unavailable and excluded)"} and returned ₹${totalSale == null ? "unavailable" : (totalSale / 100000).toFixed(2)} L of sales — a ${taAvailable ? "cost" : "known-cost"} ratio of ${ratio == null ? "unavailable" : `${ratio.toFixed(1)}%`} against ${costBenchmark?.median == null ? "an unresolved peer median" : `a peer median of ${costBenchmark.median.toFixed(1)}%`}. ${obSalesNarrative}`;
  addSummary("Cost / ROI", "Plain decision", null, plainSentence, ratio == null ? "Unavailable — cost or sales basis incomplete" : "Decision basis stated");
  addSummary("Cost / ROI", "Sales / cost multiple", salesCostMultiple,
    "Sales received ÷ total YTD cost; sales and OB are distinct measures",
    verdict(salesCostMultiple, "sales or cost missing"), "number");
  addSummary("Cost / ROI", "OB / cost multiple", obCostMultiple,
    "Order booking value ÷ total YTD cost; OB is committed orders, not dispatch/sales received",
    verdict(obCostMultiple, "OB or cost missing"), "number");
  addSummary("Cost / ROI", "Sales received per working day", salesPerDay, "SALES_RECEIVED ÷ actual working days", verdict(salesPerDay, "sales or working days missing"));
  addSummary("Cost / ROI", "Order booking value/working day", obPerDay, "Order booking value ÷ actual working days", verdict(obPerDay, "OB or working days missing"));
  addSummary("Cost / ROI", "Orders count/working day", ordersPerDay, "NOOFORDERS ÷ actual working days; source-labelled in Working detail", verdict(ordersPerDay, "NOOFORDERS or working days missing"), "number");

  block("Attainment");
  addAttainment("Sales received vs total target", totalSale, totalTarget, sourceA);
  addAttainment("Secondary OB vs secondary target", kpis.orderBooking, kpis.secondaryTarget, sourceA);
  addAttainment("Direct dealer OB vs primary target", kpis.directDealersOrder, kpis.primaryTarget, sourceA);
  const attBenchmark = benchmark("attainment");
  addSummary("Attainment", "Achievement vs peer median", kpis.achievementTotal,
    `${benchmarkText(attBenchmark)}; selected member source ${sourceA}`, kpis.achievementTotal == null || attBenchmark?.median == null
      ? "Unavailable — explicit benchmark unresolved"
      : kpis.achievementTotal >= attBenchmark.median ? "Above peer median" : "Below peer median", "number");

  block("What works");
  addSummary("What works", "Parties giving business", partiesGivingBusiness,
    detail ? "Working-sheet retailer rows with order booking > ₹0"
      : "BUSINESSACHIEVEDBY resolved dashboard KPI; working-sheet rows are loading",
    verdict(partiesGivingBusiness, detail ? "working-sheet detail not loaded" : "BUSINESSACHIEVEDBY dashboard KPI not resolved"), "number");
  const obSalesMultiple = totalOb != null && totalSale != null && totalSale > 0 ? totalOb / totalSale : null;
  addSummary("What works", "OB vs Sales Received multiple", obSalesMultiple,
    "OB ÷ SALES_RECEIVED; OB is committed order value and sales received is dispatch/receipt — distinct measures",
    obSalesMultiple == null ? "Unavailable — one measure missing or sales is not positive" : obSalesMultiple > 1 ? "OB exceeds sales; review source basis and timing" : "OB does not exceed sales on this extract", "number");
  const businessDenominator = kpis.totalRetailers ?? spread?.totalRetailers ?? null;
  const businessPopulation = kpis.totalRetailers != null
    ? "declared dashboard/peer retailer totals (all retailers)"
    : "declared working-sheet retailer totals (all retailers)";
  const businessPerRetailer = businessDenominator != null && businessDenominator > 0 && totalOb != null
    ? totalOb / businessDenominator
    : kpis.businessPerRetailer;
  const businessBenchmark = benchmark("businessPerRetailer");
  addSummary("What works", "Business per retailer vs peer median", businessPerRetailer,
    `${benchmarkText(businessBenchmark)}; denominator ${businessDenominator ?? "unavailable"} ${businessPopulation}`,
    businessPerRetailer == null || businessBenchmark?.median == null ? "Unavailable — explicit peer median unresolved"
      : businessPerRetailer >= businessBenchmark.median ? "At or above peer median" : "Below peer median");
  addSummary("What works", "New retailers", newRetailers, "Resolved mapped KPI", verdict(newRetailers, "new-retailer count missing"), "number");
  addSummary("What works", "New-party order value", kpis.newPartyOrderBooking, "Resolved Data-tab new-party order booking", verdict(kpis.newPartyOrderBooking, "new-party OB missing"));
  addSummary("What works", "Visited retailer coverage", visited,
    `dashboard visited ${visited ?? "unavailable"} / dashboard total ${totalRetailers ?? "unavailable"}`,
    visited == null || totalRetailers == null ? "Unavailable — source counts missing" : visited === 0 ? "No retailer visits" : "Coverage present", "number");

  block("Risk");
  addSummary("Risk", "Non-visited retailer count", nonVisited,
    `dashboard non-visited ${nonVisited ?? "unavailable"} / dashboard total ${totalRetailers ?? "unavailable"}`,
    nonVisited == null ? "Unavailable — dashboard count missing" : nonVisited === 0 ? "Genuine zero" : "Follow up required", "number");
  addSummary("Risk", "Concentration HHI", input.skuSpread?.concentrationHhi ?? spread?.concentrationIndex ?? null,
    "Resolved segment/retailer concentration index", (() => {
      const hhi = input.skuSpread?.concentrationHhi ?? spread?.concentrationIndex ?? null;
      return hhi == null ? "Unavailable — concentration source missing"
        : hhi >= 2500 ? "High concentration — dependency risk"
          : hhi >= 1500 ? "Moderate concentration — monitor mix"
            : "Low concentration — diversified mix";
    })(), "number");
  const segmentKnown = input.skuSpread?.totalKnownSegments ?? null;
  addSummary("Risk", "Segment coverage", input.skuSpread?.distinctSegments ?? null,
    `${input.skuSpread?.distinctSegments ?? "unavailable"} of ${segmentKnown ?? "unavailable"} known segments`,
    input.skuSpread == null || segmentKnown == null ? "Unavailable — segment universe unresolved" : "Coverage shown as resolved segments / known universe", "number");
  addSummary("Risk", "Dormant retailer count", effectiveDormant == null ? null : effectiveDormant.length,
    "Full resolved win-back collection", effectiveDormant == null ? "Unavailable — collection not loaded" : effectiveDormant.length === 0 ? "Genuine zero" : "Review win-back list", "number");
  addSummary("Risk", "Dormant retailer value", effectiveDormant == null ? null : effectiveDormant.reduce((sum, item) => sum + item.lastNet, 0),
    "Sum of last NET for full dormant collection", effectiveDormant == null ? "Unavailable — collection not loaded" : "Review win-back value");
  const unavailable = [
    totalCost == null ? "YTD cost" : "",
    !taAvailable ? "YTD T.A." : "",
    denominator == null ? "Sales received denominator" : "",
    totalRetailers == null ? "Retailer total" : "",
    nonVisited == null ? "Non-visited count" : "",
    input.skuSpread == null ? "Segment spread" : "",
    effectiveDormant == null ? "Dormant collection" : "",
  ].filter(Boolean);
  addSummary("Risk", "Unavailable measures", null, unavailable.length > 0 ? unavailable.join(", ") : "None",
    unavailable.length > 0 ? "Unavailable list — do not interpret as zero" : "No named measures unavailable");

  block("Trend");
  addSummary("Trend", "Current sales vs same-period prior sales", kpis.sale,
    `${period?.currentPeriodLabel ?? "current period"} vs ${period?.priorPeriodLabel ?? "same period prior FY"}; prior ${period?.priorSamePeriodSales ?? "unavailable"}`,
    kpis.sale == null || period?.priorSamePeriodSales == null ? "Unavailable — prior sales unresolved" : kpis.sale >= period.priorSamePeriodSales ? "Growing" : "Declining");
  addSummary("Trend", "Current OB vs same-period prior OB", totalOb,
    `${period?.currentPeriodLabel ?? "current period"} vs ${period?.priorPeriodLabel ?? "same period prior FY"}; prior ${period?.priorSamePeriodOb ?? "unavailable"}`,
    totalOb == null || period?.priorSamePeriodOb == null ? "Unavailable — prior OB unresolved" : totalOb >= period.priorSamePeriodOb ? "Growing" : "Declining");
  addSummary("Trend", "Prior FY quarterly shape", priorTotal,
    "Q1–Q4 prior-year actuals; source-labelled in Performance and Prior Period",
    priorTotal == null ? "Unavailable — prior quarter source missing" : "Prior-year quarter sources resolved");
  for (const [label, value] of [["Prior FY Q1 share", kpis.lastYearQ1], ["Prior FY Q2 share", kpis.lastYearQ2], ["Prior FY Q3 share", kpis.lastYearQ3], ["Prior FY Q4 share", kpis.lastYearQ4]] as [string, number | null][]) {
    const share = pctAgainst(value, priorTotal);
    addSummary("Trend", label, share, "Quarter actual ÷ prior FY total",
      share == null ? "Unavailable — prior quarter or prior FY total missing" : "Share of prior FY", "percent");
  }
  addSummary("Trend", "Sales vs peer median", totalSale,
    benchmarkText(benchmark("sales")), totalSale == null || benchmark("sales")?.median == null ? "Unavailable — explicit benchmark unresolved" : totalSale >= (benchmark("sales")!.median ?? 0) ? "Above peer median" : "Below peer median");
  finish(summary, [20, 38, 100, 34]);

  // 2. Targets and Achievement
  const targets = wb.addWorksheet("Targets and Achievement");
  title(targets, "Targets and achievement", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"]);
  metric(targets, "Primary target (to date)", kpis.primaryTarget, sourceA, "Primary target unavailable", "money");
  metric(targets, "Secondary target (to date)", kpis.secondaryTarget, sourceA, "Secondary target unavailable", "money");
  metric(targets, "Total target (to date)", totalTarget, sourceA, "Total target unavailable", "money");
  metric(targets, "Retailer / party order booking", kpis.orderBooking, sourceA, "Retailer booking unavailable", "money");
  metric(targets, "New-party order booking", kpis.newPartyOrderBooking, sourceA, "New-party booking unavailable", "money");
  metric(targets, "Direct dealer order booking", kpis.directDealersOrder, sourceA, "Direct dealer booking unavailable", "money");
  metric(targets, "Sales received", kpis.sale, sourceA, "Sales unavailable", "money");
  metric(targets, "Monthly total target", kpis.monthlyTarget, sourceA, "Monthly target unavailable", "money");
  metric(targets, "Primary monthly target", kpis.primaryTargetMonthly, sourceA, "Primary monthly target unavailable", "money");
  metric(targets, "Secondary monthly target", kpis.secondaryTargetMonthly, sourceA, "Secondary monthly target unavailable", "money");
  metric(targets, "Elapsed months", kpis.elapsedMonths, sourceA, "Elapsed months unavailable");
  percentage(targets, "Secondary OB achievement", kpis.orderBooking, kpis.secondaryTarget, sourceA, "OB or target unavailable / denominator not positive");
  percentage(targets, "DD OB achievement", kpis.directDealersOrder, kpis.primaryTarget, sourceA, "DD OB or target unavailable / denominator not positive");
  const allOb = kpis.orderBooking == null && kpis.newPartyOrderBooking == null && kpis.directDealersOrder == null ? null :
    (kpis.orderBooking ?? 0) + (kpis.newPartyOrderBooking ?? 0) + (kpis.directDealersOrder ?? 0);
  percentage(targets, "Total OB achievement", allOb, totalTarget, sourceA, "OB channel or target unavailable / denominator not positive");
  percentage(targets, "Sales achievement", kpis.sale, totalTarget, sourceA, "Sales or target unavailable / denominator not positive");
  finish(targets, [36, 20, 20, 20, 18, 18, 48, 58]);

  // 3. Performance and Prior Period
  const performance = wb.addWorksheet("Performance and Prior Period");
  title(performance, "Performance and prior period", ["Measure / period", "Plan", "Order booking", "Direct dealer order", "Sales received", "Achievement", "Numerator", "Denominator", "Source", "Reason"]);
  const rows = input.periodMonths == null ? input.monthlyRows :
    input.monthlyRows.filter((r) => input.periodMonths!.includes(r.monthIdx + 1));
  const currentBasis = performance.addRow(["Current FY YTD", null, null, null, null, null, null, null, "Resolved member month payload", period.aggregationNote ?? ""]);
  money(currentBasis.getCell(2), period.currentYtdPlan ?? null);
  money(currentBasis.getCell(3), period.currentYtdOb ?? null);
  money(currentBasis.getCell(4), kpis.directDealersOrder);
  money(currentBasis.getCell(5), period.currentYtdSales ?? null);
  money(currentBasis.getCell(7), period.currentYtdSales ?? null);
  money(currentBasis.getCell(8), period.currentYtdPlan ?? null);
  pctCell(currentBasis.getCell(6),
    period.currentYtdSales != null && period.currentYtdPlan != null && period.currentYtdPlan > 0
      ? period.currentYtdSales / period.currentYtdPlan * 100 : null);
  if (input.periodMonths != null) {
    const selectedPeriod = performance.addRow(["Custom selected period", null, null, null, null, null, null, null, "Resolved member month payload", input.periodLabel ?? "Resolved selected fiscal months"]);
    money(selectedPeriod.getCell(2), period.selectedPeriodPlan ?? null);
    money(selectedPeriod.getCell(3), period.selectedPeriodOb ?? null);
    money(selectedPeriod.getCell(5), period.selectedPeriodSales ?? null);
    money(selectedPeriod.getCell(7), period.selectedPeriodSales ?? null);
    money(selectedPeriod.getCell(8), period.selectedPeriodPlan ?? null);
    pctCell(selectedPeriod.getCell(6),
      period.selectedPeriodSales != null && period.selectedPeriodPlan != null && period.selectedPeriodPlan > 0
        ? period.selectedPeriodSales / period.selectedPeriodPlan * 100 : null);
  }
  const fullYear = performance.addRow(["Full Year / current FY", null, null, null, null, null, null, null, "Resolved member month payload", period.aggregationNote ?? ""]);
  money(fullYear.getCell(2), period.fullYearPlan ?? null);
  money(fullYear.getCell(3), period.fullYearOb ?? null);
  money(fullYear.getCell(5), period.fullYearSales ?? null);
  money(fullYear.getCell(7), period.fullYearSales ?? null);
  money(fullYear.getCell(8), period.fullYearPlan ?? null);
  pctCell(fullYear.getCell(6),
    period.fullYearSales != null && period.fullYearPlan != null && period.fullYearPlan > 0
      ? period.fullYearSales / period.fullYearPlan * 100 : null);
  if (period.selectedMonthLabel) {
    const selectedMonth = performance.addRow([`Selected month — ${period.selectedMonthLabel}`, null, null, null, null, null, null, null, "Resolved member month payload", ""]);
    money(selectedMonth.getCell(2), period.selectedMonthPlan ?? null);
    money(selectedMonth.getCell(3), period.selectedMonthOb ?? null);
    money(selectedMonth.getCell(5), period.selectedMonthSales ?? null);
    money(selectedMonth.getCell(7), period.selectedMonthSales ?? null);
    money(selectedMonth.getCell(8), period.selectedMonthPlan ?? null);
    pctCell(selectedMonth.getCell(6),
      period.selectedMonthSales != null && period.selectedMonthPlan != null && period.selectedMonthPlan > 0
        ? period.selectedMonthSales / period.selectedMonthPlan * 100 : null);
  }
  const priorBasis = performance.addRow(["Prior FY same-period comparison", null, null, null, null, null, null, null, "Resolved prior-period payload",
    input.periodAnalysis?.priorPeriodLabel
      ? `Resolved period: ${input.periodAnalysis.priorPeriodLabel}`
      : "Unavailable — same-period prior FY values were not present in the resolved page payload."]);
  money(priorBasis.getCell(3), period.priorSamePeriodOb ?? null);
  money(priorBasis.getCell(5), period.priorSamePeriodSales ?? null);
  for (const quarter of period.quarters ?? []) {
    const q = performance.addRow([quarter.label, null, null, null, null, null, null, null, "Resolved member month payload",
      quarter.orderBooking == null || quarter.sale == null || quarter.plan == null
        ? "Partial quarter source; aggregate unavailable." : ""]);
    money(q.getCell(2), quarter.plan);
    money(q.getCell(3), quarter.orderBooking);
    money(q.getCell(5), quarter.sale);
    money(q.getCell(7), quarter.achievementNumerator);
    money(q.getCell(8), quarter.achievementDenominator);
    pctCell(q.getCell(6), quarter.achievementNumerator != null && quarter.achievementDenominator != null && quarter.achievementDenominator > 0
      ? quarter.achievementNumerator / quarter.achievementDenominator * 100 : null);
  }
  for (const r of rows) {
    const out = performance.addRow([r.monthLabel, null, null, null, null, null, null, null, input.monthlySource ?? "Resolved monthly page payload", r.notYetRecorded ? "not_yet_recorded — later cells are unavailable" : ""]);
    money(out.getCell(2), r.planAmount);
    money(out.getCell(3), r.orderedAmount);
    money(out.getCell(5), r.receivedAmount);
    const pct = r.achievementPct == null ? null : r.achievementPct * 100; // DB rows are 0–1
    pctCell(out.getCell(6), pct);
    money(out.getCell(7), r.receivedAmount);
    money(out.getCell(8), r.planAmount);
  }
  const prior = [kpis.lastYearQ1, kpis.lastYearQ2, kpis.lastYearQ3, kpis.lastYearQ4];
  ["Prior year Q1", "Prior year Q2", "Prior year Q3", "Prior year Q4"].forEach((label, i) => {
    const r = performance.addRow([label, null, prior[i], null, null, null, prior[i], null, "Resolved prior-period KPI payload", prior[i] == null ? "Prior-period actual unavailable" : ""]);
    money(r.getCell(3), prior[i]);
    money(r.getCell(7), prior[i]);
  });
  if (rows.length === 0) performance.addRow(["No monthly rows in selected resolved period", null, null, null, null, null, null, null, input.monthlySource ?? "Resolved monthly page payload", "Monthly detail unavailable for this selected period."]);
  finish(performance, [30, 18, 20, 20, 20, 18, 20, 20, 48, 58]);

  // 4. Coverage and Visits
  const coverage = wb.addWorksheet("Coverage and Visits");
  title(coverage, "Coverage and visits", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"]);
  metric(coverage, "Total retailers", kpis.totalRetailers, sourceA, "Dashboard retailer total unavailable");
  metric(coverage, "Working-sheet total retailers", spread?.totalRetailers ?? null, sourceB, "Working-sheet retailer total unavailable");
  metric(coverage, "Active retailers", spread?.activeRetailers ?? null, sourceB, "Working-sheet spread unavailable");
  metric(coverage, "Dormant retailers", spread?.dormantRetailers ?? null, sourceB, "Working-sheet spread unavailable");
  percentage(coverage, "Active retailer coverage", spread?.activeRetailers ?? null, spread?.totalRetailers ?? null, sourceB, "Active or total retailer count unavailable");
  metric(coverage, "Total visits YTD", totalVisits, sourceA, "Total visits unavailable");
  metric(coverage, "Working days actual", kpis.workingDaysActual, sourceA, "Working days unavailable");
  metric(coverage, "Visited retailers", kpis.visitedRetailers, sourceA, "Visited-retailer count unavailable");
  metric(coverage, "Non-visited retailers", kpis.nonVisitedRetailers, sourceA, "Non-visited-retailer count unavailable");
  metric(coverage, "Total old retailers", kpis.totalOldRetailers, sourceA, "Old-retailer count unavailable");
  metric(coverage, "Direct dealers count", kpis.directDealersCount, sourceA, "Direct-dealer count unavailable");
  metric(coverage, "Business per retailer", kpis.businessPerRetailer, sourceA, "Business-per-retailer unavailable", "money");
  metric(coverage, "Business per active retailer", spread?.businessPerActiveRetailer ?? null, sourceB, "Business-per-active-retailer unavailable", "money");
  metric(coverage, "Business per visit", spread?.businessPerVisit ?? null, sourceB, "Business-per-visit unavailable", "money");
  metric(coverage, "Effective retailers", spread?.activeRetailers ?? null, sourceB, "Effective retailer count unavailable");
  metric(coverage, "Annual business plan", spread?.annualBusinessPlan ?? null, sourceB, "Annual business plan unavailable", "money");
  metric(coverage, "New retailers count", newRetailers, sourceA, "New-retailer count unavailable");
  metric(coverage, "New-party order value", kpis.newPartyOrderBooking, sourceA, "New-party order value unavailable", "money");
  percentage(coverage, "Active retailer percentage", spread?.activeRetailers ?? null, spread?.totalRetailers ?? null, sourceB, "Active or total retailer count unavailable", "number");
  const sortedRetailers = [...effectiveRows].sort((a, b) => b.orderBooking - a.orderBooking);
  const top5 = sortedRetailers.slice(0, 5).reduce((sum, r) => sum + r.orderBooking, 0);
  const top10 = sortedRetailers.slice(0, 10).reduce((sum, r) => sum + r.orderBooking, 0);
  percentage(coverage, "Top 5 order-booking share", top5, spread?.totalOrderBooking ?? null, sourceB, "Retailer detail or total OB unavailable", "money");
  percentage(coverage, "Top 10 order-booking share", top10, spread?.totalOrderBooking ?? null, sourceB, "Retailer detail or total OB unavailable", "money");
  metric(coverage, "Retailer concentration HHI", spread?.concentrationIndex ?? null, sourceB, "Retailer concentration unavailable");
  // Coverage is an analytical sheet only.  Retailer rows, visit targets and
  // the raw visit-plan proof are deliberately kept out of it and are written
  // to Working detail below.
  const dashboardVisits = kpis.totalVisitsYtd;
  const workingSheetVisits = spread?.totalVisits ?? null;
  const visitMismatch = dashboardVisits != null && workingSheetVisits != null
    ? dashboardVisits - workingSheetVisits : null;
  const addCoverageComparison = (label: string, value: number | null, basis: string, source: string, reason: string, kind: "money" | "number" = "number") => {
    const r = coverage.addRow([label, null, null, null, null, state(value), source, reason]);
    if (kind === "money") money(r.getCell(2), value); else numberCell(r.getCell(2), value);
    r.getCell(8).value = reason || basis;
  };
  addCoverageComparison("Dashboard total visits", dashboardVisits, "Data-tab all-type visits", sourceA, dashboardVisits == null ? "Dashboard total unavailable" : "Distinct dashboard source", "number");
  addCoverageComparison("Working-sheet visits done", workingSheetVisits, "Retailer rows with visit values", sourceB, workingSheetVisits == null ? "Working-sheet visit total unavailable" : "Distinct working-sheet source", "number");
  addCoverageComparison("Visit total mismatch (dashboard − working-sheet)", visitMismatch,
    `${dashboardVisits ?? "unavailable"} − ${workingSheetVisits ?? "unavailable"}`, "Recomputed comparison", visitMismatch == null ? "Mismatch unavailable until both sources load" : "Visible source mismatch arithmetic", "number");
  const dashboardDerivedNonVisited = kpis.totalRetailers != null && visited != null ? kpis.totalRetailers - visited : null;
  addCoverageComparison("Dashboard non-visited arithmetic (total − visited)", dashboardDerivedNonVisited,
    `${kpis.totalRetailers ?? "unavailable"} − ${visited ?? "unavailable"}`, sourceA,
    dashboardDerivedNonVisited == null ? "Derived check unavailable" : "Cross-check only; reported non-visited remains a distinct source field", "number");
  addCoverageComparison("Reported non-visited count", nonVisited, "Dashboard reported non-visited field", sourceA,
    nonVisited == null ? "Dashboard non-visited unavailable" : "Distinct reported source; compare with arithmetic above", "number");
  const dashboardRetailers = kpis.totalRetailers;
  const workingRetailers = spread?.totalRetailers ?? null;
  addCoverageComparison("Population arithmetic mismatch (dashboard visited + non-visited − working total)",
    visited != null && nonVisited != null && workingRetailers != null ? visited + nonVisited - workingRetailers : null,
    `${visited ?? "unavailable"} + ${nonVisited ?? "unavailable"} − ${workingRetailers ?? "unavailable"}`,
    "Recomputed comparison",
    visited == null || nonVisited == null || workingRetailers == null ? "Mismatch unavailable until all populations load" : "Distinct populations; 5 means dashboard counts exceed working total", "number");
  addCoverageComparison("Dashboard total retailers", dashboardRetailers, "Data-tab declared total", sourceA,
    dashboardRetailers == null ? "Dashboard total unavailable" : "Distinct dashboard source", "number");
  addCoverageComparison("Working-sheet total retailers", workingRetailers, "Working-sheet parsed active rows", sourceB,
    workingRetailers == null ? "Working-sheet total unavailable" : "Distinct working-sheet source", "number");
  addCoverageComparison("Retailer total mismatch (dashboard − working-sheet)",
    dashboardRetailers != null && workingRetailers != null ? dashboardRetailers - workingRetailers : null,
    `${dashboardRetailers ?? "unavailable"} − ${workingRetailers ?? "unavailable"}`, "Recomputed comparison",
    dashboardRetailers == null || workingRetailers == null ? "Mismatch unavailable until both sources load" : "Visible source mismatch arithmetic", "number");
  finish(coverage, [54, 24, 20, 20, 20, 16, 48, 70]);

  // 5. Cost — exactly one cost-ratio KPI, with an auditable denominator.
  const cost = wb.addWorksheet("Cost");
  title(cost, "Cost basis", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"]);
  metric(cost, "Monthly CTC basis", kpis.ctcMonthly, sourceA, "Monthly CTC unavailable", "money");
  metric(cost, "Annual CTC", kpis.ctcAnnual, sourceA, "Annual CTC unavailable", "money");
  metric(cost, "Monthly T.A. basis", null, sourceA, "Monthly T.A. is not supplied; YTD T.A. is retained below", "money");
  const elapsed = costElapsed;
  metric(cost, "YTD CTC", ytdCtc, sourceA, "YTD CTC unavailable — CTC_MONTHLY × authoritative elapsed months unresolved", "money");
  metric(cost, "YTD T.A.", ytdTa, sourceA, "YTD T.A. unavailable", "money");
  metric(cost, "Total YTD cost", totalCost,
    taAvailable ? "Recomputed from YTD CTC + YTD T.A." : "Known CTC only; YTD T.A. unavailable and excluded",
    totalCost == null ? "Known CTC unavailable" : taAvailable ? "" : "Cost coverage is CTC-only; T.A. is not a resolved zero", "money");
  metric(cost, "Exact denominator (sales received)", denominator, sourceA, "Sales Received denominator unavailable or not positive", "money");
  const ratioRow = cost.addRow([`${taAvailable ? "Cost" : "Known-cost"} ratio (recomputed; the only cost-ratio KPI)`, null, totalCost, denominator, null, state(ratio), taAvailable ? "Recomputed from YTD CTC + YTD T.A." : "Recomputed from known CTC; YTD T.A. unavailable/excluded", ratio == null ? "Sales Received denominator unavailable or not positive" : taAvailable ? "" : "Cost coverage is CTC-only; T.A. is unavailable"]);
  pctCell(ratioRow.getCell(2), ratio);
  money(ratioRow.getCell(3), totalCost);
  money(ratioRow.getCell(4), denominator);
  pctCell(ratioRow.getCell(5), ratio);
  const typeRow = cost.addRow(["Denominator TYPE", "SALES_RECEIVED", null, null, null, "value", sourceA, ""]);
  typeRow.getCell(2).numFmt = "@";
  metric(cost, "Elapsed complete months", elapsed, sourceA, "Elapsed months unavailable from resolved targets/calendar payload");
  metric(cost, "OB to cost multiple", obCostMultiple, sourceA, "OB-to-cost multiple unavailable");
  metric(cost, "Sales to cost multiple", salesCostMultiple, sourceA, "Sales-to-cost multiple unavailable");
  metric(cost, "Cost per retailer", roi?.costPerRetailer ?? null, sourceB, "Cost-per-retailer unavailable", "money");
  metric(cost, "Cost per visit", roi?.costPerVisit ?? null, sourceB, "Cost-per-visit unavailable", "money");
  metric(cost, "Cost per active retailer", roi?.costPerActiveRetailer ?? null, sourceB, "Cost-per-active-retailer unavailable", "money");
  const avgSalesDay = kpis.workingDaysActual != null && kpis.workingDaysActual > 0 && totalSale != null
    ? totalSale / kpis.workingDaysActual : null;
  const avgVisitsDay = kpis.workingDaysActual != null && kpis.workingDaysActual > 0 && totalVisits != null
    ? totalVisits / kpis.workingDaysActual : null;
  const avgOrdersDay = kpis.workingDaysActual != null && kpis.workingDaysActual > 0 && totalOb != null
    ? totalOb / kpis.workingDaysActual : null;
  metric(cost, "Average sales / day", avgSalesDay, sourceA, "Sales or working days unavailable");
  metric(cost, "Visits / day", avgVisitsDay, sourceA, "Visits or working days unavailable");
  // OB value/day and order count/day are different measures.  NOOFORDERS is
  // retained only as a source-labelled operand; it is never inferred from OB.
  metric(cost, "Order booking value/working day", avgOrdersDay, sourceA, "Order booking value or working days unavailable");
  metric(cost, "Orders count/working day", ordersPerDay,
    extraNumber(kpis, "NOOFORDERS") == null
      ? "NOOFORDERS source field unavailable; no count inferred"
      : `${sourceA}; raw field NOOFORDERS`,
    "Order count or working days unavailable", "number");
  finish(cost, [54, 32, 18, 48, 58, 22, 22, 18]);

  // 6. Segment Spread
  const segments = wb.addWorksheet("Segment Spread");
  title(segments, "Segment spread", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"]);
  const sku = input.skuSpread;
  if (sku?.netBySegment?.length) {
    for (const s of sku.netBySegment) {
      const r = segments.addRow([s.segment, null, null, null, null, state(s.net), "secondary_register_line resolved page payload", ""]);
      money(r.getCell(2), s.net);
      money(r.getCell(3), s.net);
      money(r.getCell(4), sku.totalNet ?? null);
      pctCell(r.getCell(5), s.pct);
    }
  } else {
    segments.addRow(["No resolved segment rows", null, null, null, null, "unavailable", "secondary_register_line resolved page payload", sku?.liveYearNote ?? "Segment spread unavailable."]);
  }
  metric(segments, "Distinct segments", sku?.distinctSegments ?? null, "secondary_register_line resolved page payload", "Segment count unavailable");
  metric(segments, "Known segment universe", sku?.totalKnownSegments ?? null, "secondary_register_line resolved page payload", "Segment universe unavailable");
  percentage(segments, "Segment coverage", sku?.distinctSegments ?? null, sku?.totalKnownSegments ?? null, "secondary_register_line resolved page payload", "Segment counts unavailable / denominator not positive", "number");
  metric(segments, "Total NET", sku?.totalNet ?? null, "secondary_register_line resolved page payload", "Total segment NET unavailable", "money");
  metric(segments, "Cross-sell depth", sku?.crossSellDepth ?? null, "secondary_register_line resolved page payload", "Cross-sell depth unavailable");
  metric(segments, "Concentration HHI", sku?.concentrationHhi ?? null, "secondary_register_line resolved page payload", "Concentration HHI unavailable");
  segments.addRow(["Register status", sku == null ? "unavailable" : sku.isLiveYear ? "live / partial" : "resolved", null, null, null, "value", "secondary_register_line", sku?.liveYearNote ?? ""]);
  segments.addRow(["Vocabulary / join note", null, null, null, null, "value", "secondary_register_line", "Segment means brand_canon from the secondary register. No item code or six-master join was available; these are not six-master item categories."]);
  finish(segments, [38, 20, 16, 20, 20, 18, 48, 80]);

  // 7. Reconciliation
  const recon = wb.addWorksheet("Reconciliation");
  title(recon, "Reconciliation", ["Measure", "Source A", "Source B", "Difference", "Variance %", "Status", "Reason"]);
  const unresolvedReason = sourceBStatusReason;
  const rec = (label: string, a: number | null, b: number | null) => {
    const difference = a != null && b != null ? a - b : null;
    const variance = a != null && b != null && a !== 0 ? difference! / a * 100 : null;
    const status = a == null || b == null ? "unavailable"
      : Math.abs(variance ?? 0) <= 1 ? "matched (within +/-1%)" : "difference (outside +/-1%)";
    const r = recon.addRow([label, null, null, null, null, status, a == null || b == null ? unresolvedReason || "One source is unavailable." : "Page-equivalent comparison."]);
    money(r.getCell(2), a); money(r.getCell(3), b); money(r.getCell(4), difference); pctCell(r.getCell(5), variance);
  };
  const pageOrderBooking = kpis.orderBooking == null && kpis.directDealersOrder == null
    ? null : (kpis.orderBooking ?? 0) + (kpis.directDealersOrder ?? 0);
  rec("Order booking (retailer + DD)", pageOrderBooking, spread?.totalOrderBooking ?? null);
  rec("Sales received", kpis.sale, spread?.totalSale ?? null);
  rec("Retailer count", kpis.totalRetailers, spread?.totalRetailers ?? null);
  recon.addRow(["Source B status", null, null, null, null, sourceBStatus, unresolvedReason || "Resolved and mapped."]);
  finish(recon, [34, 22, 22, 22, 18, 18, 70]);

  // 8. Dormant Retailers — never truncate to the UI top 20.
  const dormant = wb.addWorksheet("Dormant Retailers");
  title(dormant, "Dormant retailers / win-back collection", ["Retailer", "Last active FY", "Last active month", "Last NET", "Source / scope", "Availability / reason"]);
  if (effectiveDormant == null) {
    dormant.addRow(["", "", "", null, "Resolved page payload", "Unavailable — dormant collection was not loaded."]);
  } else if (effectiveDormant.length === 0) {
    dormant.addRow(["", "", "", null, "Resolved full collection", "Full resolved collection contains no dormant retailers."]);
  } else {
    for (const d of effectiveDormant) dormant.addRow([d.customer, d.lastActiveFy, d.lastActiveMonth, d.lastNet, "Resolved full collection (not UI top 20)", ""]);
  }
  if (detail?.removedRows?.length) {
    dormant.addRow(["Removed Parties section", "", "", null, "Resolved member working-sheet payload", `${detail.removedRows.length} removed-party rows are available in the resolved payload.`]);
    for (const retailer of detail.removedRows) {
      dormant.addRow([
        retailer.name, retailer.lastActiveYear, "", retailer.lastYearSale ?? retailer.lastYearOb,
        "Resolved full Removed Parties collection", "Removal date is not carried by source B; last active FY/value shown.",
      ]);
    }
  }
  finish(dormant, [38, 18, 20, 20, 48, 66]);

  // 9. Profile
  const profile = wb.addWorksheet("Profile");
  title(profile, "Member profile", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"]);
  const profileText = (label: string, v: string | null, source: string) => {
    const row = profile.addRow([label, v, null, null, null, v == null ? "unavailable" : v === "" ? "zero" : "value", source, v == null ? "Not present in resolved page data." : ""]);
    if (v == null) grey(row.getCell(2));
  };
  profileText("Member", kpis.name, sourceA);
  profileText("State head", kpis.stateHead, sourceA);
  profileText("Designation", kpis.designation, sourceA);
  profileText("HQ", kpis.hq, sourceA);
  profileText("Contact", kpis.contact, sourceA);
  profileText("Status", kpis.isLeft ? "LEFT" : "ACTIVE", sourceA);
  profileText("State", extraText(kpis, "STATE"), sourceA);
  profileText("Working state", extraText(kpis, "WORKINGSTATE"), sourceA);
  profileText("Employee code", extraText(kpis, "EMPLOYEECODE", "EMPCODE", "EMP_CODE"), sourceA);
  profileText("Old / new", extraText(kpis, "OLDNEW", "OLDORNEW"), sourceA);
  profileText("Channel", extraText(kpis, "CHANNEL", "CHANNELTYPE"), sourceA);
  profileText("Target range", extraText(kpis, "TARGETRANGE", "TARGETBAND"), sourceA);
  const doj = resolvedDoj(kpis);
  const dojRow = profile.addRow(["Date of Joining", null, null, null, null, state(doj), "Resolved roster/Data-tab field", doj == null ? "Date of Joining is unavailable in the resolved page payload." : ""]);
  // ExcelJS writes a genuine Date as a date cell; assigning the raw Sheets
  // serial would leave consumers with a plain number despite the date format.
  dojRow.getCell(2).value = doj == null ? null : new Date((doj - 25569) * 86400000);
  if (doj == null) grey(dojRow.getCell(2));
  else dojRow.getCell(2).numFmt = "dd-mmm-yyyy";
  // Profile is identity only.  Raw/mapped Data-tab extras belong in Working
  // detail, where their field names, operands and provenance are visible.
  finish(profile, [36, 42, 18, 46, 66, 22, 22, 20]);

  // 10. Working detail — the audit layer. Retailer rows, visit targets,
  // source operands and reconciliation proof are kept out of Coverage.
  const working = wb.addWorksheet("Working detail");
  title(working, "Working detail and source proof", [
    "Section", "Measure / row", "Value", "Numerator", "Denominator",
    "Availability", "Source", "Reason", "Raw field name",
    "District", "City", "Distributor", "Distance km", "Annual plan", "Visits required",
    "OB", "Sales received", "Visits done", "Achievement", "Effective OB", "Effective plan",
    "Status", "Detail source", "Detail reason",
    "Visit month", "Target name", "Target district", "Target distance km",
    "Target OB", "Target visits", "Visit decision",
  ]);
  const workingMetric = (
    section: string, label: string, value: number | string | Date | null,
    source: string, reason: string, rawField = "",
    numerator: number | null = null, denominator: number | null = null,
  ) => {
    const availability = value == null ? "unavailable" : typeof value === "number" && value === 0 ? "zero" : "value";
    const r = working.addRow([section, label, value, numerator, denominator, availability, source, value == null ? reason : "", rawField]);
    if (value == null) grey(r.getCell(3));
    else if (typeof value === "number") r.getCell(3).numFmt = "#,##0.00";
    return r;
  };
  const workingMoney = (
    section: string, label: string, value: number | null, source: string, reason: string,
    rawField = "", numerator: number | null = null, denominator: number | null = null,
  ) => {
    const r = workingMetric(section, label, value, source, reason, rawField, numerator, denominator);
    money(r.getCell(3), value);
    if (numerator != null) money(r.getCell(4), numerator);
    if (denominator != null) money(r.getCell(5), denominator);
    return r;
  };
  const workingStatusRow = workingMetric("Working-sheet status", "Retailer detail availability",
    detail ? "ok" : sourceBStatus,
    sourceB,
    detail ? "Complete retailer rows and visit-plan proof loaded." : sourceBStatusReason || "Retailer detail unavailable; no completeness inferred.",
    "retailerDetail.status");
  workingStatusRow.getCell(8).value = detail
    ? "Complete retailer rows and visit-plan proof loaded."
    : sourceBStatusReason || "Retailer detail unavailable; no completeness inferred.";
  workingMoney("KPI operands", "Monthly CTC", kpis.ctcMonthly, sourceA, "Monthly CTC unavailable", "CTC_MONTHLY");
  workingMetric("KPI operands", "Authoritative elapsed months", costElapsed, sourceA,
    "Elapsed months unavailable from resolved targets/calendar payload", "ELAPSED_MONTHS");
  workingMoney("KPI operands", "YTD CTC", ytdCtc, sourceA,
    "YTD CTC unavailable — requires CTC_MONTHLY × authoritative elapsed months",
    "CTC_MONTHLY × ELAPSED_MONTHS", kpis.ctcMonthly, costElapsed);
  workingMoney("KPI operands", "YTD T.A.", ytdTa, sourceA, "YTD T.A. unavailable", "TABILLSTCOST");
  workingMoney("KPI operands", "Total YTD cost", totalCost,
    taAvailable ? "Recomputed" : "Known CTC only; T.A. unavailable/excluded",
    totalCost == null ? "Known CTC unavailable" : taAvailable ? "" : "Cost coverage is CTC-only; T.A. is not a resolved zero",
    "CTC_COST_YTD + TA_BILL_YTD", ytdCtc, ytdTa);
  workingMoney("KPI operands", "SALES_RECEIVED denominator", denominator, sourceA, "Sales received unavailable or not positive", "SALE");
  workingMetric("KPI operands", "Denominator TYPE", "SALES_RECEIVED", sourceA, "", "SALES_RECEIVED");
  workingMetric("Benchmark basis", "Cost ratio benchmark basis",
    costBenchmark?.basis ?? (taAvailable ? "fullCost" : "ctcOnly"),
    sourceA,
    "Cost benchmark basis is unavailable",
    "COST_RATIO_BASIS");
  workingMetric("Benchmark basis", "Cost benchmark reporting months", costElapsed,
    sourceA, "Reporting month count unavailable", "REPORTING_MONTH_COUNT");
  workingMetric("KPI operands", "Order booking value/working day", obPerDay, sourceA, "OB or working days unavailable", "ORDER_BOOKING / WORKING_DAYS");
  workingMetric("KPI operands", "Orders count/working day", ordersPerDay,
    extraNumber(kpis, "NOOFORDERS") == null ? "NOOFORDERS source not resolved" : sourceA,
    "NOOFORDERS or working days unavailable", "NOOFORDERS / WORKING_DAYS");
  workingMetric("KPI operands", "Dashboard total visits", totalVisits, sourceA, "Dashboard total visits unavailable", "TOTALVISITS");
  workingMetric("KPI operands", "Working-sheet visits done", spread?.totalVisits ?? null, sourceB, "Working-sheet visit values unavailable", "TOTALVISITS (working sheet)");
  workingMetric("KPI operands", "Dashboard total retailers", kpis.totalRetailers, sourceA, "Dashboard total unavailable", "TOTALRETAILERS");
  workingMetric("KPI operands", "Dashboard visited retailers", kpis.visitedRetailers, sourceA, "Dashboard visited unavailable", "VISITEDRETAILERS");
  workingMetric("KPI operands", "Dashboard non-visited retailers", kpis.nonVisitedRetailers, sourceA, "Dashboard non-visited unavailable", "NONVISITED");
  workingMetric("KPI operands", "Working-sheet total retailers", spread?.totalRetailers ?? null, sourceB, "Working-sheet total unavailable", "spread.totalRetailers");
  workingMetric("KPI operands", "Retailer total mismatch arithmetic",
    kpis.totalRetailers != null && spread?.totalRetailers != null ? kpis.totalRetailers - spread.totalRetailers : null,
    "Recomputed comparison", "Both retailer totals are required", "DASHBOARD_TOTAL_RETAILERS − WORKING_SHEET_TOTAL_RETAILERS",
    kpis.totalRetailers, spread?.totalRetailers ?? null);
  if (detail?.visitPlan) {
    const vp = detail.visitPlan;
    workingMetric("Raw visit-plan proof", "Visits done (working-sheet pattern)", vp.pattern.totalVisitsDone, sourceB, "", "pattern.totalVisitsDone");
    workingMetric("Raw visit-plan proof", "Visits required (working-sheet pattern)", vp.pattern.totalVisitsRequired, sourceB, "", "pattern.totalVisitsRequired");
    workingMetric("Raw visit-plan proof", "Pro-rated visits required", vp.pattern.proRatedRequired, sourceB, "", "pattern.proRatedRequired");
    workingMetric("Raw visit-plan proof", "Visit deficit", vp.pattern.visitDeficit, sourceB, "", "pattern.visitDeficit");
    workingMetric("Raw visit-plan proof", "Visit-plan total feasible", vp.totalFeasible, sourceB, "", "totalFeasible");
    workingMetric("Raw visit-plan proof", "Visit-plan total required", vp.totalRequired, sourceB, "", "totalRequired");
    workingMetric("Raw visit-plan proof", "Visit-plan gap", vp.gap, sourceB, "", "gap");
    workingMetric("Raw visit-plan proof", "Demonstrated visits/day", vp.capacity.demonstratedVisitsPerDay, sourceB, "", "capacity.demonstratedVisitsPerDay");
    workingMetric("Raw visit-plan proof", "Remaining required", vp.capacity.remainingRequired, sourceB, "", "capacity.remainingRequired");
    workingMetric("Raw visit-plan proof", "Feasible remaining visits", vp.capacity.feasibleRemainingVisits, sourceB, "", "capacity.feasibleRemainingVisits");
    workingMetric("Raw visit-plan proof", "Working days remaining", vp.capacity.workingDaysRemaining, sourceB, "", "capacity.workingDaysRemaining");
    workingMetric("Raw visit-plan proof", "Monthly capacity", vp.capacity.monthlyCapacity, sourceB, "", "capacity.monthlyCapacity");
    workingMetric("Raw visit-plan proof", "FY start / data window / anchor",
      `${vp.capacity.fyStartDate} / ${vp.capacity.dataWindowEndDate} / ${vp.capacity.anchorFy}`,
      sourceB, "", "capacity dates");
    workingMetric("Raw visit-plan proof", "Data cutoff working days", vp.capacity.dataCutoffWorkingDays, sourceB, "", "capacity.dataCutoffWorkingDays");
    workingMetric("Raw visit-plan proof", "Unassigned excluded", vp.unassignedExcluded, sourceB, "", "unassignedExcluded");
    for (const historical of vp.historicalFyCapacity) {
      workingMetric("Raw visit-plan proof", `${historical.fy} visits done`, historical.totalVisitsDone, sourceB, "", `historicalFyCapacity.${historical.fy}.totalVisitsDone`);
      workingMetric("Raw visit-plan proof", `${historical.fy} visits required`, historical.totalVisitsRequired, sourceB, "", `historicalFyCapacity.${historical.fy}.totalVisitsRequired`);
    }
    for (const bucket of vp.pattern.distanceBuckets) {
      workingMetric("Raw visit-plan proof", `Distance bucket ${bucket.label}`,
        `${bucket.count} retailers / ${bucket.visitsDone} visits`, sourceB,
        `avg visits ${bucket.avgVisits}; avg OB ${bucket.avgOb}; active ${bucket.activeCount}`,
        "pattern.distanceBuckets");
    }
    if (vp.pattern.visitedZeroOrderRetailers.length > 0) {
      workingMetric("Raw visit-plan proof", "Visited zero-order retailer names",
        vp.pattern.visitedZeroOrderRetailers.join("; "), sourceB, "", "pattern.visitedZeroOrderRetailers");
    }
    for (const month of vp.monthPlans) {
      workingMetric("Visit target rows", `${month.month} summary`, month.targets.length, sourceB,
        `working days ${month.workingDays}; capacity ${month.capacity}; maintenance ${month.maintenanceVisits}; development ${month.developmentVisits}`,
        "monthPlans");
      for (const target of month.targets) {
        const targetRow = workingMetric("Visit target rows", `${month.month}: ${target.name}`,
          null, sourceB, "", "monthPlans.targets");
        targetRow.getCell(25).value = month.month;
        targetRow.getCell(26).value = target.name;
        targetRow.getCell(27).value = target.district ?? null;
        targetRow.getCell(28).value = target.distanceKm ?? null;
        targetRow.getCell(29).value = target.ob;
        targetRow.getCell(30).value = target.visitsDone;
        targetRow.getCell(31).value = `${target.priority}: ${target.reason}`;
      }
    }
  } else {
    workingMetric("Raw visit-plan proof", "Visit plan", null, sourceB, sourceBStatusReason, "visitPlan");
  }
  for (const [key, value] of Object.entries(kpis.extra ?? {})) {
    const upper = key.toUpperCase();
    if (/^A\d+$/.test(upper) || /^COL\d+$/.test(upper) || upper.includes("INTERNAL")) {
      workingMetric("Raw / mapped extras", key, null, sourceA, "Omitted internal source field; retained as an audit omission.", key);
      continue;
    }
    if (upper.includes("COSTRATIO") || (upper.includes("COST") && upper.includes("RATIO"))) {
      workingMetric("Raw / mapped extras", key, null, sourceA, "Unverified source ratio; suppressed from numeric KPI rows.", key);
      continue;
    }
    const spec = mappedExtraSpec(upper);
    const n = rawExtraNumber(value);
    const r = workingMetric("Raw / mapped extras", spec?.label ?? key,
      spec?.unit === "text" ? (value == null ? null : String(value)) : n, sourceA,
      n == null && spec?.unit !== "text" ? "Mapped source value was not numeric." : "", key);
    if (spec?.unit === "money") money(r.getCell(3), n);
    if (spec?.unit === "percent" && n != null) {
      r.getCell(3).value = Math.abs(n) <= 5 ? n : n / 100;
      r.getCell(3).numFmt = "0.00%";
    }
  }
  if (detail) {
    for (const retailer of effectiveRows) {
      const r = working.addRow([
        "Retailer rows", retailer.name, null, null, null,
        retailer.orderBooking === 0 ? "zero" : "value", sourceB,
        retailer.orderBooking > 0 ? "active business" : "no order", "retailer row",
      ]);
      r.getCell(10).value = retailer.district ?? null;
      r.getCell(11).value = retailer.city ?? null;
      r.getCell(12).value = retailer.distributor ?? null;
      numberCell(r.getCell(13), retailer.distanceKm);
      money(r.getCell(14), retailer.businessPlan);
      numberCell(r.getCell(15), retailer.visitsRequired);
      money(r.getCell(16), retailer.orderBooking);
      money(r.getCell(17), retailer.sale);
      numberCell(r.getCell(18), retailer.totalVisit);
      // Member-sheet achievementPct is already percentage points (80 means
      // 80%), unlike monthly payload achievementPct, which is a 0–1 ratio.
      pctCell(r.getCell(19), retailer.achievementPct);
      money(r.getCell(20), retailer.orderBooking);
      money(r.getCell(21), retailer.businessPlan);
      r.getCell(22).value = retailer.isActive ? "active" : "inactive";
      r.getCell(23).value = sourceB;
      r.getCell(24).value = retailer.orderBooking > 0 ? "active business" : "no order";
    }
  }
  const reconWorking = (label: string, a: number | null, b: number | null) => {
    const difference = a != null && b != null ? a - b : null;
    workingMoney("Reconciliation evidence", label, difference, "Recomputed comparison",
      a == null || b == null ? sourceBStatusReason || "One source unavailable" : `${a} − ${b} = ${difference}`,
      "SOURCE_A − SOURCE_B", a, b);
  };
  reconWorking("Order booking (retailer + DD)", pageOrderBooking, spread?.totalOrderBooking ?? null);
  reconWorking("Sales received", kpis.sale, spread?.totalSale ?? null);
  reconWorking("Retailer count", kpis.totalRetailers, spread?.totalRetailers ?? null);
  finish(working, [24, 48, 28, 24, 24, 18, 48, 70, 34, 18, 18, 20, 16, 18, 18, 18, 18, 16, 16, 18, 18, 18, 42, 54, 16, 28, 24, 18, 18, 16, 34]);

  // 11. Info
  const info = wb.addWorksheet("Info");
  title(info, "Export information and omissions", ["Field", "Value"]);
  const mappedExtraOmissions = Object.entries(kpis.extra ?? {})
    .filter(([key]) => /^A\d+$/i.test(key) || /^COL\d+$/i.test(key)
      || key.toUpperCase().includes("INTERNAL")
      || key.toUpperCase().includes("COSTRATIO"))
    .map(([key]) => /^A\d+$/i.test(key) || /^COL\d+$/i.test(key) || key.toUpperCase().includes("INTERNAL")
      ? `${key}: omitted internal source field.`
      : `${key}: unverified source field; suppressed from all numeric KPI rows.`);
  const actualOmissions = [
    period?.priorSamePeriodSales == null ? "Growth: same-period prior sales unavailable." : "",
    period?.priorSamePeriodOb == null ? "Growth: same-period prior order booking unavailable." : "",
    detail == null ? "Source B: member working-sheet detail unavailable." : "",
    detail != null && !detail.visitPlan ? "Visit plan was not present in the resolved page payload." : "",
    input.monthlyRows.length === 0 ? "Monthly performance rows were not present for the selected member." : "",
    ...mappedExtraOmissions,
    input.skuSpread == null ? "Segment spread unavailable." : "",
    effectiveDormant == null ? "Dormant retailer collection unavailable." : "",
    ...(input.omissions ?? []),
  ].filter(Boolean).join("; ");
  const infoRows: [string, Scalar][] = [
    ["Member", kpis.name], ["State head", kpis.stateHead], ["FY", input.fy],
    ["Designation", kpis.designation], ["HQ", kpis.hq],
    ["Period / filters", input.periodLabel ?? "Full FY / current page selection"],
    ["Selected fiscal months", input.periodMonths?.join(", ") ?? "All resolved months"],
    ["Generated timestamp", (input.generatedAt ?? new Date()).toISOString()],
    ["Data-read timestamp", input.dataReadAt ? new Date(input.dataReadAt).toISOString() : null],
    ["Dashboard dataset source", sourceA],
    ["Dashboard dataset status / scope", "Resolved page Data-tab member KPI payload; selected member only."],
    ["Sales source", kpis.saleSource ?? "Resolved KPI source not recorded."],
    ["Member working-sheet dataset source", detail ? `${detail.tabName} / resolved page payload` : "Not loaded in resolved page payload"],
    ["Member working-sheet status / scope", detail
      ? `status=ok; resolved full member detail (${effectiveRows.length} retailer rows)`
      : `status=${sourceBStatus}; ${unresolvedReason || "no retailer scope assumed"}`],
    ["Monthly dataset source", input.monthlySource ?? "secondary_head_month resolved page payload"],
    ["Segment dataset source", "secondary_register_line (brand_canon vocabulary; resolved page payload)"],
    ["Segment coverage note", input.skuSpread?.liveYearNote ?? "No additional segment coverage note supplied."],
    ["Dormant dataset source", effectiveDormant == null ? "Not loaded" : "Resolved full win-back collection"],
    ["Filters and period basis", input.periodLabel ?? "Full FY / current page selection"],
    ["Benchmark disclosure", ((input.benchmarks ?? []).length > 0 || input.benchmark != null)
      ? [...(input.benchmarks ?? []), ...(input.benchmark ? [input.benchmark] : [])].map((b) =>
         `${b.metric}: ${b.population}; ${b.peerCount} peers; ${b.period}; basis ${b.basis ?? "unspecified"}; source ${b.source}; median ${b.median == null ? "unavailable" : b.median}`,
      ).join(" | ")
      : "No explicit resolved company or state-head peer population and period was supplied; benchmark is unavailable."],
    ["Provisional months", input.provisionalMonths ?? "No provisional-month note was supplied by the resolved page."],
    ["Order booking vs dispatch", "Order booking is committed order value; dispatch / sales received is goods dispatched/received. They are separate measures and are not substituted."],
    ["Snapshot basis", `${input.fromDbSnapshot ? "DB snapshot" : "live resolved read"}${input.stale ? "; stale snapshot served while source was busy" : ""}`],
    ["Omissions", actualOmissions || "No omissions in the resolved page payload."],
    ["Raw internal fields", "Internal source-only fields are intentionally not exported."],
    ["Unverified source ratio metadata", kpis.costRatio == null ? "Not present" : "Retained only as unverified source metadata; not a KPI."],
  ];
  infoRows.forEach(([k, v]) => info.addRow([k, v]));
  finish(info, [36, 130]);

  for (const ws of wb.worksheets) {
    ws.eachRow((r) => r.eachCell((c) => {
      if (typeof c.value === "number" && !c.numFmt) c.numFmt = "#,##0";
    }));
  }
  return wb;
}

export async function buildDeepDiveExport(input: DeepDiveExportInput): Promise<Buffer> {
  return Buffer.from(await buildDeepDiveWorkbook(input).xlsx.writeBuffer());
}

export const buildSalesDeepDiveWorkbook = buildDeepDiveWorkbook;