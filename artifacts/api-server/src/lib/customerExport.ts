import ExcelJS from "exceljs";

export interface CustomerExportRow {
  customerId: string;
  name: string;
  type: string | null;
  distNumber?: string | null;
  cpCode?: string | null;
  stateHeadName?: string | null;
  memberName?: string | null;
  stateName?: string | null;
  linked?: boolean | null;
  status?: string | null;
  confidence?: string | null;
  source?: string | null;
  primarySalesValue?: number | string | null;
  orderBookingValue?: number | string | null;
  availableValue?: number | string | null;
  valueBasis?: string | null;
  missingReason?: string | null;
  territoryName?: string | null;
}

export interface CustomerReviewExportRow {
  queueId: number | string;
  name: string;
  type: string | null;
  stateName?: string | null;
  memberName?: string | null;
  status?: string | null;
  reason?: string | null;
  submittedBy?: string | null;
  submittedAt?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  approvedCustomerId?: string | null;
}

export interface CustomerExportInput {
  customers: CustomerExportRow[];
  unassigned: CustomerExportRow[];
  reviewQueue: CustomerReviewExportRow[];
  filters: Record<string, string | undefined>;
  generatedAt?: string;
  sourceNotes?: string[];
}

const INR_FORMAT = '₹ #,##0.00';
const HEADER_FILL = "FFE8EDF5";
const UNAVAILABLE_FILL = "FFE5E7EB";
const UNAVAILABLE_FONT = "FF6B7280";

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function availableValue(row: CustomerExportRow): number | null {
  if (row.availableValue !== undefined) return numberOrNull(row.availableValue);
  const primary = numberOrNull(row.primarySalesValue);
  if (primary !== null) return primary;
  return numberOrNull(row.orderBookingValue);
}

function figureState(value: number | null): "value" | "zero" | "unavailable" {
  if (value === null) return "unavailable";
  return value === 0 ? "zero" : "value";
}

function figureReason(value: number | null, unavailableReason: string): string {
  if (value === null) return unavailableReason;
  if (value === 0) return "Genuine zero in source";
  return "";
}

function styleFigureCell(cell: ExcelJS.Cell, value: number | null): void {
  cell.numFmt = INR_FORMAT;
  if (value === null) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: UNAVAILABLE_FILL } };
    cell.font = { color: { argb: UNAVAILABLE_FONT }, italic: true };
  }
}

function typeLabel(type: string | null | undefined): string {
  return type ? type.replace(/_/g, " ") : "";
}

function missingReason(row: CustomerExportRow): string {
  if (row.missingReason) return row.missingReason;
  const missing: string[] = [];
  if (!row.stateHeadName) missing.push("no head");
  if (!row.stateName) missing.push("no state");
  if (!row.distNumber && !row.cpCode) missing.push("no code");
  return missing.join("; ");
}

function setHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF172033" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
}

