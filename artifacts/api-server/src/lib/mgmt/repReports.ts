// Per-salesperson Excel report workbook builder.
//
// Produces a 10-tab xlsx matching the State-Head workbook format that
// management signs off against, scoped to a single salesperson.
//
// Tab layout (Cover + 9 content tabs):
//   Cover, Monthly Booking, By State, By Party, By Segment,
//   Item Code*, By Group, Parties, Movers, Sale & Collection
//
// *Item Code: populated from sale_line on Primary basis; labelled
//  "Not available on Secondary" when basis=secondary.
import ExcelJS from "exceljs";
import { fyShort } from "./names.js";
import type { SalesRepReport, PrimaryParty, ItemCodeRow, RepPartyRow, StateMonthRow, PartyGroupRow } from "./salesReports.js";
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
const GREY_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9D9D9" },
};
const FMT_INT = "#,##0";
const FMT_MONEY = '[<=9999999]##,##,##0;[>9999999]##,##,##,##0';
const FMT_PCT = "0.00%";
const FMT_PCT1 = "0.0%";

function hdr(ws: ExcelJS.Worksheet, row: number, col: number, text: string, width?: number): void {
  const cell = ws.getCell(row, col);
  cell.value = text;
  cell.fill = HEADER_FILL;
  cell.font = { bold: true, size: 9 };
  cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
  if (width !== undefined) ws.getColumn(col).width = width;
}

function totalCell(ws: ExcelJS.Worksheet, row: number, col: number, value: number, fmt: string): void {
  const cell = ws.getCell(row, col);
  cell.value = Math.round(value);
  cell.numFmt = fmt;
  cell.fill = TOTAL_FILL;
  cell.font = { bold: true };
}

function writeComparisonSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: DeepRow[],
  thisFyLabel: string,
  lastFyLabel: string,
  unitLabel = "Amount",
): void {
  const ws = wb.addWorksheet(name);
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const headers = [
    { label: "Name", width: 30 },
    { label: `${unitLabel} ${thisFyLabel}`, width: 16 },
    { label: `${unitLabel} ${lastFyLabel}`, width: 16 },
    { label: "Difference", width: 14 },
    { label: "Growth %", width: 11 },
    { label: "Share %", width: 11 },
  ];
  headers.forEach((c, i) => hdr(ws, 1, i + 1, c.label, c.width));

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.label;
    ws.getCell(rowNum, 2).value = Math.round(r.thisFy);
    ws.getCell(rowNum, 2).numFmt = FMT_MONEY;
    ws.getCell(rowNum, 3).value = Math.round(r.lastFy);
    ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
    ws.getCell(rowNum, 4).value = Math.round(r.diff);
    ws.getCell(rowNum, 4).numFmt = FMT_MONEY;
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
    ws.getCell(totalRow, 1).value = "Grand Total";
    ws.getCell(totalRow, 1).font = { bold: true };
    totalCell(ws, totalRow, 2, sumThis, FMT_MONEY);
    totalCell(ws, totalRow, 3, sumLast, FMT_MONEY);
    totalCell(ws, totalRow, 4, sumThis - sumLast, FMT_MONEY);
    ws.getCell(totalRow, 1).fill = TOTAL_FILL;
  }
}

