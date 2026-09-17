import ExcelJS from "exceljs";
import type {
  DistributorDeepDiveResult,
  DistributorGroup,
} from "./distributorDeepDive.js";
import {
  CANONICAL_MASTER_CATEGORIES,
  type DistributorSkuSpread,
} from "./distributorSkuSpread.js";

const MONEY = '"₹"#,##,##0;[Red]-"₹"#,##,##0';
const NUMBER = "#,##,##0.00";
const INTEGER = "#,##,##0";
const PERCENT = "0.00%";
const HEADER = "FFE8EDF5";
const SUBHEADER = "FFDCE6F1";
const UNAVAILABLE = "FFE7E7E7";

export type DistributorDeepDiveWorkbookInput = {
  result: DistributorDeepDiveResult;
  directoryCount?: number;
  identityCount?: number;
  stateHead?: string;
  geoLabel?: string;
  distributorFilter?: string;
  periodLabel?: string;
  months?: string[];
  sources?: string[];
  provisionalMonths?: string | null;
  activeHolds?: string[];
  secondaryCoverage?: string | null;
  directoryMemberCount?: number;
  directoryStateCount?: number;
  directoryHeadCount?: number;
  selectedStates?: string[];
  generatedAt?: Date;
};

type ExportRetailer = {
  name: string;
  district?: string | null;
  city?: string | null;
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

function availability(value: unknown): "value" | "zero" | "unavailable" {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "unavailable";
  if (typeof value === "number" && value === 0) return "zero";
  return "value";
}

function addTitle(ws: ExcelJS.Worksheet, title: string, subtitle?: string): void {
  ws.addRow([title]);
  ws.getRow(1).font = { bold: true, size: 14, color: { argb: "FF17365D" } };
  if (subtitle) {
    ws.addRow([subtitle]);
    ws.getRow(2).font = { italic: true, color: { argb: "FF5B6573" } };
  }
}

function addHeader(ws: ExcelJS.Worksheet, headers: string[], row = ws.rowCount + 1): void {
  const r = ws.getRow(row);
  r.values = headers;
  r.font = { bold: true, color: { argb: "FF17365D" } };
  r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER } };
  r.alignment = { vertical: "middle", wrapText: true };
  r.eachCell((c) => { c.border = { bottom: { style: "thin", color: { argb: "FF9EADBD" } } }; });
  ws.views = [{ state: "frozen", ySplit: row }];
  ws.autoFilter = { from: { row, column: 1 }, to: { row, column: headers.length } };
}

function finish(ws: ExcelJS.Worksheet): void {
  ws.columns.forEach((column) => {
    let width = 12;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      width = Math.min(42, Math.max(width, String(cell.value ?? "").length + 2));
    });
    column.width = width;
  });
}

function setMoney(cell: ExcelJS.Cell, value: unknown): void {
  cell.value = typeof value === "number" ? value : null;
  cell.numFmt = MONEY;
}

function setNumber(cell: ExcelJS.Cell, value: unknown): void {
  cell.value = typeof value === "number" ? value : null;
  cell.numFmt = NUMBER;
}

function setInteger(cell: ExcelJS.Cell, value: unknown): void {
  cell.value = typeof value === "number" ? value : null;
  cell.numFmt = INTEGER;
}

function setPercent(cell: ExcelJS.Cell, value: unknown): void {
  cell.value = typeof value === "number" ? value / 100 : null;
  cell.numFmt = PERCENT;
}

function sourceCell(row: ExcelJS.Row, source: string, basis: string): void {
  row.getCell(row.cellCount + 1).value = source;
  row.getCell(row.cellCount + 1).value = basis;
}

function allDistributors(
  input: DistributorDeepDiveWorkbookInput,
): DistributorGroup[] {
  const { result, distributorFilter } = input;
  return result.distributors.filter((d) => !distributorFilter || d.normKey === distributorFilter);
}

