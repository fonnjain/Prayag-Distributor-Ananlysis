import ExcelJS from "exceljs";

export type SalesPeopleFigure = number | null;

export type SalesPeopleExportRow = {
  name: string;
  stateHead: string;
  plan: SalesPeopleFigure;
  ob: SalesPeopleFigure;
  sales: SalesPeopleFigure;
  achievementPct: SalesPeopleFigure;
  isLeft?: boolean;
  isPrimaryRole?: boolean;
  reasons?: Partial<Record<"plan" | "ob" | "sales" | "achievementPct", string>>;
};

export type SalesPeopleExportInput = {
  fy: string;
  period: string;
  filters: string;
  showPrimary: boolean;
  rows: SalesPeopleExportRow[];
  summary: {
    membersWithPlan: number;
    obMembers: number;
    plan: number;
    ob: number;
    sales: number;
    salesAvailable: number;
    salesUnavailable: number;
    salesGenuineZero: number;
  };
  sources: {
    plan: string;
    ob: string;
    sales: string;
    achievement: string;
  };
  provisionalMonths: string;
  dataReadAt: string;
};

type FigureKey = "plan" | "ob" | "sales" | "achievementPct";

export function figureState(value: number | null, reason = "No value was recorded"): {
  state: "available" | "unavailable" | "genuine zero";
  reason: string;
} {
  if (value == null) return { state: "unavailable", reason };
  if (value === 0) return { state: "genuine zero", reason: "Recorded value is zero" };
  return { state: "available", reason: "Recorded value" };
}

function amount(value: number | null): string {
  if (value == null) return "";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

function percent(value: number | null): string {
  return value == null ? "" : `${value.toFixed(2)}%`;
}

const UNAVAILABLE_FILL = "FFE5E7EB";

function setHeader(worksheet: ExcelJS.Worksheet, headers: string[]): void {
  const row = worksheet.addRow(headers);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "334155" } };
  row.alignment = { vertical: "middle" };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

function sensibleWidths(worksheet: ExcelJS.Worksheet): void {
  worksheet.columns.forEach((column) => {
    let width = 12;
    if (column.eachCell) {
      column.eachCell({ includeEmpty: false }, (cell) => {
        width = Math.max(width, String(cell.value ?? "").length + 2);
      });
    }
    column.width = Math.min(width, 42);
  });
}

type FigureCell = {
  value: string | number | null;
  state: "available" | "unavailable" | "genuine zero";
  reason: string;
  unavailable: boolean;
};

function addFigureColumns(
  row: SalesPeopleExportRow,
  key: FigureKey,
): FigureCell {
  const value = row[key];
  const reason = row.reasons?.[key];
  const state = figureState(value, reason);
  return {
    // Keep unavailable figure cells genuinely blank. Numeric zero remains a
    // numeric zero (rather than the formatted string "₹0"/"0.00%"), so
    // downstream Excel formulas can still distinguish it from blank.
    value: value == null
      ? null
      : value === 0
        ? 0
        : key === "achievementPct" ? percent(value) : amount(value),
    state: state.state,
    reason: state.reason,
    unavailable: value == null,
  };
}

/**
 * Builds the four-sheet Sales People export from the already filtered and
 * sorted rows. Keeping filtering outside this function makes it impossible
 * for the export to silently broaden the page selection.
 */