function writePartyByStateSheet(
  wb: ExcelJS.Workbook,
  partyByState: Record<string, RepPartyRow[]>,
  stateOptions: string[],
  thisFyLabel: string,
  priorFyLabel: string,
): void {
  const ws = wb.addWorksheet("By Party");
  ws.views = [{ state: "frozen", ySplit: 2 }];
  hdr(ws, 1, 1, "State", 22);
  hdr(ws, 1, 2, "Party / Retailer", 34);
  hdr(ws, 1, 3, `Amount ${thisFyLabel}`, 16);
  hdr(ws, 1, 4, `Amount ${priorFyLabel}`, 16);
  hdr(ws, 1, 5, "Difference", 14);
  hdr(ws, 1, 6, "Growth %", 11);
  hdr(ws, 1, 7, "Share %", 11);

  let rowNum = 2;
  for (const state of stateOptions) {
    const parties = partyByState[state] ?? [];
    const stateTotal = parties.reduce((a, p) => a + p.amount, 0);
    const stateTotalPrior = parties.reduce((a, p) => a + p.priorAmount, 0);

    ws.mergeCells(rowNum, 1, rowNum, 7);
    const stHdr = ws.getCell(rowNum, 1);
    stHdr.value = state;
    stHdr.font = { bold: true, size: 9 };
    stHdr.fill = HEADER_FILL;
    rowNum++;

    parties.forEach((p) => {
      ws.getCell(rowNum, 1).value = state;
      ws.getCell(rowNum, 2).value = p.name;
      const diff = p.amount - p.priorAmount;
      const growthPct = p.priorAmount > 0 ? (diff / Math.abs(p.priorAmount)) : null;
      const sharePct = stateTotal > 0 ? p.amount / stateTotal : null;
      ws.getCell(rowNum, 3).value = Math.round(p.amount);
      ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
      ws.getCell(rowNum, 4).value = Math.round(p.priorAmount);
      ws.getCell(rowNum, 4).numFmt = FMT_MONEY;
      ws.getCell(rowNum, 5).value = Math.round(diff);
      ws.getCell(rowNum, 5).numFmt = FMT_MONEY;
      if (growthPct != null) { ws.getCell(rowNum, 6).value = growthPct; ws.getCell(rowNum, 6).numFmt = FMT_PCT; }
      if (sharePct != null) { ws.getCell(rowNum, 7).value = sharePct; ws.getCell(rowNum, 7).numFmt = FMT_PCT; }
      rowNum++;
    });

    if (parties.length > 0) {
      ws.getCell(rowNum, 2).value = "Total";
      ws.getCell(rowNum, 2).font = { bold: true };
      totalCell(ws, rowNum, 3, stateTotal, FMT_MONEY);
      totalCell(ws, rowNum, 4, stateTotalPrior, FMT_MONEY);
      totalCell(ws, rowNum, 5, stateTotal - stateTotalPrior, FMT_MONEY);
      ws.getCell(rowNum, 1).fill = TOTAL_FILL;
      ws.getCell(rowNum, 2).fill = TOTAL_FILL;
      rowNum++;
    }
    rowNum++;
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
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const headers = [
    { label: "Party / Retailer", width: 34 },
    { label: `Amount ${thisFyLabel}`, width: 16 },
    { label: `Amount ${lastFyLabel}`, width: 16 },
    { label: "Growth %", width: 11 },
    { label: "Share %", width: 11 },
    { label: "Status", width: 10 },
  ];
  headers.forEach((c, i) => hdr(ws, 1, i + 1, c.label, c.width));

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.label;
    ws.getCell(rowNum, 2).value = Math.round(r.thisFy);
    ws.getCell(rowNum, 2).numFmt = FMT_MONEY;
    ws.getCell(rowNum, 3).value = Math.round(r.lastFy);
    ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
    if (r.growthPct != null) {
      ws.getCell(rowNum, 4).value = r.growthPct / 100;
      ws.getCell(rowNum, 4).numFmt = FMT_PCT;
    }
    if (r.sharePct != null) {
      ws.getCell(rowNum, 5).value = r.sharePct / 100;
      ws.getCell(rowNum, 5).numFmt = FMT_PCT;
    }
    if (r.flag) ws.getCell(rowNum, 6).value = r.flag;
  });

  if (rows.length > 0) {
    const totalRow = rows.length + 2;
    const sumThis = rows.reduce((a, r) => a + r.thisFy, 0);
    const sumLast = rows.reduce((a, r) => a + r.lastFy, 0);
    ws.getCell(totalRow, 1).value = "Grand Total";
    ws.getCell(totalRow, 1).font = { bold: true };
    ws.getCell(totalRow, 1).fill = TOTAL_FILL;
    totalCell(ws, totalRow, 2, sumThis, FMT_MONEY);
    totalCell(ws, totalRow, 3, sumLast, FMT_MONEY);
  }
}