function finishSheet(
  sheet: ExcelJS.Worksheet,
  headers: string[],
  widths: number[],
): void {
  sheet.columns = headers.map((header, index) => ({
    header,
    key: `c${index}`,
    width: widths[index] ?? 16,
  }));
  setHeader(sheet.getRow(1));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + Math.min(headers.length, 26))}1` };
}

function addCustomerSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: CustomerExportRow[],
  unassigned: boolean,
): void {
  const headers = [
    "ID", "Name", "Type", "DIST#", "CP code", "Linked State Head", "Member",
    "State", "Link indicator", "Status", "Status dot", "Record source",
    "Primary sales value", "Order booking value", "Available value", "Value basis",
    "Missing reason",
    "Primary sales state", "Primary sales reason",
    "Order booking state", "Order booking reason",
    "Available value state", "Available value reason",
  ];
  const widths = [16, 34, 16, 14, 14, 24, 24, 18, 16, 14, 14, 18, 18, 20, 18, 22, 28, 18, 36, 20, 36, 20, 44];
  const sheet = workbook.addWorksheet(name);
  finishSheet(sheet, headers, widths);

  const ordered = unassigned
    ? [...rows].sort((a, b) => {
      const av = availableValue(a);
      const bv = availableValue(b);
      if (av === null && bv === null) return a.name.localeCompare(b.name);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av || a.name.localeCompare(b.name);
    })
    : rows;

  for (const row of ordered) {
    const primary = numberOrNull(row.primarySalesValue);
    const booking = numberOrNull(row.orderBookingValue);
    const available = availableValue(row);
    const basis = row.valueBasis
      ?? (primary !== null ? "sale_line_current primary sales" : booking !== null ? "secondary_order_line booking" : "");
    const excelRow = sheet.addRow([
      row.customerId,
      row.name,
      typeLabel(row.type),
      row.distNumber ?? "",
      row.cpCode ?? "",
      row.stateHeadName ?? "",
      row.memberName ?? "",
      row.stateName ?? "",
      row.linked === null || row.linked === undefined ? "" : row.linked ? "Linked" : "Not linked",
      row.status ?? "",
      row.confidence ?? "",
      row.source ?? "",
      primary,
      booking,
      available,
      basis,
      unassigned ? missingReason(row) : row.missingReason ?? "",
      figureState(primary),
      figureReason(primary, "No matching sale_line_current value"),
      figureState(booking),
      figureReason(booking, "No matching secondary_order_line booking value"),
      figureState(available),
      figureReason(available, "No primary sales or order-booking value available"),
    ]);
    for (const column of [13, 14, 15]) {
      styleFigureCell(excelRow.getCell(column), [primary, booking, available][column - 13]);
    }
    excelRow.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; });
  }
}

function addReviewSheet(workbook: ExcelJS.Workbook, rows: CustomerReviewExportRow[]): void {
  const headers = [
    "Queue ID", "Name", "Type", "State", "Member", "Review status", "Why",
    "Submitted by", "Submitted at", "Reviewed by", "Reviewed at", "Approved customer ID",
  ];
  const sheet = workbook.addWorksheet("Review queue");
  finishSheet(sheet, headers, [12, 34, 16, 18, 24, 16, 42, 20, 22, 20, 22, 22]);
  for (const row of rows) {
    sheet.addRow([
      row.queueId,
      row.name,
      typeLabel(row.type),
      row.stateName ?? "",
      row.memberName ?? "",
      row.status ?? "",
      row.reason ?? "",
      row.submittedBy ?? "",
      row.submittedAt ?? "",
      row.reviewedBy ?? "",
      row.reviewedAt ?? "",
      row.approvedCustomerId ?? "",
    ]);
  }
}

function addInfoSheet(workbook: ExcelJS.Workbook, input: CustomerExportInput): void {
  const sheet = workbook.addWorksheet("Info");
  sheet.columns = [{ header: "Item", key: "item", width: 30 }, { header: "Value", key: "value", width: 110 }];
  setHeader(sheet.getRow(1));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const filters = Object.entries(input.filters)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("; ") || "None";
  const rows: [string, string][] = [
    ["Scope", "Organisation → Customers master-data mapping export"],
    ["Filters applied", filters],
    ["Customers rows", String(input.customers.length)],
    ["Unassigned rows", String(input.unassigned.length)],
    ["Review queue rows", String(input.reviewQueue.length)],
    ["Data read timestamp", input.generatedAt ?? new Date().toISOString()],
    ["ID / code", "ID is the imported customer identifier. DIST# is shown when the customer row has one; CP code is the exact secondary-order source code, and is blank when absent."],
    ["Linked state head / member / state", "Current open customer_assignment joined to person; state is the imported territory/state label. Blank means no current value, not zero."],
    ["Link indicator", "Linked means at least one current customer_link retailer↔distributor relationship exists; Not linked means no such relationship."],
    ["Status dot", "The status dot is the current assignment confidence: confirmed, assign_user_chain, state_lookup, guessed. Blank means no current assignment."],
    ["Record source", "customer.source identifies import versus app_created (or another stored source value)."],
    ["Three-state figures", "Every monetary figure has a state and reason: value (numeric amount), zero (numeric 0 and 'Genuine zero in source'), or unavailable (blank grey cell with an explicit reason). Unknown is never rendered as zero."],
    ["Available value", "Primary sales value comes from sale_line_current.amount matched to the customer name. Order booking value comes from secondary_order_line.basic_order_value matched to CP code. Available value uses primary sales when present, otherwise booking; blank means unavailable; numeric 0 is a genuine zero."],
    ["Unassigned order", "Unassigned rows are sorted by available value descending; unavailable values are last."],
    ["Missing reason", "A row can have several reasons: no head, no state, and/or no code. Blank is not converted to zero."],
    ["Provisional months", "Not applicable: this master-data export is not period-filtered; values are labelled by source and read as available source totals."],
    ...((input.sourceNotes ?? []).map((note) => ["Source note", note] as [string, string])),
  ];
  for (const row of rows) {
    const excelRow = sheet.addRow(row);
    excelRow.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
}

/** Build the four-sheet master-data workbook used by the Customers page. */
export function buildCustomerExportWorkbook(input: CustomerExportInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prayag Sales Intelligence";
  addCustomerSheet(workbook, "Customers", input.customers, false);
  addCustomerSheet(workbook, "Unassigned", input.unassigned, true);
  addReviewSheet(workbook, input.reviewQueue);
  addInfoSheet(workbook, input);
  return workbook;
}

/** Stable evidence used by tests and logs: sheet names, row counts, and Info presence. */
export function customerExportEvidence(workbook: ExcelJS.Workbook): {
  sheetCount: number;
  sheets: Array<{ name: string; rows: number }>;
  infoGenerated: boolean;
} {
  const sheets = workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: Math.max(0, sheet.rowCount - 1),
  }));
  const info = workbook.getWorksheet("Info");
  const infoText = info
    ? [info.getColumn(1), info.getColumn(2)]
      .flatMap((column) => column.values.map((value) => String(value ?? "")))
      .join("\n")
    : "";
  return {
    sheetCount: sheets.length,
    sheets,
    infoGenerated: infoText.includes("Data read timestamp"),
  };
}