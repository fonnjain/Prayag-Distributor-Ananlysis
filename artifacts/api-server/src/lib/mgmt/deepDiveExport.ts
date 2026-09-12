import ExcelJS from "exceljs";
import type { MemberKpis } from "./deepDiveData.js";

/**
 * The export builder deliberately has no database or Sheets dependencies.  The
 * route supplies the already-resolved member KPIs and the rows for that one
 * member; this is important because a workbook must never accidentally turn
 * into a team export.
 */
export type DeepDiveMonthlyRow = {
  monthLabel: string;
  monthIdx: number;
  planAmount: number | null;
  orderedAmount: number | null;
  receivedAmount: number | null;
  /** Received / plan as a 0–1 ratio, ready for an Excel percentage cell. */
  achievementPct: number | null;
  notYetRecorded: boolean;
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
  skuSpreadIncluded?: boolean;
  winBackIncluded?: boolean;
};

type CellValue = string | number | null;

const SOURCE_DATA = "STATE HEAD DASHBOARD workbook — Data tab";
const SOURCE_MONTH = "secondary_head_month";
const GREY = "FFE7E7E7";
const NAVY = "FF17365D";
const BLUE = "FFD9EAF7";

function valueState(v: number | null): "value" | "zero" | "unavailable" {
  if (v == null) return "unavailable";
  return v === 0 ? "zero" : "value";
}

/**
 * Excel has no Indian crore/lakh scaling token.  Use a formula containing the
 * raw rupee amount and a cached scaled result for the two abbreviated ranges.
 * This keeps the displayed value human while retaining a numeric cached value
 * for consumers that recalculate or inspect the workbook.  Below one lakh the
 * literal rupee amount is retained so ordinary zero remains a true numeric 0.
 */
function setMoneyCell(cell: ExcelJS.Cell, raw: number | null): void {
  if (raw == null) {
    cell.value = null;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
    return;
  }
  const abs = Math.abs(raw);
  if (abs >= 10_000_000) {
    cell.value = { formula: `${raw}/10000000`, result: raw / 10_000_000 };
    cell.numFmt = '"Rs "0.00" Cr";[Red]-"Rs "0.00" Cr"';
  } else if (abs >= 100_000) {
    cell.value = { formula: `${raw}/100000`, result: raw / 100_000 };
    cell.numFmt = '"Rs "0.00" L";[Red]-"Rs "0.00" L"';
  } else {
    cell.value = raw;
    cell.numFmt = '"Rs "#,##,##0;[Red]-"Rs "#,##,##0';
  }
}