function writeItemCodeSheet(
  wb: ExcelJS.Workbook,
  byItemCode: ItemCodeRow[],
  basis: "secondary" | "primary",
  thisFyLabel: string,
): void {
  const ws = wb.addWorksheet("Item Code");
  ws.views = [{ state: "frozen", ySplit: 1 }];

  if (basis === "secondary") {
    hdr(ws, 1, 1, "Item Code", 16);
    hdr(ws, 1, 2, "Description", 32);
    hdr(ws, 1, 3, `Amount ${thisFyLabel}`, 18);
    ws.mergeCells(2, 1, 2, 3);
    const note = ws.getCell(2, 1);
    note.value =
      "Item-code breakdown is not available on Secondary basis. " +
      "The secondary order booking file records segment totals only, not individual item codes. " +
      "Switch to Primary basis to see item-code detail from the invoice register.";
    note.font = { italic: true, size: 9 };
    note.alignment = { wrapText: true, vertical: "top" };
    note.fill = GREY_FILL;
    ws.getRow(2).height = 60;
    return;
  }

  hdr(ws, 1, 1, "Item Code", 16);
  hdr(ws, 1, 2, "Description", 40);
  hdr(ws, 1, 3, `Dispatched Amount ${thisFyLabel}`, 20);
  hdr(ws, 1, 4, "Share %", 11);

  const totalAmount = byItemCode.reduce((a, r) => a + r.amount, 0);

  if (byItemCode.length === 0) {
    ws.mergeCells(2, 1, 2, 4);
    const note = ws.getCell(2, 1);
    note.value =
      "No item-code data matched this rep's bridged parties for the selected FY. " +
      "Ensure invoice registers are loaded via Data Sources.";
    note.font = { italic: true, size: 9 };
    note.fill = GREY_FILL;
    return;
  }

  byItemCode.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.code;
    ws.getCell(rowNum, 2).value = r.description;
    ws.getCell(rowNum, 3).value = Math.round(r.amount);
    ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
    if (totalAmount > 0) {
      ws.getCell(rowNum, 4).value = r.amount / totalAmount;
      ws.getCell(rowNum, 4).numFmt = FMT_PCT;
    }
  });

  const totalRow = byItemCode.length + 2;
  ws.getCell(totalRow, 2).value = "Grand Total";
  ws.getCell(totalRow, 2).font = { bold: true };
  ws.getCell(totalRow, 2).fill = TOTAL_FILL;
  totalCell(ws, totalRow, 3, totalAmount, FMT_MONEY);
  ws.getCell(totalRow, 4).value = 1;
  ws.getCell(totalRow, 4).numFmt = FMT_PCT;
  ws.getCell(totalRow, 4).fill = TOTAL_FILL;
  ws.getCell(totalRow, 4).font = { bold: true };
}

function writeSaleCollectionSheet(
  wb: ExcelJS.Workbook,
  saleCollection: { sale: number; saleLast: number; collection: number | null },
  thisFyLabel: string,
  lastFyLabel: string,
): void {
  const ws = wb.addWorksheet("Sale & Collection");
  ws.views = [{ state: "frozen", ySplit: 1 }];

  hdr(ws, 1, 1, "Metric", 30);
  hdr(ws, 1, 2, `${thisFyLabel}`, 16);
  hdr(ws, 1, 3, `${lastFyLabel}`, 16);
  hdr(ws, 1, 4, "Difference", 14);
  hdr(ws, 1, 5, "Growth %", 11);

  const saleDiff = saleCollection.sale - saleCollection.saleLast;
  const saleGrowth =
    saleCollection.saleLast > 0 ? saleDiff / Math.abs(saleCollection.saleLast) : null;

  ws.getCell(2, 1).value = "Sale (Net Secondary)";
  ws.getCell(2, 2).value = Math.round(saleCollection.sale);
  ws.getCell(2, 2).numFmt = FMT_MONEY;
  ws.getCell(2, 3).value = Math.round(saleCollection.saleLast);
  ws.getCell(2, 3).numFmt = FMT_MONEY;
  ws.getCell(2, 4).value = Math.round(saleDiff);
  ws.getCell(2, 4).numFmt = FMT_MONEY;
  if (saleGrowth != null) {
    ws.getCell(2, 5).value = saleGrowth;
    ws.getCell(2, 5).numFmt = FMT_PCT1;
  }

  if (saleCollection.collection != null) {
    ws.getCell(3, 1).value = "Collection (YTD)";
    ws.getCell(3, 2).value = Math.round(saleCollection.collection);
    ws.getCell(3, 2).numFmt = FMT_MONEY;
    ws.getCell(3, 3).value = "";
    ws.getCell(3, 4).value = "";
    ws.getCell(3, 5).value = "";
  } else {
    ws.getCell(3, 1).value = "Collection";
    [2, 3, 4, 5].forEach((c) => { ws.getCell(3, c).fill = GREY_FILL; });
    ws.mergeCells(3, 2, 3, 5);
    const collNote = ws.getCell(3, 2);
    collNote.value = "Pending data source — collection is not yet wired for this salesperson";
    collNote.font = { italic: true, size: 9 };
    collNote.fill = GREY_FILL;
    collNote.alignment = { horizontal: "left" };
  }

  ws.getColumn(1).width = 30;
}

