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
  const costElapsed = roi?.elapsedCompleteMonths ?? kpis.elapsedMonths;
  const ytdCtc = roi?.ctcCostYtd ?? (kpis.ctcMonthly != null && costElapsed != null ? kpis.ctcMonthly * costElapsed : null);
  const ytdTa = roi?.taBillYtd ?? kpis.taBillStCost;
  const totalCost = ytdCtc != null && ytdTa != null ? ytdCtc + ytdTa : null;
  // Prompt 81 cost KPI: denominator is resolved Sales Received, never OB.
  const denominator = kpis.sale;
  const ratio = totalCost != null && denominator != null && denominator > 0 ? totalCost / denominator * 100 : null;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = input.generatedAt ?? new Date();
  wb.modified = wb.created;

  // 1. Summary for Decision. Each block is deliberately multi-row so the
  // decision is auditable rather than a one-number verdict.
  const summary = wb.addWorksheet("Summary for Decision");
  title(summary, "Sales Deep Dive — decisions", [
    "Decision block", "Question / figure", "Figure", "Comparison / basis",
    "Numerator", "Denominator", "Percentage", "Verdict", "Source", "Reason",
  ]);
  const block = (name: string) => summary.addRow([name, "", "", "", "", "", "", "", "", ""]);
  const period = input.periodAnalysis ?? buildDeepDivePeriodAnalysis(
    detail?.months,
    input.periodMonths,
    input.monthlyRows,
  );
  const priorTotal = kpis.lastYearQ1 != null || kpis.lastYearQ2 != null || kpis.lastYearQ3 != null || kpis.lastYearQ4 != null
    ? (kpis.lastYearQ1 ?? 0) + (kpis.lastYearQ2 ?? 0) + (kpis.lastYearQ3 ?? 0) + (kpis.lastYearQ4 ?? 0) : null;
  const addRatioDecision = (
    blockName: string, question: string, numerator: number | null, denominator: number | null,
    comparison: string, verdict: string, source: string, reason = "", kind: "money" | "number" = "money",
  ) => {
    const pct = numerator != null && denominator != null && denominator > 0
      ? numerator / denominator * 100 : null;
    addDecision(summary, question, numerator, comparison, verdict, source, numerator, denominator, pct, reason, kind);
    summary.getCell(summary.rowCount, 1).value = blockName;
  };
  const addBlockDecision = (
    blockName: string,
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
  ) => {
    addDecision(summary, question, value, comparison, verdict, source, numerator, denominator, pct, reason, kind);
    summary.getCell(summary.rowCount, 1).value = blockName;
  };
  block("Target attainment");
  addRatioDecision("Target attainment", "Total target vs sale", totalSale, totalTarget,
    `${totalSale ?? "—"} sales / ${totalTarget ?? "—"} total target`,
    totalSale == null || totalTarget == null ? "Unavailable" : totalSale >= totalTarget ? "On track" : "Below target",
    sourceA, totalSale == null || totalTarget == null ? "Sales or target unavailable." : "");
  addRatioDecision("Target attainment", "Secondary OB vs secondary target", kpis.orderBooking, kpis.secondaryTarget,
    `${kpis.orderBooking ?? "—"} secondary OB / ${kpis.secondaryTarget ?? "—"} secondary target`,
    kpis.orderBooking == null || kpis.secondaryTarget == null ? "Unavailable" : kpis.orderBooking >= kpis.secondaryTarget ? "On track" : "Below target",
    sourceA, kpis.orderBooking == null || kpis.secondaryTarget == null ? "Secondary OB or target unavailable." : "");
  addRatioDecision("Target attainment", "Direct dealer OB vs primary target", kpis.directDealersOrder, kpis.primaryTarget,
    `${kpis.directDealersOrder ?? "—"} DD OB / ${kpis.primaryTarget ?? "—"} primary target`,
    kpis.directDealersOrder == null || kpis.primaryTarget == null ? "Unavailable" : kpis.directDealersOrder >= kpis.primaryTarget ? "On track" : "Below target",
    sourceA, kpis.directDealersOrder == null || kpis.primaryTarget == null ? "DD OB or primary target unavailable." : "");

  block("Growth");
  addRatioDecision("Growth", "Current YTD sales vs same-period prior sales",
    kpis.sale, period?.priorSamePeriodSales ?? null,
    `${period?.currentPeriodLabel ?? "current YTD"} vs ${period?.priorPeriodLabel ?? "same period prior FY"}`,
    kpis.sale == null || period.priorSamePeriodSales == null ? "Unavailable" :
      kpis.sale >= period.priorSamePeriodSales ? "Growing" : "Declining",
    sourceA, period?.priorSamePeriodSales == null ? "Same-period prior sales was not present in the resolved page payload." : "");
  addRatioDecision("Growth", "Current YTD OB vs same-period prior OB",
    totalOb, period?.priorSamePeriodOb ?? null,
    `${period?.currentPeriodLabel ?? "current YTD"} vs ${period?.priorPeriodLabel ?? "same period prior FY"}`,
    totalOb == null || period.priorSamePeriodOb == null ? "Unavailable" :
      totalOb >= period.priorSamePeriodOb ? "Growing" : "Declining",
    sourceA, period?.priorSamePeriodOb == null ? "Same-period prior OB was not present in the resolved page payload." : "");
  for (const [label, value] of [["Prior FY Q1", kpis.lastYearQ1], ["Prior FY Q2", kpis.lastYearQ2], ["Prior FY Q3", kpis.lastYearQ3], ["Prior FY Q4", kpis.lastYearQ4]] as [string, number | null][]) {
    addRatioDecision("Growth", `${label} shape`, value, priorTotal, "Prior quarter / prior FY quarter total",
      value == null || priorTotal == null ? "Unavailable" : "Shape available", sourceA,
      value == null || priorTotal == null ? "Prior quarterly shape was not present." : "");
  }

  const totalRetailers = spread?.totalRetailers ?? kpis.totalRetailers;
  const visited = kpis.visitedRetailers;
  const nonVisited = kpis.nonVisitedRetailers;
  const partiesGivingBusiness = detail ? effectiveRows.filter((r) => r.orderBooking > 0).length : null;
  const newRetailers = extraNumber(kpis, "NEWRETAILERS", "NEWPARTIES", "NEWRETAILERCOUNT");
  block("Coverage");
  addBlockDecision("Coverage", "Total retailers", totalRetailers, totalRetailers == null ? "Unavailable" : "Working-sheet / dashboard total",
    "Figure available", sourceB, totalRetailers, null, null, totalRetailers == null ? "Retailer total unavailable." : "", "number");
  addRatioDecision("Coverage", "Visited retailer coverage", visited, totalRetailers, `${visited ?? "—"} visited / ${totalRetailers ?? "—"} total`,
    visited == null || totalRetailers == null ? "Unavailable" : "Coverage", sourceA, "", "number");
  addRatioDecision("Coverage", "Non-visited retailer share", nonVisited, totalRetailers, `${nonVisited ?? "—"} non-visited / ${totalRetailers ?? "—"} total`,
    nonVisited == null || totalRetailers == null ? "Unavailable" : "Risk to follow up", sourceA, "", "number");
  addBlockDecision("Coverage", "Parties giving business", partiesGivingBusiness, detail ? "Retailer rows with order booking > 0" : "Working-sheet rows unavailable",
    partiesGivingBusiness == null ? "Unavailable" : "Figure available", sourceB, partiesGivingBusiness, null, null,
    partiesGivingBusiness == null ? "Retailer detail is not loaded." : "", "number");
  addBlockDecision("Coverage", "Business per retailer", spread?.businessPerActiveRetailer ?? kpis.businessPerRetailer,
    "Resolved page spread metric", "Figure available", sourceB);
  addBlockDecision("Coverage", "New retailers count", newRetailers,
    "Mapped resolved KPI", newRetailers == null ? "Unavailable" : "Figure available", sourceA, newRetailers, null, null,
    newRetailers == null ? "New-retailer count was not present in the resolved page payload." : "", "number");
  addBlockDecision("Coverage", "New-party order value", kpis.newPartyOrderBooking, "Resolved Data-tab new-party order booking",
    "Figure available", sourceA, kpis.newPartyOrderBooking);

  block("Cost effectiveness");
  addRatioDecision("Cost effectiveness", "YTD cost vs Sales Received", totalCost, denominator,
    `${totalCost ?? "—"} YTD cost from CTC + T.A. / ${denominator ?? "—"} Sales Received`,
    ratio == null ? "Unavailable" : ratio <= 10 ? "Efficient" : "Review cost efficiency",
    "Recomputed from resolved page ROI",
    ratio == null ? "Sales Received denominator unavailable or not positive." : "", "money");
  addBlockDecision("Cost effectiveness", "Average sales per working day",
    kpis.workingDaysActual != null && kpis.workingDaysActual > 0 && totalSale != null ? totalSale / kpis.workingDaysActual : null,
    "Sales / actual working days", "Figure available", sourceA);
  addBlockDecision("Cost effectiveness", "Visits per working day",
    kpis.workingDaysActual != null && kpis.workingDaysActual > 0 && totalVisits != null ? totalVisits / kpis.workingDaysActual : null,
    "Visits YTD / actual working days", "Figure available", sourceA, null, null, null, "", "number");
  addBlockDecision("Cost effectiveness", "Order booking value per working day",
    kpis.workingDaysActual != null && kpis.workingDaysActual > 0 && totalOb != null ? totalOb / kpis.workingDaysActual : null,
    "Order booking / actual working days", "Figure available", sourceA, null, null, null, "", "number");

  block("Risk");
  addBlockDecision("Risk", "Concentration HHI", input.skuSpread?.concentrationHhi ?? spread?.concentrationIndex ?? null,
    "Resolved segment/retailer concentration index", "Review if concentration is high", sourceB, null, null, null, "", "number");
  addRatioDecision("Risk", "Segment coverage", input.skuSpread?.distinctSegments ?? null, input.skuSpread?.totalKnownSegments ?? null,
    `${input.skuSpread?.distinctSegments ?? "—"} known / ${input.skuSpread?.totalKnownSegments ?? "—"} universe`,
    input.skuSpread == null ? "Unavailable" : "Coverage signal", "secondary_register_line resolved page payload", "", "number");
  addBlockDecision("Risk", "Dormant retailer count", effectiveDormant == null ? null : effectiveDormant.length,
    "Full resolved win-back collection", "Review win-back list", sourceB, null, null, null, "", "number");
  addBlockDecision("Risk", "Dormant retailer value", effectiveDormant == null ? null : effectiveDormant.reduce((sum, item) => sum + item.lastNet, 0),
    "Sum of last NET for full dormant collection", "Review win-back value", sourceB);
  finish(summary, [22, 48, 22, 40, 20, 20, 16, 26, 48, 58]);

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
  metric(coverage, "Total retailers", spread?.totalRetailers ?? kpis.totalRetailers, detail ? sourceB : sourceA, "Retailer detail unavailable");
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
  if (detail?.visitPlan) {
    metric(coverage, "Visits done (working-sheet pattern)", detail.visitPlan.pattern.totalVisitsDone, sourceB, "Visit pattern unavailable");
    metric(coverage, "Visits required (working-sheet pattern)", detail.visitPlan.pattern.totalVisitsRequired, sourceB, "Visit pattern unavailable");
    metric(coverage, "Pro-rated visits required", detail.visitPlan.pattern.proRatedRequired, sourceB, "Visit pattern unavailable");
    metric(coverage, "Visit deficit", detail.visitPlan.pattern.visitDeficit, sourceB, "Visit pattern unavailable");
    metric(coverage, "Visited retailers with zero order", detail.visitPlan.pattern.visitedZeroOrderCount, sourceB, "Visit pattern unavailable");
    metric(coverage, "Visit-plan total feasible", detail.visitPlan.totalFeasible, sourceB, "Visit-plan field unavailable");
    metric(coverage, "Visit-plan total required", detail.visitPlan.totalRequired, sourceB, "Visit-plan field unavailable");
    metric(coverage, "Visit-plan gap", detail.visitPlan.gap, sourceB, "Visit-plan field unavailable");
    metric(coverage, "Visit-plan demonstrated visits/day", detail.visitPlan.capacity.demonstratedVisitsPerDay, sourceB, "Capacity field unavailable");
    metric(coverage, "Visit-plan remaining required", detail.visitPlan.capacity.remainingRequired, sourceB, "Capacity field unavailable");
    metric(coverage, "Visit-plan feasible remaining visits", detail.visitPlan.capacity.feasibleRemainingVisits, sourceB, "Capacity field unavailable");
    metric(coverage, "Visit-plan working days remaining", detail.visitPlan.capacity.workingDaysRemaining, sourceB, "Capacity field unavailable");
    metric(coverage, "Visit-plan monthly capacity", detail.visitPlan.capacity.monthlyCapacity, sourceB, "Capacity field unavailable");
    coverage.addRow(["Visit plan FY start", detail.visitPlan.capacity.fyStartDate, "value", sourceB, ""]);
    coverage.addRow(["Visit plan data window end", detail.visitPlan.capacity.dataWindowEndDate, "value", sourceB, ""]);
    coverage.addRow(["Visit plan anchor FY", detail.visitPlan.capacity.anchorFy, "value", sourceB, ""]);
    coverage.addRow(["Visit plan annual capacity anchor", detail.visitPlan.capacity.annualCapacityAnchor, "value", sourceB, ""]);
    if (detail.visitPlan.pattern.visitedZeroOrderRetailers.length > 0) {
      coverage.addRow(["Visited zero-order retailer names", detail.visitPlan.pattern.visitedZeroOrderRetailers.join("; "), "value", sourceB, ""]);
    }
    for (const historical of detail.visitPlan.historicalFyCapacity) {
      metric(coverage, `Historical ${historical.fy} visits done`, historical.totalVisitsDone, sourceB, "Historical capacity unavailable");
      metric(coverage, `Historical ${historical.fy} visits required`, historical.totalVisitsRequired, sourceB, "Historical capacity unavailable");
      percentage(coverage, `Historical ${historical.fy} coverage`, historical.totalVisitsDone, historical.totalVisitsRequired, sourceB, "Historical visit denominator unavailable", "number");
    }
    if (detail.visitPlan.pattern.distanceBuckets.length > 0) {
      coverage.addRow(["Distance bucket", "Retailers", "Visits done", "Average visits", "Average OB", "Active retailers", sourceB, ""]);
      for (const bucket of detail.visitPlan.pattern.distanceBuckets) {
        coverage.addRow([
          bucket.label, bucket.count, bucket.visitsDone, bucket.avgVisits, bucket.avgOb,
          bucket.activeCount, sourceB, "",
        ]);
      }
    }
    if (detail.visitPlan.monthPlans.length > 0) {
      coverage.addRow(["Visit month plan", "Working days", "Capacity", "Maintenance visits", "Development visits", "Targets", sourceB, ""]);
      for (const month of detail.visitPlan.monthPlans) {
        coverage.addRow([
          month.month, month.workingDays, month.capacity, month.maintenanceVisits,
          month.developmentVisits, month.targets.length, sourceB, "",
        ]);
        for (const target of month.targets) {
          coverage.addRow([
            `Visit target (${month.month})`, target.name, target.district, target.distanceKm,
            target.ob, target.visitsDone, sourceB, `${target.priority}: ${target.reason}`,
          ]);
        }
      }
    }
  }
  if (detail) {
    coverage.addRow([
      "Retailer detail rows", "Retailer", "District", "City", "Distributor", "Distance km",
      "Business plan", "Visits required", "Order booking", "Sales received", "Visits",
      "Achievement %", "Achievement numerator", "Achievement denominator", "Status", sourceB, "",
    ]);
    for (const retailer of effectiveRows) {
      const r = coverage.addRow([
        "Retailer", retailer.name, retailer.district, retailer.city, retailer.distributor, retailer.distanceKm,
        retailer.businessPlan, retailer.visitsRequired, retailer.orderBooking, retailer.sale, retailer.totalVisit,
        null, retailer.orderBooking, retailer.businessPlan, retailer.orderBooking > 0 ? "active business" : "no order",
        sourceB, "",
      ]);
      numberCell(r.getCell(6), retailer.distanceKm);
      money(r.getCell(7), retailer.businessPlan);
      numberCell(r.getCell(8), retailer.visitsRequired);
      money(r.getCell(9), retailer.orderBooking);
      money(r.getCell(10), retailer.sale);
      numberCell(r.getCell(11), retailer.totalVisit);
      pctCell(r.getCell(12), retailer.achievementPct);
      money(r.getCell(13), retailer.orderBooking);
      money(r.getCell(14), retailer.businessPlan);
    }
  }
  finish(coverage, [42, 24, 20, 20, 20, 16, 18, 18, 20, 20, 14, 16, 20, 20, 20, 48, 58]);

  // 5. Cost — exactly one cost-ratio KPI, with an auditable denominator.
  const cost = wb.addWorksheet("Cost");
  title(cost, "Cost basis", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"]);
  metric(cost, "Monthly CTC basis", kpis.ctcMonthly, sourceA, "Monthly CTC unavailable", "money");
  metric(cost, "Annual CTC", kpis.ctcAnnual, sourceA, "Annual CTC unavailable", "money");
  metric(cost, "Monthly T.A. basis", null, sourceA, "Monthly T.A. is not supplied; YTD T.A. is retained below", "money");
  const elapsed = costElapsed;
  metric(cost, "YTD CTC", ytdCtc, sourceB, "YTD CTC unavailable", "money");
  metric(cost, "YTD T.A.", ytdTa, sourceA, "YTD T.A. unavailable", "money");
  metric(cost, "Total YTD cost", totalCost, "Recomputed from YTD CTC + YTD T.A.", "Total cost unavailable", "money");
  metric(cost, "Exact denominator (sales received)", denominator, sourceA, "Sales Received denominator unavailable or not positive", "money");
  const ratioRow = cost.addRow(["Cost ratio (recomputed; the only cost-ratio KPI)", null, totalCost, denominator, null, state(ratio), "Recomputed from YTD CTC + YTD T.A.", ratio == null ? "Sales Received denominator unavailable or not positive" : ""]);
  pctCell(ratioRow.getCell(2), ratio);
  money(ratioRow.getCell(3), totalCost);
  money(ratioRow.getCell(4), denominator);
  pctCell(ratioRow.getCell(5), ratio);
  const typeRow = cost.addRow(["Denominator TYPE", "SALES_RECEIVED", null, null, null, "value", sourceA, ""]);
  typeRow.getCell(2).numFmt = "@";
  metric(cost, "Elapsed complete months", elapsed, sourceB, "Elapsed months unavailable");
  metric(cost, "OB to cost multiple", roi?.obToCostMultiple ?? null, sourceB, "OB-to-cost multiple unavailable");
  metric(cost, "Sales to cost multiple", roi?.saleToCostMultiple ?? null, sourceB, "Sales-to-cost multiple unavailable");
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
  metric(cost, "Orders / day", avgOrdersDay, sourceA, "Orders or working days unavailable");
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
  for (const [key, value] of Object.entries(kpis.extra ?? {})) {
    const label = friendlyExtraLabel(key.toUpperCase());
    if (!label || ["State", "Working state", "Employee code", "Old / new", "Channel", "Target range", "Status"].includes(label)) continue;
    const text = value == null ? null : String(value);
    profileText(label, text, sourceA);
  }
  const mappedExtraOmissions = addMappedExtraRows(profile, kpis, sourceA);
  const doj = resolvedDoj(kpis);
  const dojRow = profile.addRow(["Date of Joining", null, null, null, null, state(doj), "Resolved roster/Data-tab field", doj == null ? "Date of Joining is unavailable in the resolved page payload." : ""]);
  dojRow.getCell(2).value = doj;
  if (doj == null) grey(dojRow.getCell(2));
  else dojRow.getCell(2).numFmt = "dd-mmm-yyyy";
  profileText("FY", input.fy, "Export filter");
  finish(profile, [36, 42, 18, 46, 66, 22, 22, 20]);

  // 10. Info
  const info = wb.addWorksheet("Info");
  title(info, "Export information and omissions", ["Field", "Value"]);
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