function buildSummary(input: DistributorDeepDiveWorkbookInput, ws: ExcelJS.Worksheet): void {
  const { result } = input;
  addTitle(ws, "Distributor Deep Dive — Summary", "Decision summary; Indian number formats; every figure includes its source and basis.");
  addHeader(ws, [
    "Distributor", "Retailers", "Active", "Order booking", "Sales received",
    "Primary dispatch", "Pending", "Fill rate", "Source", "Basis", "Availability",
    "OB availability", "Sales availability", "Dispatch availability", "Pending availability", "Fill availability",
  ]);
  for (const d of allDistributors(input)) {
    const f = d.flows;
    const row = ws.addRow([d.name, d.retailerCount, d.activeCount, null, null, null, null, null]);
    setMoney(row.getCell(4), d.orderBooking);
    setMoney(row.getCell(5), d.sale);
    setMoney(row.getCell(6), f?.primaryDispatch);
    setMoney(row.getCell(7), f?.pendingValue);
    setPercent(row.getCell(8), f?.fillRate);
    row.getCell(9).value = "Member working sheets; sale_line; primary_order_line";
    row.getCell(10).value = "Party / secondary OB and sales are FY sheet values; primary flow follows selected period.";
    row.getCell(11).value = availability(f?.primaryDispatch);
    row.getCell(12).value = availability(d.orderBooking);
    row.getCell(13).value = availability(d.sale);
    row.getCell(14).value = availability(f?.primaryDispatch);
    row.getCell(15).value = availability(f?.pendingValue);
    row.getCell(16).value = availability(f?.fillRate);
  }
  const totals = ws.addRow(["TOTAL", null, null, null, null, null, null, null]);
  totals.font = { bold: true };
  setInteger(totals.getCell(2), allDistributors(input).reduce((n, d) => n + d.retailerCount, 0));
  setInteger(totals.getCell(3), allDistributors(input).reduce((n, d) => n + d.activeCount, 0));
  [4, 5, 6, 7].forEach((col) => {
    const values = allDistributors(input).map((d) => {
      const f = d.flows;
      return col === 4 ? d.orderBooking : col === 5 ? d.sale : col === 6 ? f?.primaryDispatch : f?.pendingValue;
    });
    setMoney(totals.getCell(col), values.some((v) => v == null) ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0));
  });
  finish(ws);
}

function buildDetail(input: DistributorDeepDiveWorkbookInput, ws: ExcelJS.Worksheet): void {
  addTitle(ws, "Distributor Deep Dive — Detail", "Six-master product mix is the headline; legacy source-segment evidence is retained below.");
  const headers = [
    "Distributor", "Retailers", "Active", "Dormant", "Order booking", "Sales received",
    "Primary dispatch", "Pending", "Fill rate", "Confirmed rows", "Guessed rows",
    ...CANONICAL_MASTER_CATEGORIES.map((x) => `${x} NET`),
    "Six-master coverage", "Legacy source evidence", "Source", "Basis", "Availability",
    "OB availability", "Sales availability", "Dispatch availability", "Pending availability", "Fill availability",
  ];
  addHeader(ws, headers);
  for (const d of allDistributors(input)) {
    const f = d.flows;
    const sku: DistributorSkuSpread | undefined = d.skuSpread;
    const legacy = (sku?.netBySourceSegment ?? []).map((x) => `${x.segment}: ₹${Math.round(x.net).toLocaleString("en-IN")}`).join("; ");
    const row = ws.addRow([
      d.name, d.retailerCount, d.activeCount, d.dormantCount, null, null, null, null, null,
      d.confirmedCount, d.guessedCount,
      ...CANONICAL_MASTER_CATEGORIES.map((master) => sku?.netByMasterCategory?.find((x) => x.segment === master)?.net ?? null),
      sku?.masterCategoriesCovered != null && sku.totalMasterCategories
        ? `${sku.masterCategoriesCovered}/${sku.totalMasterCategories}` : null,
      legacy || null,
    ]);
    setMoney(row.getCell(5), d.orderBooking);
    setMoney(row.getCell(6), d.sale);
    setMoney(row.getCell(7), f?.primaryDispatch);
    setMoney(row.getCell(8), f?.pendingValue);
    setPercent(row.getCell(9), f?.fillRate);
    const firstMaster = 12;
    CANONICAL_MASTER_CATEGORIES.forEach((_, i) => setMoney(row.getCell(firstMaster + i), row.getCell(firstMaster + i).value));
    row.getCell(headers.length - 7).value = "secondary_register_line; member working sheets; sale_line; primary_order_line";
    row.getCell(headers.length - 6).value = "D3 six-master rollup is the headline; legacy brand/source segments remain evidence beneath it.";
    row.getCell(headers.length - 5).value = availability(sku?.totalNet);
    row.getCell(headers.length - 4).value = availability(d.orderBooking);
    row.getCell(headers.length - 3).value = availability(d.sale);
    row.getCell(headers.length - 2).value = availability(f?.primaryDispatch);
    row.getCell(headers.length - 1).value = availability(f?.pendingValue);
    row.getCell(headers.length).value = availability(f?.fillRate);
  }
  finish(ws);
}

function buildRetailers(input: DistributorDeepDiveWorkbookInput, ws: ExcelJS.Worksheet): void {
  addTitle(ws, "Distributor Deep Dive — Retailers", "Retailer detail for the selected scope; direct dealers and unassigned rows remain separate mapping categories.");
  addHeader(ws, ["Distributor", "Retailer", "District", "City", "Member", "Order booking", "Sales received", "Visits", "Active", "Head confirmed", "Source", "Basis", "Availability"]);
  for (const d of allDistributors(input)) {
    for (const r of d.retailers) addRetailerRow(ws, d.name, r, "named distributor", "member working-sheet retailer row");
  }
  for (const r of input.result.sharedRetailers) {
    addRetailerRow(ws, `Shared: ${r.rawDistributor}`, r, "shared distributor", "member working-sheet retailer row");
  }
  finish(ws);
}

