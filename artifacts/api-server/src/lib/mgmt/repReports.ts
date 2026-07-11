// Per-salesperson Excel report workbook builder.
//
// Builds a 10-tab xlsx from the SalesRepReport payload:
//   Cover, Monthly Booking, By State, By Group, By Segment,
//   Top Parties, New Parties, Churned Parties, Movers, Primary Sale.
// No new Sheets reads are required; everything comes from the in-memory
// aggregates already computed by buildSalesReports().
import ExcelJS from "exceljs";
import { fyShort } from "./names.js";
import type { SalesRepReport, PrimaryParty } from "./salesReports.js";
import type { DeepRow } from "./salespeople.js";

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

function writePrimaryPartyBlock(
  ws: ExcelJS.Worksheet,
  title: string,
  rows: PrimaryParty[],
  startRow: number,
): number {
  const h1 = ws.getCell(startRow, 1);
  h1.value = title;
  h1.font = { bold: true };
  h1.fill = HEADER_FILL;
  ws.getCell(startRow, 2).fill = HEADER_FILL;
  ws.getCell(startRow, 2).value = "Amount";
  ws.getCell(startRow, 2).font = { bold: true };
  ws.getCell(startRow, 2).alignment = { horizontal: "right" };
  let r = startRow + 1;
  for (const p of rows) {
    ws.getCell(r, 1).value = p.party;
    ws.getCell(r, 2).value = p.amount;
    ws.getCell(r, 2).numFmt = FMT_INT;
    r++;
  }
  if (rows.length > 0) {
    const total = ws.getCell(r, 1);
    total.value = "Total";
    total.font = { bold: true };
    total.fill = TOTAL_FILL;
    const totalAmt = ws.getCell(r, 2);
    totalAmt.value = rows.reduce((a, p) => a + p.amount, 0);
    totalAmt.numFmt = FMT_INT;
    totalAmt.font = { bold: true };
    totalAmt.fill = TOTAL_FILL;
    r++;
  }
  return r;
}