export function buildSalesPeopleWorkbook(input: SalesPeopleExportInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prayag Sales Intelligence";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.addRow(["Sales People — Summary"]);
  summary.getRow(1).font = { bold: true, size: 14 };
  summary.addRow(["FY", input.fy]);
  summary.addRow(["Period", input.period]);
  summary.addRow([]);
  summary.addRow(["Card", "Value", "Basis / coverage"]);
  summary.getRow(5).font = { bold: true };
  summary.addRow([
    "Members with plan",
    String(input.summary.membersWithPlan),
    `${input.summary.membersWithPlan} of ${input.rows.length} filtered members; plan is ${input.sources.plan}.`,
  ]);
  summary.addRow([
    "Plan",
    amount(input.summary.plan),
    `Sum across members with a recorded plan; ${input.sources.plan}.`,
  ]);
  summary.addRow([
    "OB",
    amount(input.summary.ob),
    `${input.summary.obMembers} of ${input.rows.length} filtered members; ${input.sources.ob}.`,
  ]);
  summary.addRow([
    "Sales",
    amount(input.summary.sales),
    `Sales ${amount(input.summary.sales)} across ${input.summary.salesAvailable + input.summary.salesGenuineZero} of ${input.rows.length} filtered members (${input.summary.salesAvailable} positive, ${input.summary.salesGenuineZero} genuine zero, ${input.summary.salesUnavailable} unavailable); ${input.sources.sales}.`,
  ]);
  summary.addRow([]);
  summary.addRow(["Sales state", "Members"]);
  summary.addRow(["Available (positive)", input.summary.salesAvailable]);
  summary.addRow(["Unavailable", input.summary.salesUnavailable]);
  summary.addRow(["Genuine zero", input.summary.salesGenuineZero]);
  sensibleWidths(summary);

  const members = workbook.addWorksheet("Members");
  setHeader(members, [
    "Name", "State head", "Plan", "Plan state", "Plan reason",
    "OB", "OB state", "OB reason", "Sales", "Sales state", "Sales reason",
    "Sales/Plan %", "Sales/Plan state", "Sales/Plan reason", "Member marker",
  ]);
  for (const row of input.rows) {
    const plan = addFigureColumns(row, "plan");
    const ob = addFigureColumns(row, "ob");
    const sales = addFigureColumns(row, "sales");
    const achievement = addFigureColumns(row, "achievementPct");
    const excelRow = members.addRow([
      row.name,
      row.stateHead,
      plan.value, plan.state, plan.reason,
      ob.value, ob.state, ob.reason,
      sales.value, sales.state, sales.reason,
      achievement.value, achievement.state, achievement.reason,
      [row.isPrimaryRole ? "primary role" : "", row.isLeft ? "left" : ""].filter(Boolean).join(", "),
    ]);
    // Numeric figure columns (C, F, I, L) are visibly unavailable without
    // turning the blank into a misleading zero. State and reason columns stay
    // populated beside them for filtering/auditability.
    for (const [column, cell] of [[3, plan], [6, ob], [9, sales], [12, achievement]] as const) {
      if (cell.unavailable) {
        excelRow.getCell(column).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: UNAVAILABLE_FILL },
        };
        excelRow.getCell(column).font = { color: { argb: "FF6B7280" } };
      } else if (cell.value === 0) {
        excelRow.getCell(column).numFmt = column === 12 ? "0.00%" : "₹#,##0";
      }
    }
  }
  sensibleWidths(members);

  const missing = workbook.addWorksheet("Missing data");
  setHeader(missing, ["Name", "State head", "Missing figure", "Reason"]);
  for (const row of input.rows) {
    for (const key of ["plan", "ob", "sales"] as const) {
      if (row[key] != null) continue;
      const label = key === "ob" ? "OB" : key === "sales" ? "Sales" : "Plan";
      const reason = row.reasons?.[key] ?? "No value was recorded for the selected period";
      missing.addRow([row.name, row.stateHead, label, reason]);
    }
  }
  sensibleWidths(missing);

  const info = workbook.addWorksheet("Info");
  setHeader(info, ["Field", "Value"]);
  const infoRows: [string, string][] = [
    ["Scope", "Sales People page; rows exactly match the filtered table."],
    ["FY", input.fy],
    ["Period", input.period],
    ["Filters applied", input.filters],
    ["Member count", String(input.rows.length)],
    ["Show primary-role members", input.showPrimary ? "Yes" : "No"],
    ["Plan source", input.sources.plan],
    ["OB source", input.sources.ob],
    ["Sales source", input.sources.sales],
    ["Achievement source", input.sources.achievement],
    ["Three-state convention", "available = recorded non-zero; genuine zero = recorded 0; unavailable = blank with reason."],
    ["Provisional months", input.provisionalMonths],
    ["Data-read timestamp", input.dataReadAt],
  ];
  for (const [field, value] of infoRows) info.addRow([field, value]);
  sensibleWidths(info);

  return workbook;
}

export async function downloadSalesPeopleWorkbook(input: SalesPeopleExportInput): Promise<void> {
  const workbook = buildSalesPeopleWorkbook(input);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `SalesPeople_${input.fy}_${input.period.replace(/[^A-Za-z0-9]+/g, "_")}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}