function writePrimaryPartySheet(
  wb: ExcelJS.Workbook,
  name: string,
  parties: PrimaryParty[],
  thisFyLabel: string,
  note?: string,
): void {
  const ws = wb.addWorksheet(name);
  ws.views = [{ state: "frozen", ySplit: 1 }];
  hdr(ws, 1, 1, "Party / Retailer", 34);
  hdr(ws, 1, 2, `Dispatched Amount ${thisFyLabel}`, 20);
  hdr(ws, 1, 3, "Share %", 11);

  if (note) {
    ws.mergeCells(2, 1, 2, 3);
    ws.getCell(2, 1).value = note;
    ws.getCell(2, 1).font = { italic: true, size: 9 };
    ws.getCell(2, 1).fill = GREY_FILL;
    return;
  }

  const totalAmount = parties.reduce((a, p) => a + p.amount, 0);
  parties.forEach((p, pi) => {
    const rowNum = pi + 2;
    ws.getCell(rowNum, 1).value = p.party;
    ws.getCell(rowNum, 2).value = Math.round(p.amount);
    ws.getCell(rowNum, 2).numFmt = FMT_MONEY;
    if (totalAmount > 0) {
      ws.getCell(rowNum, 3).value = p.amount / totalAmount;
      ws.getCell(rowNum, 3).numFmt = FMT_PCT;
    }
  });
  if (parties.length > 0) {
    const totalRow = parties.length + 2;
    ws.getCell(totalRow, 1).value = "Grand Total";
    ws.getCell(totalRow, 1).font = { bold: true };
    ws.getCell(totalRow, 1).fill = TOTAL_FILL;
    totalCell(ws, totalRow, 2, totalAmount, FMT_MONEY);
    const tp = ws.getCell(totalRow, 3);
    tp.value = 1;
    tp.numFmt = FMT_PCT;
    tp.fill = TOTAL_FILL;
    tp.font = { bold: true };
  }
}

function writeStateMonthSheet(
  wb: ExcelJS.Workbook,
  rows: StateMonthRow[],
  thisFyLabel: string,
  priorFyLabel: string,
): void {
  const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  const ws = wb.addWorksheet("By State Monthly");
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  hdr(ws, 1, 1, "State", 22);
  hdr(ws, 1, 2, `Total ${thisFyLabel}`, 16);
  hdr(ws, 1, 3, `Total ${priorFyLabel}`, 16);
  hdr(ws, 1, 4, "Growth %", 11);
  MONTHS.forEach((m, i) => hdr(ws, 1, 5 + i, m, 12));

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.state;
    ws.getCell(rowNum, 2).value = Math.round(r.thisFy);
    ws.getCell(rowNum, 2).numFmt = FMT_MONEY;
    ws.getCell(rowNum, 3).value = Math.round(r.lastFy);
    ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
    if (r.growthPct != null) {
      ws.getCell(rowNum, 4).value = r.growthPct / 100;
      ws.getCell(rowNum, 4).numFmt = FMT_PCT;
    }
    r.months.forEach((v, i) => {
      if (v > 0) {
        ws.getCell(rowNum, 5 + i).value = Math.round(v);
        ws.getCell(rowNum, 5 + i).numFmt = FMT_MONEY;
      }
    });
  });

  if (rows.length > 0) {
    const totalRow = rows.length + 2;
    ws.getCell(totalRow, 1).value = "Grand Total";
    ws.getCell(totalRow, 1).font = { bold: true };
    ws.getCell(totalRow, 1).fill = TOTAL_FILL;
    totalCell(ws, totalRow, 2, rows.reduce((a, r) => a + r.thisFy, 0), FMT_MONEY);
    totalCell(ws, totalRow, 3, rows.reduce((a, r) => a + r.lastFy, 0), FMT_MONEY);
    MONTHS.forEach((_, i) => {
      const colTotal = rows.reduce((a, r) => a + (r.months[i] ?? 0), 0);
      if (colTotal > 0) totalCell(ws, totalRow, 5 + i, colTotal, FMT_MONEY);
    });
  }
}