export async function buildRepReportWorkbook(
  report: SalesRepReport,
  basis: "secondary" | "primary",
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = new Date();

  const thisFy = fyShort(report.fy);
  const lastFy = fyShort(report.priorFy);

  // --- Sheet 1: Cover ---
  {
    const ws = wb.addWorksheet("Cover");
    ws.getColumn(1).width = 26;
    ws.getColumn(2).width = 36;

    const title = ws.getCell(1, 1);
    title.value = "Prayag India — Sales Report";
    title.font = { bold: true, size: 14 };
    ws.mergeCells(1, 1, 1, 2);

    const t = report.secondary.tiles;
    const infoRows: [string, string | number | null][] = [
      ["Sales Person", report.repName],
      ["Fiscal Year", report.fy],
      ["Basis", basis === "primary" ? "Primary (SAP dispatched sale)" : "Secondary (order booking)"],
      ["Scope", report.scope === "team" ? "Own + rolled-up team" : "Own book only"],
      ["Generated", new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })],
      ["", ""],
      ["Net Order Booked", t.netOrderBooked],
      ["Prior FY Net", t.netOrderBookedLast],
      ["Growth", t.growthPct != null ? `${t.growthPct}%` : "n/a"],
      ["Orders", t.orders],
      ["Active Retailers", t.activeRetailers],
      ["New Retailers", t.newRetailers],
      ["Target", t.target],
      ["Achievement", t.achievementPct != null ? `${t.achievementPct}%` : "n/a"],
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
        `Bridge coverage is ${report.primary.bridgeCoverage.toFixed(1)}% for this ` +
        "head's register. Unbridged amounts are listed on the Primary Sale tab.";
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

    report.monthly.forEach((m, i) => {
      const rowNum = i + 2;
      ws.getCell(rowNum, 1).value = m.month;
      ws.getCell(rowNum, 2).value = m.orderAmount;
      ws.getCell(rowNum, 2).numFmt = FMT_INT;
      ws.getCell(rowNum, 3).value = m.orders;
      ws.getCell(rowNum, 4).value = m.saleAmount;
      ws.getCell(rowNum, 4).numFmt = FMT_INT;
    });

    const totalRow = 14;
    ws.getCell(totalRow, 1).value = "Total";
    ws.getCell(totalRow, 2).value = report.monthly.reduce((a, m) => a + m.orderAmount, 0);
    ws.getCell(totalRow, 2).numFmt = FMT_INT;
    ws.getCell(totalRow, 3).value = report.monthly.reduce((a, m) => a + m.orders, 0);
    ws.getCell(totalRow, 4).value = report.monthly.reduce((a, m) => a + m.saleAmount, 0);
    ws.getCell(totalRow, 4).numFmt = FMT_INT;
    for (let c = 1; c <= 4; c++) {
      ws.getCell(totalRow, c).fill = TOTAL_FILL;
      ws.getCell(totalRow, c).font = { bold: true };
    }
  }

  // --- Sheets 3-5: Comparison tables ---
  writeComparisonSheet(wb, "By State", report.secondary.byState, thisFy, lastFy);
  writeComparisonSheet(wb, "By Group", report.secondary.byGroup, thisFy, lastFy);
  writeComparisonSheet(wb, "By Segment", report.secondary.bySegment, thisFy, lastFy);

  // --- Sheets 6-8: Party tables ---
  writePartySheet(wb, "Top Parties", report.secondary.parties.top, thisFy, lastFy);
  writePartySheet(wb, "New Parties", report.secondary.parties.newTop, thisFy, lastFy);
  writePartySheet(wb, "Churned Parties", report.secondary.parties.churned, thisFy, lastFy);

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

    const movers = report.secondary.movers;
    for (let i = 0; i < Math.max(movers.partiesUp.length, movers.partiesDown.length); i++) {
      const rowNum = i + 2;
      const up = movers.partiesUp[i];
      const down = movers.partiesDown[i];
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

    const segOffset = Math.max(movers.partiesUp.length, movers.partiesDown.length) + 3;
    hdr(ws, segOffset, 1, "Segments Gaining");
    hdr(ws, segOffset, 2, "Gain (vs Prior FY)");
    hdr(ws, segOffset, 3, "Segments Declining");
    hdr(ws, segOffset, 4, "Decline (vs Prior FY)");
    for (let i = 0; i < Math.max(movers.segmentsUp.length, movers.segmentsDown.length); i++) {
      const rowNum = segOffset + i + 1;
      const up = movers.segmentsUp[i];
      const down = movers.segmentsDown[i];
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
  }

  // --- Sheet 10: Primary Sale ---
  {
    const ws = wb.addWorksheet("Primary Sale");
    ws.getColumn(1).width = 36;
    ws.getColumn(2).width = 18;

    const heading = ws.getCell(1, 1);
    heading.value = "SAP Dispatched Sale — Party TM Bridge";
    heading.font = { bold: true, size: 12 };
    ws.mergeCells(1, 1, 1, 2);

    const p = report.primary;
    if (!p.available) {
      ws.getCell(3, 1).value = p.reason ?? "Primary data not available.";
      ws.getCell(3, 1).font = { italic: true };
    } else {
      ws.getCell(3, 1).value = "Bridge coverage (this head)";
      ws.getCell(3, 1).font = { bold: true };
      ws.getCell(3, 2).value = p.headTotal > 0 ? p.bridgeCoverage / 100 : "No register data";
      if (p.headTotal > 0) ws.getCell(3, 2).numFmt = FMT_PCT;

      ws.getCell(4, 1).value = "Head register total";
      ws.getCell(4, 1).font = { bold: true };
      ws.getCell(4, 2).value = p.headTotal;
      ws.getCell(4, 2).numFmt = FMT_INT;

      ws.getCell(5, 1).value = "Bridged to this rep";
      ws.getCell(5, 1).font = { bold: true };
      ws.getCell(5, 2).value = p.totalBridged;
      ws.getCell(5, 2).numFmt = FMT_INT;

      let nextRow = writePrimaryPartyBlock(ws, "Bridged Parties", p.bridgedParties, 7);
      nextRow += 1;
      writePrimaryPartyBlock(ws, "Unbridged Parties (not mapped to any TM)", p.unbridgedParties, nextRow);
    }
  }

  return wb;
}