function addRetailerRow(
  ws: ExcelJS.Worksheet,
  distributor: string,
  r: ExportRetailer & { rawDistributor?: string },
  category: string,
  basis: string,
): void {
  const row = ws.addRow([distributor, r.name, r.district, r.city, r.memberName, null, null, null, r.isActive, r.confirmedHead, "Member working sheets", `${category}; ${basis}`]);
  setMoney(row.getCell(6), r.orderBooking);
  setMoney(row.getCell(7), r.sale);
  setInteger(row.getCell(8), r.visits);
  row.getCell(13).value = availability(r.orderBooking);
}

function buildMapping(input: DistributorDeepDiveWorkbookInput, ws: ExcelJS.Worksheet): void {
  const { result } = input;
  const scoped = Boolean(input.distributorFilter || input.selectedStates?.length);
  const scopeNote = scoped ? "Whole-head diagnostic (not selected-scope)" : "Selected head scope";
  addTitle(ws, "Distributor Deep Dive — Mapping", `Mapping quality is descriptive; ${scopeNote}.`);
  addHeader(ws, ["Category", "Count / value", "Availability", "Source", "Basis"]);
  const mapping = result.mappingQuality;
  const names = new Set(allDistributors(input).map((d) => d.name));
  const scopedCandidates = result.namingCandidates.filter((n) => !names.size || names.has(n.a) || names.has(n.b));
  const rows: Array<[string, unknown, string, string]> = [
    ["Named distributors", mapping?.distributorCount, "member working sheets", `normalised assigned-distributor values; ${scopeNote}`],
    ["Blank assignment (direct dealer branch)", mapping?.blankCount, "member working sheets", `blank Assigned Distributor values; ${scopeNote}`],
    ["None / -- assignment", mapping?.noneCount, "member working sheets", `explicit unassigned values; ${scopeNote}`],
    ["Shared distributor assignment", mapping?.sharedCount, "member working sheets", `comma-separated relationship; ${scopeNote}`],
    ["Malformed assignment", mapping?.malformedCount, "member working sheets", `invalid/malformed distributor field; ${scopeNote}`],
    ["Shared retailer rows", result.sharedRetailers.length, "member working sheets", `shared relationships retained as one row; selected scope`],
    ["Naming candidates", scopedCandidates.length, "normalised name analysis", `near-duplicate names require human confirmation; ${scopeNote}`],
    ["Members loaded", result.membersLoaded, "member working sheets", "loaded source sheets"],
    ["Members failed", result.membersFailed, "member working sheets", "unavailable source sheets; not treated as zero"],
  ];
  for (const [label, value, source, basis] of rows) {
    const row = ws.addRow([label, value, availability(value), source, basis]);
    if (typeof value === "number") setInteger(row.getCell(2), value);
  }
  for (const n of scopedCandidates) {
    ws.addRow(["Duplicate-name candidate", `${n.a} ↔ ${n.b}`, "value", "normalised name analysis", `Similarity ${(n.similarity * 100).toFixed(1)}%; never auto-merged`]);
  }
  finish(ws);
}

function buildWorking(input: DistributorDeepDiveWorkbookInput, ws: ExcelJS.Worksheet): void {
  const { result } = input;
  addTitle(ws, "Distributor Deep Dive — Working detail", "Technical scaffolding is separated from decision sheets; source and basis accompany every figure.");
  addHeader(ws, ["Block", "Measure", "Value", "Availability", "Source", "Basis"]);
  const rows: Array<[string, string, unknown, string, string]> = [
    ["Load", "FY", result.fy, "route request", "selected fiscal year"],
    ["Load", "State heads", result.stateHeads.join(", "), "directory / deep-dive payload", "selected scope"],
    ["Load", "Members loaded", result.membersLoaded, "member working sheets", "successful reads"],
    ["Load", "Members failed", result.membersFailed, "member working sheets", "read failures; unavailable, not zero"],
    ["Load", "Members not mapped", result.membersNotMapped, "roster / deep-dive payload", "not mapped into selected team"],
    ["Load", "Party / secondary OB total", result.partyObTotal, "member working sheets", "party order booking; not sales"],
  ];
  for (const [block, measure, value, source, basis] of rows) {
    const row = ws.addRow([block, measure, null, availability(value), source, basis]);
    if (typeof value === "number") setMoney(row.getCell(3), value);
    else row.getCell(3).value = value == null ? null : String(value);
  }
  for (const d of allDistributors(input)) {
    const f = d.flows;
    const row = ws.addRow(["Distributor flow", d.name, null, availability(f?.primaryDispatch), "sale_line; primary_order_line; member working sheets", "primary in-flow versus secondary out-flow; period filter applies only to register-derived primary measures"]);
    setMoney(row.getCell(3), f?.primaryDispatch);
  }
  finish(ws);
}