function writeGroupByStateSheet(
  wb: ExcelJS.Workbook,
  byGroupByState: Record<string, DeepRow[]>,
  stateOptions: string[],
  thisFyLabel: string,
  priorFyLabel: string,
): void {
  const ws = wb.addWorksheet("By Group By State");
  ws.views = [{ state: "frozen", ySplit: 2 }];
  hdr(ws, 1, 1, "State", 22);
  hdr(ws, 1, 2, "Group", 30);
  hdr(ws, 1, 3, `Amount ${thisFyLabel}`, 16);
  hdr(ws, 1, 4, `Amount ${priorFyLabel}`, 16);
  hdr(ws, 1, 5, "Difference", 14);
  hdr(ws, 1, 6, "Growth %", 11);
  hdr(ws, 1, 7, "Share %", 11);

  let rowNum = 2;
  for (const state of stateOptions) {
    const groups = byGroupByState[state] ?? [];
    if (groups.length === 0) continue;
    const stateTotal = groups.reduce((a, r) => a + r.thisFy, 0);

    ws.mergeCells(rowNum, 1, rowNum, 7);
    const stHdr = ws.getCell(rowNum, 1);
    stHdr.value = state;
    stHdr.font = { bold: true, size: 9 };
    stHdr.fill = HEADER_FILL;
    rowNum++;

    groups.forEach((r) => {
      ws.getCell(rowNum, 1).value = state;
      ws.getCell(rowNum, 2).value = r.label;
      ws.getCell(rowNum, 3).value = Math.round(r.thisFy);
      ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
      ws.getCell(rowNum, 4).value = Math.round(r.lastFy);
      ws.getCell(rowNum, 4).numFmt = FMT_MONEY;
      ws.getCell(rowNum, 5).value = Math.round(r.diff);
      ws.getCell(rowNum, 5).numFmt = FMT_MONEY;
      if (r.growthPct != null) { ws.getCell(rowNum, 6).value = r.growthPct / 100; ws.getCell(rowNum, 6).numFmt = FMT_PCT; }
      if (r.sharePct != null) { ws.getCell(rowNum, 7).value = r.sharePct / 100; ws.getCell(rowNum, 7).numFmt = FMT_PCT; }
      rowNum++;
    });

    if (groups.length > 0) {
      ws.getCell(rowNum, 2).value = "Total";
      ws.getCell(rowNum, 2).font = { bold: true };
      totalCell(ws, rowNum, 3, stateTotal, FMT_MONEY);
      ws.getCell(rowNum, 1).fill = TOTAL_FILL;
      ws.getCell(rowNum, 2).fill = TOTAL_FILL;
      rowNum++;
    }
    rowNum++;
  }
}

function writePartyGroupMatrixSheet(
  wb: ExcelJS.Workbook,
  rows: PartyGroupRow[],
  thisFyLabel: string,
): void {
  const groupCols = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r.byGroup))),
  ).sort();

  const ws = wb.addWorksheet("Party By Group");
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  hdr(ws, 1, 1, "Party", 32);
  hdr(ws, 1, 2, "State", 18);
  hdr(ws, 1, 3, `Total ${thisFyLabel}`, 16);
  groupCols.forEach((g, i) => hdr(ws, 1, 4 + i, g, 16));

  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    ws.getCell(rowNum, 1).value = r.party;
    ws.getCell(rowNum, 2).value = r.state || "";
    ws.getCell(rowNum, 3).value = Math.round(r.total);
    ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
    groupCols.forEach((g, i) => {
      const v = r.byGroup[g] ?? 0;
      if (v > 0) {
        ws.getCell(rowNum, 4 + i).value = Math.round(v);
        ws.getCell(rowNum, 4 + i).numFmt = FMT_MONEY;
      }
    });
  });

  if (rows.length > 0) {
    const totalRow = rows.length + 2;
    ws.getCell(totalRow, 1).value = "Grand Total";
    ws.getCell(totalRow, 1).font = { bold: true };
    ws.getCell(totalRow, 1).fill = TOTAL_FILL;
    totalCell(ws, totalRow, 3, rows.reduce((a, r) => a + r.total, 0), FMT_MONEY);
    groupCols.forEach((g, i) => {
      const colTotal = rows.reduce((a, r) => a + (r.byGroup[g] ?? 0), 0);
      if (colTotal > 0) totalCell(ws, totalRow, 4 + i, colTotal, FMT_MONEY);
    });
  }
}

