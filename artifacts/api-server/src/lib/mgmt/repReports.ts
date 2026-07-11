// Per-salesperson Excel report workbook builder.
//
// Builds a 9-tab xlsx (Cover, Monthly Booking, By State, By Group, By Segment,
// Top Parties, New Parties, Churned Parties, Movers) from the existing DeepDive
// output. No new Sheets reads are required; everything comes from the in-memory
// aggregates that buildDeepDive already computed.
import ExcelJS from "exceljs";
import { fyShort, fyStartYear } from "./names.js";
import type { DeepDive, DeepRow } from "./salespeople.js";
import type { TmOrderAgg } from "./orders.js";

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9E1F2" },
};
const TOTAL_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFCE4D6" },
};
const FMT_INT = "#,##0";
const FMT_PCT = "0.00%";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Apr = fiscal month 0 -> calendar month 3 (April)
function fiscalMonthLabel(idx: number, startYear: number): string {
  const calMonth = (idx + 3) % 12;
  const calYear = calMonth < 3 ? startYear + 1 : startYear;
  return `${MONTH_NAMES[calMonth]}-${String(calYear).slice(2)}`;
}

function hdr(ws: ExcelJS.Worksheet, row: number, col: number, text: string, width?: number): void {
  const cell = ws.getCell(row, col);
  cell.value = text;
  cell.fill = HEADER_FILL;
  cell.font = { bold: true, size: 9 };
  cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
  if (width) ws.getColumn(col).width = width;
}

function writeComparisonSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: DeepRow[],
  thisFyLabel: string,
  lastFyLabel: string,
): void {
  const ws = wb.addWorksheet(name);
  const cols = [
    { label: "Name", width: 28 },
    { label: `This FY (${thisFyLabel})`, width: 15 },
    { label: `Last FY (${lastFyLabel})`, width: 15 },
    { label: "Difference", width: 14 },
    { label: "Growth %", width: 11 },
    { label: "Share %", width: 11 },
  ];
  cols.forEach((c, i) => hdr(ws, 1, i + 1, c.label, c.width));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.label;
    ws.getCell(rowNum, 2).value = r.thisFy;
    ws.getCell(rowNum, 2).numFmt = FMT_INT;
    ws.getCell(rowNum, 3).value = r.lastFy;
    ws.getCell(rowNum, 3).numFmt = FMT_INT;
    ws.getCell(rowNum, 4).value = r.diff;
    ws.getCell(rowNum, 4).numFmt = FMT_INT;
    if (r.growthPct != null) {
      ws.getCell(rowNum, 5).value = r.growthPct / 100;
      ws.getCell(rowNum, 5).numFmt = FMT_PCT;
    }
    if (r.sharePct != null) {
      ws.getCell(rowNum, 6).value = r.sharePct / 100;
      ws.getCell(rowNum, 6).numFmt = FMT_PCT;
    }
  });

  if (rows.length > 0) {
    const totalRow = rows.length + 2;
    const sumThis = rows.reduce((a, r) => a + r.thisFy, 0);
    const sumLast = rows.reduce((a, r) => a + r.lastFy, 0);
    ws.getCell(totalRow, 1).value = "Total";
    ws.getCell(totalRow, 2).value = sumThis;
    ws.getCell(totalRow, 2).numFmt = FMT_INT;
    ws.getCell(totalRow, 3).value = sumLast;
    ws.getCell(totalRow, 3).numFmt = FMT_INT;
    ws.getCell(totalRow, 4).value = sumThis - sumLast;
    ws.getCell(totalRow, 4).numFmt = FMT_INT;
    for (let c = 1; c <= 6; c++) {
      ws.getCell(totalRow, c).fill = TOTAL_FILL;
      ws.getCell(totalRow, c).font = { bold: true };
    }
  }
}

function writePartySheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: DeepRow[],
  thisFyLabel: string,
  lastFyLabel: string,
): void {
  const ws = wb.addWorksheet(name);
  const cols = [
    { label: "Party", width: 32 },
    { label: `Amount (${thisFyLabel})`, width: 15 },
    { label: `Prior FY (${lastFyLabel})`, width: 15 },
    { label: "Difference", width: 14 },
    { label: "Growth %", width: 11 },
    { label: "Share %", width: 11 },
    { label: "Status", width: 10 },
  ];
  cols.forEach((c, i) => hdr(ws, 1, i + 1, c.label, c.width));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.label;
    ws.getCell(rowNum, 2).value = r.thisFy;
    ws.getCell(rowNum, 2).numFmt = FMT_INT;
    ws.getCell(rowNum, 3).value = r.lastFy;
    ws.getCell(rowNum, 3).numFmt = FMT_INT;
    ws.getCell(rowNum, 4).value = r.diff;
    ws.getCell(rowNum, 4).numFmt = FMT_INT;
    if (r.growthPct != null) {
      ws.getCell(rowNum, 5).value = r.growthPct / 100;
      ws.getCell(rowNum, 5).numFmt = FMT_PCT;
    }
    if (r.sharePct != null) {
      ws.getCell(rowNum, 6).value = r.sharePct / 100;
      ws.getCell(rowNum, 6).numFmt = FMT_PCT;
    }
    if (r.flag) ws.getCell(rowNum, 7).value = r.flag;
  });
}