function buildInfo(input: DistributorDeepDiveWorkbookInput, ws: ExcelJS.Worksheet): void {
  const { result } = input;
  addTitle(ws, "Distributor Deep Dive — Info", "Provenance, scope, filters, provisional periods, holds, and interpretation rules.");
  addHeader(ws, ["Field", "Value", "Source / basis"]);
  const directoryCount = input.directoryCount ?? null;
  const identityCount = input.identityCount ?? null;
  const scope = directoryCount != null && identityCount != null
    ? `Shown directory scope: ${directoryCount} of ${identityCount} distributor identities. The directory is built from loaded/stale member-sheet snapshots; distributor_identity is the broader registry.`
    : "Shown directory scope is derived from the directory payload; identity-registry count was unavailable for this export.";
  const rows: Array<[string, unknown, string]> = [
    ["FY", result.fy, "Route request / deep-dive payload"],
    ["Period", input.periodLabel ?? "Full FY", input.months?.length ? `Selected months: ${input.months.join(", ")}` : "No period filter"],
    ["Geography", input.geoLabel ?? "All India", "UI filter selection"],
    ["State head", input.stateHead ?? "All heads serving selection", "UI filter selection"],
    ["Distributor filter", input.distributorFilter ?? "All distributors", "UI filter selection"],
    ["Directory scope", scope, "Distributor directory payload and identity registry when available"],
    ["Directory members", input.directoryMemberCount ?? "Unavailable", "Distributor directory payload"],
    ["Directory states", input.directoryStateCount ?? "Unavailable", "Distributor directory payload"],
    ["Directory heads", input.directoryHeadCount ?? "Unavailable", "Distributor directory payload"],
    ["Selected canonical states", input.selectedStates?.join(", ") || "All states", "UI geography scope"],
    ["Members loaded", result.membersLoaded, "Member working sheets"],
    ["Sources", (input.sources ?? ["Member working sheets", "secondary_register_line", "sale_line", "primary_order_line"]).join("; "), "Source manifest"],
    ["Provisional months", input.provisionalMonths ?? "Unavailable", "Live provisional-month payload; unavailable is not zero"],
    ["Secondary coverage", input.secondaryCoverage ?? "Unavailable", "Secondary-register coverage payload"],
    ["Mapping metric scope", input.distributorFilter || input.selectedStates?.length
      ? "Whole-head diagnostic (not selected-scope); detail rows are selected-scope."
      : "Selected head scope", "Mapping-quality payload versus filtered detail rows"],
    ["Active holds", input.activeHolds?.length ? input.activeHolds.join("; ") : "None reported", "Resolution hold payload"],
    ["Generated at", (input.generatedAt ?? new Date()).toISOString(), "Export execution timestamp"],
    ["Availability states", "value / zero / unavailable", "Zero means measured zero; unavailable means source not present or failed"],
    ["Booking terminology", "Order booking is committed order value; it is never labelled sales.", "Member working-sheet source semantics"],
    ["D3 product mix", "Six-master categories are the headline. Legacy brand/source segments are retained as evidence beneath.", "secondary_register_line brand_canon plus Prompt 68 category registry"],
    ["Interpretation", "Primary dispatch, pending, recency and frequency may follow selected months; member-sheet order booking and retailer detail are FY-sheet values.", "Route period contract"],
  ];
  for (const [field, value, source] of rows) ws.addRow([field, value, source]);
  finish(ws);
}

export function buildDistributorDeepDiveWorkbook(input: DistributorDeepDiveWorkbookInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  buildSummary(input, workbook.addWorksheet("Summary"));
  buildDetail(input, workbook.addWorksheet("Detail"));
  buildRetailers(input, workbook.addWorksheet("Retailers"));
  buildMapping(input, workbook.addWorksheet("Mapping"));
  buildWorking(input, workbook.addWorksheet("Working detail"));
  buildInfo(input, workbook.addWorksheet("Info"));
  workbook.worksheets.forEach((ws) => {
    ws.eachRow((row) => row.eachCell((cell) => {
      if (cell.value == null) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: UNAVAILABLE } };
    }));
  });
  return workbook;
}

export async function buildDistributorDeepDiveExport(input: DistributorDeepDiveWorkbookInput): Promise<Buffer> {
  return Buffer.from(await buildDistributorDeepDiveWorkbook(input).xlsx.writeBuffer());
}