function addTitle(ws: ExcelJS.Worksheet, title: string, columns: string[]): void {
  ws.addRow([title]);
  ws.mergeCells(1, 1, 1, Math.max(1, columns.length));
  const c = ws.getCell(1, 1);
  c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  c.alignment = { vertical: "middle" };
  ws.getRow(1).height = 24;
  ws.addRow(columns);
  const header = ws.getRow(2);
  header.font = { bold: true, color: { argb: "FF1F1F1F" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
  header.alignment = { vertical: "middle", wrapText: true };
  ws.views = [{ state: "frozen", ySplit: 2 }];
}

function finish(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((width, i) => { ws.getColumn(i + 1).width = width; });
  ws.eachRow((row, rowNo) => {
    if (rowNo > 2) row.alignment = { vertical: "top", wrapText: true };
  });
  ws.autoFilter = { from: "A2", to: `${String.fromCharCode(64 + Math.min(widths.length, 26))}2` };
}

function addMeasure(
  ws: ExcelJS.Worksheet,
  label: string,
  v: number | null,
  source: string,
  reason: string,
  kind: "money" | "number" | "percent" = "number",
): void {
  const state = valueState(v);
  const row = ws.addRow([label, null, state, source, v == null ? reason : ""]);
  if (kind === "money") setMoneyCell(row.getCell(2), v);
  else {
    row.getCell(2).value = kind === "percent" && v != null ? v / 100 : v;
    if (v == null) row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
    if (kind === "percent" && v != null) row.getCell(2).numFmt = "0.00%";
  }
}

function addTarget(
  ws: ExcelJS.Worksheet,
  label: string,
  v: number | null,
  reason: string,
  kind: "money" | "number" = "number",
): void {
  const state = valueState(v);
  const row = ws.addRow([label, null, null, null, null, state, SOURCE_DATA, v == null ? reason : ""]);
  if (kind === "money") setMoneyCell(row.getCell(2), v);
  else {
    row.getCell(2).value = v;
    if (v == null) row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
  }
}

function addAchievement(
  ws: ExcelJS.Worksheet,
  label: string,
  numerator: number | null,
  denominator: number | null,
  pct: number | null,
  reason: string,
): void {
  const state = pct == null ? "unavailable" : pct === 0 ? "zero" : "value";
  const row = ws.addRow([label, null, null, null, pct == null ? null : pct / 100, state, SOURCE_DATA, pct == null ? reason : ""]);
  setMoneyCell(row.getCell(3), numerator);
  setMoneyCell(row.getCell(4), denominator);
  if (pct == null) row.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
  // Keep the percentage a genuine numeric percentage cell.
  row.getCell(5).numFmt = "0.00%";
}

export function buildDeepDiveWorkbook(input: DeepDiveExportInput): ExcelJS.Workbook {
  const { kpis } = input;
  const effectiveTotalRetailers = input.retailerRowCount ?? kpis.totalRetailers;
  const totalRetailerSource = input.retailerRowCount != null
    ? "Selected member working-sheet workbook"
    : SOURCE_DATA;
  const saleSourceText =
    kpis.saleSource === "secondary_order_booking_report"
      ? "Secondary Order Booking Report value applied because it is fresher than the Data-tab spill value"
      : kpis.saleSource === "state_head_dashboard_data_tab"
        ? "STATE HEAD DASHBOARD Data-tab value used; no SOBR value was available for this member"
        : kpis.saleSource === "unavailable" || kpis.sale == null
          ? "Sale value unavailable from both the State Head Dashboard Data tab and SOBR"
          : "Sales value preserved from a legacy Deep Dive snapshot; exact Data-tab versus SOBR provenance was not captured";
  const memberSheetSourceText =
    input.retailerDetailStatus === "ok"
      ? "Selected member working-sheet workbook loaded; retailer count uses its active rows"
      : input.retailerDetailStatus === "loading"
        ? "Selected member working-sheet workbook is still loading; Data-tab retailer count used"
        : input.retailerDetailStatus === "not-mapped"
          ? "No working-sheet mapping exists for this member; Data-tab retailer count used"
          : input.retailerDetailStatus === "error"
            ? "Selected member working-sheet workbook could not be read; Data-tab retailer count used"
            : "Selected member working-sheet workbook was not loaded; Data-tab retailer count used";
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = input.generatedAt ?? new Date();
  wb.modified = wb.created;

  const info = wb.addWorksheet("Info");
  addTitle(info, "Sales Deep Dive — export information", ["Field", "Value"]);
  const infoRows: [string, CellValue][] = [
    ["Member", kpis.name],
    ["State head", kpis.stateHead],
    ["Designation", kpis.designation],
    ["HQ", kpis.hq],
    ["Contact", kpis.contact],
    ["FY", input.fy],
    ["Period / date filter", input.periodLabel ?? "Full FY / current page selection"],
    ["Generated timestamp", (input.generatedAt ?? new Date()).toISOString()],
    ["Data-read timestamp", input.dataReadAt ? new Date(input.dataReadAt).toISOString() : null],
    ["State Head Dashboard source", input.dataSource ?? SOURCE_DATA],
    ["Sale source", saleSourceText],
    ["Selected member working-sheet source", memberSheetSourceText],
    ["Monthly source", input.monthlySource ?? SOURCE_MONTH],
    ["SKU / win-back source", (input.skuSpreadIncluded || input.winBackIncluded) ? "DB/history sources (available to page payload; not included as workbook sheets)" : "DB/history sources — not included in this workbook"],
    ["Snapshot basis", `${input.fromDbSnapshot ? "DB snapshot" : "live read"}${input.stale ? "; stale snapshot served while source was busy" : ""}`],
    ["Provisional months", input.provisionalMonths ?? "No primary-register months are currently provisional."],
    ["Order booking vs dispatch", "Order booking is the order committed; dispatch / sales received is goods dispatched/received. They are separate measures and are not substituted for one another."],
  ];
  infoRows.forEach(([label, v]) => info.addRow([label, v]));
  finish(info, [30, 120]);

  const summary = wb.addWorksheet("Summary");
  addTitle(summary, "Headline KPIs", ["Measure", "Value", "Availability", "Source", "Reason"]);
  addMeasure(summary, "Primary target (to date)", kpis.primaryTarget, SOURCE_DATA, "No primary target in Data tab", "money");
  addMeasure(summary, "Secondary target (to date)", kpis.secondaryTarget, SOURCE_DATA, "No secondary target in Data tab", "money");
  addMeasure(summary, "Total target (to date)", kpis.totalTargetToDate, SOURCE_DATA, "No total target in Data tab", "money");
  addMeasure(summary, "Order booking — retailer / party", kpis.orderBooking, SOURCE_DATA, "No retailer/party order booking in Data tab", "money");
  addMeasure(summary, "Direct dealer order booking", kpis.directDealersOrder, SOURCE_DATA, "No direct-dealer order booking in Data tab", "money");
  addMeasure(summary, "New-party order booking", kpis.newPartyOrderBooking, SOURCE_DATA, "No new-party order booking in Data tab", "money");
  addMeasure(summary, "Sales received", kpis.sale, SOURCE_DATA, "No sales received in Data tab", "money");
  addMeasure(summary, "Secondary OB achievement", kpis.achievementSecondary, SOURCE_DATA, "Secondary OB or secondary target unavailable", "percent");
  addMeasure(summary, "DD OB achievement", kpis.achievementDirectDealer, SOURCE_DATA, "DD OB or primary target unavailable", "percent");
  addMeasure(summary, "Total OB achievement", kpis.achievementTotal, SOURCE_DATA, "Total OB channels or total target unavailable", "percent");
  addMeasure(summary, "Sales achievement", kpis.achievementSale, SOURCE_DATA, "Sales received or total target unavailable", "percent");
  addMeasure(summary, "Total visits YTD", kpis.totalVisitsYtd, SOURCE_DATA, "Data tab total-visits field unavailable", "number");
  addMeasure(summary, "Working days actual", kpis.workingDaysActual, SOURCE_DATA, "Data tab working-days field unavailable", "number");
  finish(summary, [38, 22, 18, 42, 62]);

  const targets = wb.addWorksheet("Targets and achievement");
  addTitle(targets, "Targets and achievement", ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Availability / reason"]);
  addTarget(targets, "Primary target (to date)", kpis.primaryTarget, "No primary target in Data tab", "money");
  addTarget(targets, "Secondary target (to date)", kpis.secondaryTarget, "No secondary target in Data tab", "money");
  addTarget(targets, "Monthly total target", kpis.monthlyTarget, "No monthly target in Data tab", "money");
  addTarget(targets, "Primary monthly target", kpis.primaryTargetMonthly, "No primary monthly target in Data tab", "money");
  addTarget(targets, "Secondary monthly target", kpis.secondaryTargetMonthly, "No secondary monthly target in Data tab", "money");
  addTarget(targets, "Total target (to date)", kpis.totalTargetToDate, "No total target in Data tab", "money");
  addTarget(targets, "Elapsed months", kpis.elapsedMonths, "Elapsed months unavailable");
  addTarget(targets, "Order booking — retailer / party", kpis.orderBooking, "No retailer/party order booking", "money");
  addTarget(targets, "Direct dealer order booking", kpis.directDealersOrder, "No direct-dealer order booking", "money");
  addTarget(targets, "Sales received", kpis.sale, "No sales received", "money");
  addAchievement(targets, "Secondary OB achievement", kpis.orderBooking, kpis.secondaryTarget, kpis.achievementSecondary, "Secondary OB or secondary target unavailable");
  addAchievement(targets, "DD OB achievement", kpis.directDealersOrder, kpis.primaryTarget, kpis.achievementDirectDealer, "DD OB or primary target unavailable");
  const totalNumerator = kpis.orderBooking == null && kpis.newPartyOrderBooking == null && kpis.directDealersOrder == null
    ? null : (kpis.orderBooking ?? 0) + (kpis.newPartyOrderBooking ?? 0) + (kpis.directDealersOrder ?? 0);
  addAchievement(targets, "Total OB achievement", totalNumerator, kpis.totalTargetToDate, kpis.achievementTotal, "Total OB channels or total target unavailable");
  addAchievement(targets, "Sales achievement", kpis.sale, kpis.totalTargetToDate, kpis.achievementSale, "Sales received or total target unavailable");
  finish(targets, [36, 18, 18, 18, 16, 18, 42, 62]);

  const coverage = wb.addWorksheet("Coverage and visits");
  addTitle(coverage, "Coverage and visits", ["Measure", "Value", "Availability", "Source", "Reason"]);
  addMeasure(coverage, "Total old retailers", kpis.totalOldRetailers, SOURCE_DATA, "Total old retailers unavailable");
  addMeasure(coverage, "Visited retailers", kpis.visitedRetailers, SOURCE_DATA, "Visited retailers unavailable");
  addMeasure(coverage, "Non-visited retailers", kpis.nonVisitedRetailers, SOURCE_DATA, "Non-visited retailers unavailable");
  addMeasure(coverage, "Total retailers", effectiveTotalRetailers, totalRetailerSource, "Total retailers unavailable");
  addMeasure(coverage, "Direct dealers count", kpis.directDealersCount, SOURCE_DATA, "Direct-dealer count unavailable");
  addMeasure(coverage, "New-party order booking", kpis.newPartyOrderBooking, SOURCE_DATA, "New-party order booking unavailable", "money");
  addMeasure(coverage, "Total visits YTD", kpis.totalVisitsYtd, SOURCE_DATA, "Total visits YTD unavailable");
  addMeasure(coverage, "Working days actual", kpis.workingDaysActual, SOURCE_DATA, "Working days actual unavailable");
  addMeasure(coverage, "Business per retailer", kpis.businessPerRetailer, SOURCE_DATA, "Business per retailer unavailable", "money");
  finish(coverage, [34, 22, 18, 42, 62]);

  const cost = wb.addWorksheet("Cost");
  addTitle(cost, "Cost", ["Measure", "Value", "Availability", "Source", "Reason"]);
  addMeasure(cost, "CTC monthly", kpis.ctcMonthly, SOURCE_DATA, "CTC monthly unavailable", "money");
  addMeasure(cost, "CTC annual", kpis.ctcAnnual, SOURCE_DATA, "CTC annual unavailable", "money");
  addMeasure(cost, "TA + station cost", kpis.taBillStCost, SOURCE_DATA, "TA + station cost unavailable", "money");
  addMeasure(cost, "Cost ratio", kpis.costRatio, SOURCE_DATA, "Cost ratio unavailable", "percent");
  finish(cost, [30, 22, 18, 42, 62]);

  const rows = input.periodMonths !== undefined
    ? input.monthlyRows.filter((r) => input.periodMonths!.includes(r.monthIdx + 1))
    : input.monthlyRows;
  if (input.monthlyRows.length > 0) {
    const monthly = wb.addWorksheet("Monthly");
    addTitle(monthly, "Monthly secondary performance", ["Month", "Plan", "Ordered", "Received", "Achievement", "Availability / reason"]);
    for (const r of rows) {
      const reason = r.notYetRecorded
        ? "not_yet_recorded — unavailable cells are blank; recorded values are preserved"
        : r.achievementPct == null
          ? "achievement unavailable — plan or received value is unavailable"
          : "";
      const row = monthly.addRow([r.monthLabel, null, null, null, r.achievementPct, reason]);
      setMoneyCell(row.getCell(2), r.planAmount);
      setMoneyCell(row.getCell(3), r.orderedAmount);
      setMoneyCell(row.getCell(4), r.receivedAmount);
      if (r.achievementPct == null) row.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
      row.getCell(5).numFmt = "0.00%";
    }
    if (rows.length === 0 && input.periodMonths !== undefined) {
      const noRows = monthly.addRow(["No rows in selected period", null, null, null, null, "The selected period contains no rows; FY monthly rows exist for this member."]);
      noRows.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
    }
    finish(monthly, [18, 18, 18, 18, 16, 48]);
  }

  const missing = wb.addWorksheet("Missing Data");
  addTitle(missing, "Missing and unavailable data", ["Field", "Exact reason", "Source needed"]);
  const missingRows: [string, string, string][] = [];
  const fields: [string, number | null, string][] = [
    ["Primary target", kpis.primaryTarget, SOURCE_DATA],
    ["Secondary target", kpis.secondaryTarget, SOURCE_DATA],
    ["Monthly total target", kpis.monthlyTarget, SOURCE_DATA],
    ["Primary monthly target", kpis.primaryTargetMonthly, SOURCE_DATA],
    ["Secondary monthly target", kpis.secondaryTargetMonthly, SOURCE_DATA],
    ["Total target", kpis.totalTargetToDate, SOURCE_DATA],
    ["Elapsed months", kpis.elapsedMonths, SOURCE_DATA],
    ["Order booking", kpis.orderBooking, SOURCE_DATA],
    ["Direct dealer order booking", kpis.directDealersOrder, SOURCE_DATA],
    ["New-party order booking", kpis.newPartyOrderBooking, SOURCE_DATA],
    ["Sales received", kpis.sale, SOURCE_DATA],
    ["Total old retailers", kpis.totalOldRetailers, SOURCE_DATA],
    ["Visited retailers", kpis.visitedRetailers, SOURCE_DATA],
    ["Non-visited retailers", kpis.nonVisitedRetailers, SOURCE_DATA],
    ["Total retailers", effectiveTotalRetailers, totalRetailerSource],
    ["Direct dealers count", kpis.directDealersCount, SOURCE_DATA],
    ["Total visits YTD", kpis.totalVisitsYtd, SOURCE_DATA],
    ["Working days actual", kpis.workingDaysActual, SOURCE_DATA],
    ["CTC monthly", kpis.ctcMonthly, SOURCE_DATA],
    ["CTC annual", kpis.ctcAnnual, SOURCE_DATA],
    ["TA + station cost", kpis.taBillStCost, SOURCE_DATA],
    ["Cost ratio", kpis.costRatio, SOURCE_DATA],
  ];
  fields.forEach(([label, v, source]) => { if (v == null) missingRows.push([label, `No value was available in ${source}.`, source]); });
  const achievementFields: [string, number | null, string][] = [
    ["Secondary OB achievement", kpis.achievementSecondary, "Secondary OB or secondary target is unavailable or the denominator is not positive."],
    ["DD OB achievement", kpis.achievementDirectDealer, "DD OB or primary target is unavailable or the denominator is not positive."],
    ["Total OB achievement", kpis.achievementTotal, "Total OB channels or total target is unavailable or the denominator is not positive."],
    ["Sales achievement", kpis.achievementSale, "Sales received or total target is unavailable or the denominator is not positive."],
  ];
  achievementFields.forEach(([label, v, reason]) => {
    if (v == null) missingRows.push([label, reason, SOURCE_DATA]);
  });
  if (input.monthlyRows.length === 0) {
    missingRows.push(["Monthly breakdown", "No monthly rows in secondary_head_month for this member. Monthly breakdown unavailable.", SOURCE_MONTH]);
  }
  if (missingRows.length === 0) missingRows.push(["None", "No unavailable fields in the selected member export.", ""]);
  missingRows.forEach((r) => missing.addRow(r));
  finish(missing, [30, 100, 40]);

  // Apply a consistent Indian display format to numeric cells while retaining
  // numeric values. The explicit row formats above cover percentages and money;
  // this protects future additions without changing the underlying values.
  for (const ws of wb.worksheets) {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "number" && !cell.numFmt) cell.numFmt = "#,##0";
      });
    });
  }
  return wb;
}

export async function buildDeepDiveExport(input: DeepDiveExportInput): Promise<Buffer> {
  const workbook = buildDeepDiveWorkbook(input);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Descriptive alias for callers/tests that use the route's terminology.
export const buildSalesDeepDiveWorkbook = buildDeepDiveWorkbook;