function writeCoverSheet(
  wb: ExcelJS.Workbook,
  report: SalesRepReport,
  basis: "secondary" | "primary",
  today: string,
): void {
  const ws = wb.addWorksheet("Cover");
  const s = fyShort(report.fy);
  const prior = fyShort(report.priorFy);

  const title = ws.getCell(2, 2);
  title.value = `${report.repName} — Sales Report`;
  title.font = { bold: true, size: 16 };
  ws.getCell(3, 2).value = `${report.fy} vs ${report.priorFy}  |  ${report.scope === "team" ? "Own + Team" : "Own book"}  |  Basis: ${basis}`;
  ws.getCell(3, 2).font = { size: 10 };
  ws.getCell(4, 2).value = `Generated: ${today}`;
  ws.getCell(4, 2).font = { size: 9, color: { argb: "FF808080" } };

  const sec = report.secondary;
  ws.getCell(6, 2).value = "Net Order Booked";
  ws.getCell(6, 3).value = Math.round(sec.tiles.netOrderBooked);
  ws.getCell(6, 3).numFmt = FMT_MONEY;
  ws.getCell(7, 2).value = `Last FY (${prior})`;
  ws.getCell(7, 3).value = Math.round(sec.tiles.netOrderBookedLast);
  ws.getCell(7, 3).numFmt = FMT_MONEY;
  ws.getCell(8, 2).value = "Growth %";
  if (sec.tiles.growthPct != null) {
    ws.getCell(8, 3).value = sec.tiles.growthPct / 100;
    ws.getCell(8, 3).numFmt = FMT_PCT1;
  }
  ws.getCell(9, 2).value = "Orders";
  ws.getCell(9, 3).value = sec.tiles.orders;
  ws.getCell(9, 3).numFmt = FMT_INT;
  ws.getCell(10, 2).value = "Active Retailers";
  ws.getCell(10, 3).value = sec.tiles.activeRetailers;
  ws.getCell(10, 3).numFmt = FMT_INT;
  ws.getCell(11, 2).value = "New Retailers";
  ws.getCell(11, 3).value = sec.tiles.newRetailers;
  ws.getCell(11, 3).numFmt = FMT_INT;

  // Reconciliation
  const rec = report.reconciliation;
  ws.getCell(13, 2).value = "Reconciliation";
  ws.getCell(13, 2).font = { bold: true };
  ws.getCell(14, 2).value = "Secondary cross-foot";
  ws.getCell(14, 3).value = rec.secondary.note;
  ws.getCell(14, 3).font = { color: { argb: rec.secondary.ok ? "FF008000" : "FFCC0000" }, size: 9 };
  ws.getCell(15, 2).value = "Primary cross-foot";
  ws.getCell(15, 3).value = rec.primary.note;
  ws.getCell(15, 3).font = { color: { argb: rec.primary.ok ? "FF008000" : "FFCC0000" }, size: 9 };

  ws.getColumn(2).width = 24;
  ws.getColumn(3).width = 60;
}