export async function buildRepReportWorkbook(
  dive: DeepDive,
  tmAgg: TmOrderAgg | null,
  basis: "secondary" | "primary",
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = new Date();

  const thisFy = fyShort(dive.fy);
  const lastFy = fyShort(dive.priorFy);
  const startYear = fyStartYear(dive.fy);

  // --- Sheet 1: Cover ---
  {
    const ws = wb.addWorksheet("Cover");
    ws.getColumn(1).width = 26;
    ws.getColumn(2).width = 36;

    const title = ws.getCell(1, 1);
    title.value = "Prayag India — Sales Report";
    title.font = { bold: true, size: 14 };
    ws.mergeCells(1, 1, 1, 2);

    const infoRows: [string, string | number | null][] = [
      ["Sales Person", dive.repName],
      ["Fiscal Year", dive.fy],
      ["Basis", basis === "primary" ? "Primary (SAP dispatched sale)" : "Secondary (order booking)"],
      ["Scope", dive.scope === "team" ? "Own + rolled-up team" : "Own book only"],
      ["Generated", new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })],
      ["", ""],
      ["Net Order Booked", dive.tiles.netOrderBooked],
      ["Prior FY Net", dive.tiles.netOrderBookedLast],
      ["Growth", dive.tiles.growthPct != null ? `${dive.tiles.growthPct}%` : "n/a"],
      ["Orders", dive.tiles.orders],
      ["Active Retailers", dive.tiles.activeRetailers],
      ["New Retailers", dive.tiles.newRetailers],
      ["Target", dive.tiles.target],
      ["Achievement", dive.tiles.achievementPct != null ? `${dive.tiles.achievementPct}%` : "n/a"],
    ];
    infoRows.forEach(([label, value], i) => {
      if (!label) return;
      const rowNum = i + 3;
      ws.getCell(rowNum, 1).value = label;
      ws.getCell(rowNum, 1).font = { bold: true };
      if (value != null && value !== "") {
        ws.getCell(rowNum, 2).value = value;
        if (typeof value === "number") ws.getCell(rowNum, 2).numFmt = FMT_INT;
      }
    });

    if (basis === "primary") {
      const noteRow = infoRows.length + 5;
      const note = ws.getCell(noteRow, 1);
      note.value =
        "Note: Primary basis uses SAP dispatched-sale data via the Party TM Map bridge. " +
        "Bridge coverage is approximately 37%. Unbridged amounts remain at State Head level.";
      note.font = { italic: true, size: 9 };
      note.alignment = { wrapText: true };
      ws.mergeCells(noteRow, 1, noteRow, 2);
      ws.getRow(noteRow).height = 36;
    }
  }

  // --- Sheet 2: Monthly Booking ---
  {
    const ws = wb.addWorksheet("Monthly Booking");
    const cols = [
      { label: "Month", width: 12 },
      { label: "Order Amount", width: 16 },
      { label: "Orders", width: 10 },
      { label: "Sale Amount", width: 16 },
    ];
    cols.forEach((c, i) => hdr(ws, 1, i + 1, c.label, c.width));

    for (let mIdx = 0; mIdx < 12; mIdx++) {
      const rowNum = mIdx + 2;
      ws.getCell(rowNum, 1).value = fiscalMonthLabel(mIdx, startYear);
      if (tmAgg) {
        ws.getCell(rowNum, 2).value = tmAgg.monthAmount[mIdx];
        ws.getCell(rowNum, 2).numFmt = FMT_INT;
        ws.getCell(rowNum, 3).value = tmAgg.monthOrderIds[mIdx].size;
        ws.getCell(rowNum, 4).value = tmAgg.saleMonthAmount[mIdx];
        ws.getCell(rowNum, 4).numFmt = FMT_INT;
      }
    }

    const totalRow = 14;
    ws.getCell(totalRow, 1).value = "Total";
    if (tmAgg) {
      ws.getCell(totalRow, 2).value = tmAgg.amount;
      ws.getCell(totalRow, 2).numFmt = FMT_INT;
      ws.getCell(totalRow, 3).value = tmAgg.orderIds.size;
      ws.getCell(totalRow, 4).value = tmAgg.saleAmount;
      ws.getCell(totalRow, 4).numFmt = FMT_INT;
    }
    for (let c = 1; c <= 4; c++) {
      ws.getCell(totalRow, c).fill = TOTAL_FILL;
      ws.getCell(totalRow, c).font = { bold: true };
    }
  }

  // --- Sheets 3-5: Comparison tables ---
  writeComparisonSheet(wb, "By State", dive.byState, thisFy, lastFy);
  writeComparisonSheet(wb, "By Group", dive.byGroup, thisFy, lastFy);
  writeComparisonSheet(wb, "By Segment", dive.bySegment, thisFy, lastFy);

  // --- Sheets 6-8: Party tables ---
  writePartySheet(wb, "Top Parties", dive.parties.top, thisFy, lastFy);
  writePartySheet(wb, "New Parties", dive.parties.newTop, thisFy, lastFy);
  writePartySheet(wb, "Churned Parties", dive.parties.churned, thisFy, lastFy);

  // --- Sheet 9: Movers ---
  {
    const ws = wb.addWorksheet("Movers");
    ws.getColumn(1).width = 30;
    ws.getColumn(2).width = 16;
    ws.getColumn(3).width = 30;
    ws.getColumn(4).width = 16;

    hdr(ws, 1, 1, "Parties Gaining");
    hdr(ws, 1, 2, "Gain (vs Prior FY)");
    hdr(ws, 1, 3, "Parties Declining");
    hdr(ws, 1, 4, "Decline (vs Prior FY)");

    const maxRows = Math.max(
      dive.movers.partiesUp.length,
      dive.movers.partiesDown.length,
      dive.movers.segmentsUp.length,
      dive.movers.segmentsDown.length,
    );
    // Parties up/down: rows 2+
    for (let i = 0; i < Math.max(dive.movers.partiesUp.length, dive.movers.partiesDown.length); i++) {
      const rowNum = i + 2;
      const up = dive.movers.partiesUp[i];
      const down = dive.movers.partiesDown[i];
      if (up) {
        ws.getCell(rowNum, 1).value = up.label;
        ws.getCell(rowNum, 2).value = up.diff;
        ws.getCell(rowNum, 2).numFmt = FMT_INT;
      }
      if (down) {
        ws.getCell(rowNum, 3).value = down.label;
        ws.getCell(rowNum, 4).value = down.diff;
        ws.getCell(rowNum, 4).numFmt = FMT_INT;
      }
    }

    const segOffset = Math.max(dive.movers.partiesUp.length, dive.movers.partiesDown.length) + 3;
    hdr(ws, segOffset, 1, "Segments Gaining");
    hdr(ws, segOffset, 2, "Gain (vs Prior FY)");
    hdr(ws, segOffset, 3, "Segments Declining");
    hdr(ws, segOffset, 4, "Decline (vs Prior FY)");
    for (let i = 0; i < Math.max(dive.movers.segmentsUp.length, dive.movers.segmentsDown.length); i++) {
      const rowNum = segOffset + i + 1;
      const up = dive.movers.segmentsUp[i];
      const down = dive.movers.segmentsDown[i];
      if (up) {
        ws.getCell(rowNum, 1).value = up.label;
        ws.getCell(rowNum, 2).value = up.diff;
        ws.getCell(rowNum, 2).numFmt = FMT_INT;
      }
      if (down) {
        ws.getCell(rowNum, 3).value = down.label;
        ws.getCell(rowNum, 4).value = down.diff;
        ws.getCell(rowNum, 4).numFmt = FMT_INT;
      }
    }
    void maxRows;
  }

  return wb;
}