export async function buildRepReportWorkbook(
  report: SalesRepReport,
  basis: "secondary" | "primary",
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = new Date();

  const s = fyShort(report.fy);
  const prior = fyShort(report.priorFy);
  const today = new Date().toISOString().slice(0, 10);
  const sec = report.secondary;

  // --- Cover ---
  writeCoverSheet(wb, report, basis, today);

  // --- Monthly Booking ---
  {
    const ws = wb.addWorksheet("Monthly Booking");
    ws.views = [{ state: "frozen", ySplit: 1 }];
    hdr(ws, 1, 1, "Month", 12);
    hdr(ws, 1, 2, `Order Amount (${s})`, 18);
    hdr(ws, 1, 3, "Orders", 10);
    hdr(ws, 1, 4, `Sale Amount (${s})`, 18);

    let totOrder = 0, totOrders = 0, totSale = 0;
    report.monthly.forEach((m, mi) => {
      const rowNum = mi + 2;
      ws.getCell(rowNum, 1).value = m.month;
      ws.getCell(rowNum, 2).value = Math.round(m.orderAmount);
      ws.getCell(rowNum, 2).numFmt = FMT_MONEY;
      ws.getCell(rowNum, 3).value = m.orders;
      ws.getCell(rowNum, 3).numFmt = FMT_INT;
      ws.getCell(rowNum, 4).value = Math.round(m.saleAmount);
      ws.getCell(rowNum, 4).numFmt = FMT_MONEY;
      totOrder += m.orderAmount;
      totOrders += m.orders;
      totSale += m.saleAmount;
    });
    const totalRow = report.monthly.length + 2;
    ws.getCell(totalRow, 1).value = "Grand Total";
    ws.getCell(totalRow, 1).font = { bold: true };
    ws.getCell(totalRow, 1).fill = TOTAL_FILL;
    totalCell(ws, totalRow, 2, totOrder, FMT_MONEY);
    ws.getCell(totalRow, 3).value = totOrders;
    ws.getCell(totalRow, 3).numFmt = FMT_INT;
    ws.getCell(totalRow, 3).fill = TOTAL_FILL;
    ws.getCell(totalRow, 3).font = { bold: true };
    totalCell(ws, totalRow, 4, totSale, FMT_MONEY);
  }

  // --- By State (Report 2: YoY totals) ---
  writeComparisonSheet(wb, "By State", sec.byState, s, prior);

  // --- By State Monthly (Report 2: month-by-month grid) ---
  writeStateMonthSheet(wb, sec.byStateByMonth, s, prior);

  // --- By Party (Report 3B): cross-state party breakdown ---
  writePartyByStateSheet(wb, sec.partyByState, report.stateOptions, s, prior);

  // --- By Group By State (Report 3A) ---
  writeGroupByStateSheet(wb, sec.byGroupByState, report.stateOptions, s, prior);

  // --- By Segment (Report 3C) ---
  writeComparisonSheet(wb, "By Segment", sec.bySegment, s, prior);

  // --- Item Code (Report 4) ---
  writeItemCodeSheet(
    wb,
    basis === "primary" ? (report.primary.byItemCode ?? []) : [],
    basis,
    s,
  );

  // --- By Group (Report 6: all states) ---
  writeComparisonSheet(wb, "By Group", sec.byGroup, s, prior);

  // --- Party × Group Matrix (Report 7) ---
  writePartyGroupMatrixSheet(wb, sec.partyGroupMatrix, s);

  // --- Parties (Top / New / Churned) ---
  {
    const ws = wb.addWorksheet("Parties");
    ws.views = [{ state: "frozen", ySplit: 1 }];
    hdr(ws, 1, 1, "Category", 14);
    hdr(ws, 1, 2, "Party / Retailer", 34);
    hdr(ws, 1, 3, `Amount ${s}`, 16);
    hdr(ws, 1, 4, `Amount ${prior}`, 16);
    hdr(ws, 1, 5, "Growth %", 11);
    hdr(ws, 1, 6, "Status", 10);

    let rowNum = 2;
    const sections: { label: string; rows: typeof sec.parties.top }[] = [
      { label: "Top Parties", rows: sec.parties.top },
      { label: `New Parties (${sec.parties.newCount})`, rows: sec.parties.newTop },
      { label: `Churned Parties (${sec.parties.churnedCount})`, rows: sec.parties.churned },
    ];
    for (const { label, rows } of sections) {
      ws.mergeCells(rowNum, 1, rowNum, 6);
      const secHdr = ws.getCell(rowNum, 1);
      secHdr.value = label;
      secHdr.font = { bold: true, size: 9 };
      secHdr.fill = HEADER_FILL;
      rowNum++;
      rows.forEach((r) => {
        ws.getCell(rowNum, 1).value = label;
        ws.getCell(rowNum, 2).value = r.label;
        ws.getCell(rowNum, 3).value = Math.round(r.thisFy);
        ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
        ws.getCell(rowNum, 4).value = Math.round(r.lastFy);
        ws.getCell(rowNum, 4).numFmt = FMT_MONEY;
        if (r.growthPct != null) {
          ws.getCell(rowNum, 5).value = r.growthPct / 100;
          ws.getCell(rowNum, 5).numFmt = FMT_PCT;
        }
        if (r.flag) ws.getCell(rowNum, 6).value = r.flag;
        rowNum++;
      });
      // Section total
      const secTotal = rows.reduce((a, r) => a + r.thisFy, 0);
      ws.getCell(rowNum, 2).value = "Total";
      ws.getCell(rowNum, 2).font = { bold: true };
      ws.getCell(rowNum, 2).fill = TOTAL_FILL;
      totalCell(ws, rowNum, 3, secTotal, FMT_MONEY);
      rowNum += 2;
    }
  }

  // --- Movers ---
  {
    const ws = wb.addWorksheet("Movers");
    ws.views = [{ state: "frozen", ySplit: 1 }];
    hdr(ws, 1, 1, "Category", 20);
    hdr(ws, 1, 2, "Name", 32);
    hdr(ws, 1, 3, `Amount ${s}`, 16);
    hdr(ws, 1, 4, `Amount ${prior}`, 16);
    hdr(ws, 1, 5, "Difference", 14);
    hdr(ws, 1, 6, "Growth %", 11);

    let rowNum = 2;
    const moverSections: { label: string; rows: typeof sec.movers.partiesUp }[] = [
      { label: "Parties Gaining", rows: sec.movers.partiesUp },
      { label: "Parties Declining", rows: sec.movers.partiesDown },
      { label: "Segments Gaining", rows: sec.movers.segmentsUp },
      { label: "Segments Declining", rows: sec.movers.segmentsDown },
    ];
    for (const { label, rows } of moverSections) {
      ws.mergeCells(rowNum, 1, rowNum, 6);
      const mvHdr = ws.getCell(rowNum, 1);
      mvHdr.value = label;
      mvHdr.font = { bold: true, size: 9 };
      mvHdr.fill = HEADER_FILL;
      rowNum++;
      rows.forEach((r) => {
        ws.getCell(rowNum, 1).value = label;
        ws.getCell(rowNum, 2).value = r.label;
        ws.getCell(rowNum, 3).value = Math.round(r.thisFy);
        ws.getCell(rowNum, 3).numFmt = FMT_MONEY;
        ws.getCell(rowNum, 4).value = Math.round(r.lastFy);
        ws.getCell(rowNum, 4).numFmt = FMT_MONEY;
        ws.getCell(rowNum, 5).value = Math.round(r.diff);
        ws.getCell(rowNum, 5).numFmt = FMT_MONEY;
        if (r.growthPct != null) {
          ws.getCell(rowNum, 6).value = r.growthPct / 100;
          ws.getCell(rowNum, 6).numFmt = FMT_PCT;
        }
        rowNum++;
      });
      rowNum++;
    }
  }

  // --- Sale & Collection (Report 9) ---
  writeSaleCollectionSheet(wb, sec.saleCollection, s, prior);

  // --- Primary Sale (informational; always included) ---
  if (basis === "primary" && report.primary.available) {
    writePrimaryPartySheet(
      wb,
      "Primary — Bridged",
      report.primary.bridgedParties,
      s,
    );
    writePrimaryPartySheet(
      wb,
      "Primary — Unbridged",
      report.primary.unbridgedParties,
      s,
      report.primary.unbridgedParties.length === 0
        ? "No unbridged parties for this rep and FY."
        : undefined,
    );
  } else if (basis === "primary") {
    const ws = wb.addWorksheet("Primary Sale");
    ws.getCell(1, 1).value = report.primary.reason ?? "Primary data not available.";
    ws.getCell(1, 1).font = { italic: true, size: 9 };
  }

  return wb;
}
