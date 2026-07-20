// Exports the July DB-gap rows (rows present in sale_line for a month but
// absent from the live SALE SHEET) as a two-sheet xlsx workbook for human review.
//
// Sheet 1 — "Disputed Rows":
//   Columns A-R mirror the SALE SHEET 26-27 column order so rows can be
//   pasted straight back if confirmed.  Columns S-W are review metadata.
//
// Sheet 2 — "Summary":
//   By customer, by invoice, by branch, by state head, total.
//   Partial invoices (some lines removed, some still in sheet) are listed
//   prominently — they are the strongest evidence of an accidental edit.

import ExcelJS from "exceljs";
import { db, saleLines, itemMaster, ingestRuns } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { listSheetTabs, readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import rawRegisterSheets from "../../../config/register_sheets.json";
import { logger } from "../logger.js";
import { reconcileDbVsSaleSheet } from "./reconcileSheets.js";

type RegisterConfig = {
  sap_source: Record<string, string>;
};
const _cfg = rawRegisterSheets as unknown as RegisterConfig;

// ── Small helpers (do not import from reconcileSheets to keep this file standalone) ──

function normInv(s: string | null | undefined): string {
  return (s ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function strV(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function parseIsoDate(v: SheetCellValue | undefined): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 40_000 && v < 70_000) {
    const d = new Date(Math.round((v - 25569) * 86_400_000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const day = Number(m[1]), mon = Number(m[2]);
    let yr = Number(m[3]);
    if (m[3].length === 2) yr += 2000;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31)
      return `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const iso = new Date(s);
  return isNaN(iso.getTime()) ? null : iso.toISOString().slice(0, 10);
}

// Invoice prefix → branch name.
// Convention: first digit of invoice number is the branch code.
// 1=Bhiwadi, 2/3/4=Delhi, 5=Gujarat, 6/7=Andal
const BRANCH_LABELS: Record<string, string> = {
  "1": "Bhiwadi",
  "2": "Delhi",
  "3": "Delhi",
  "4": "Delhi",
  "5": "Gujarat",
  "6": "Andal",
  "7": "Andal",
};

function branchFromInvoice(invoiceNo: string | null): string {
  const s = (invoiceNo ?? "").trim();
  const m = s.match(/^[^0-9]*([1-9])/);
  if (!m) return "";
  const d = m[1];
  const label = BRANCH_LABELS[d];
  return label ? `${d} — ${label}` : d;
}

function numericBranch(invoiceNo: string | null): string {
  const s = (invoiceNo ?? "").trim();
  const m = s.match(/^[^0-9]*([1-9])/);
  return m ? m[1] : "";
}

// ── SAP Combined-tab invoice-number lookup ────────────────────────────────────
// Reads the "Combined" tab (or falls back to the monthly tab) from the SAP
// source workbook and returns the set of normalised invoice numbers present.
// Date-filter is applied to the combined tab so only the requested month's rows
// are included in the set.

type MonthFilter = { year: number; month: number };

function monthLabelToFilter(monthLabel: string): MonthFilter | null {
  const MONTHS: Record<string, number> = {
    Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
    Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
  };
  const [abbr, yr] = monthLabel.split("-");
  const mon = abbr ? MONTHS[abbr.slice(0, 3)] : undefined;
  const year = yr ? (Number(yr) < 100 ? 2000 + Number(yr) : Number(yr)) : undefined;
  if (!mon || !year) return null;
  return { year, month: mon };
}

// Extra SAP Business One field aliases beyond what reconcileSheets.ts uses.
// SAP B1 raw exports commonly name the billing document column "Document Number"
// or "Document No" (normalises to DOCUMENTNUMBER / DOCUMENTNO).
const INVOICE_ALIASES = [
  "INVOICENO", "INVOICENUMBER", "BILLINGDOCUMENT", "INVOICE",
  "BILLNO", "DOCUMENTNO", "DOCUMENTNUMBER", "DOCNO", "DOCNUM",
  "BILLDOCNO", "BILLNUMBER",
];
const DATE_ALIASES = ["DATE", "INVOICEDATE", "BILLINGDATE", "BILLDATE", "POSTINGDATE"];

async function loadSapInvoiceSet(
  fy: string,
  monthLabel: string,
): Promise<{ set: Set<string>; loaded: boolean; invoiceColFound: boolean }> {
  const sapId = _cfg.sap_source?.[fy];
  if (!sapId) {
    logger.warn({ fy }, "exportXlsx: no SAP source configured, inSapSource will be unknown");
    return { set: new Set(), loaded: false, invoiceColFound: false };
  }

  const monthFilter = monthLabelToFilter(monthLabel);
  const invoices = new Set<string>();

  try {
    const tabs = await listSheetTabs(sapId);
    const combined = tabs.find((t) => /^combined$/i.test(t.title.trim()));
    const tabTitle = combined?.title ?? null;

    if (!tabTitle) {
      logger.warn({ sapId, monthLabel }, "exportXlsx: no Combined tab in SAP workbook");
      return { set: invoices, loaded: false, invoiceColFound: false };
    }

    // Separate header-found (any anchoring column) from invoice-col-found.
    // The SAP sheet has many columns; we require at least an amount/qty column
    // to know we are on the right row, but the invoice column may be absent.
    let headerFound = false;
    let invoiceIdx = -1;
    let dateIdx = -1;
    let amtIdx = -1; // used as the header-anchor (must exist)

    const AMT_ALIASES = ["TAXABLEVALUE", "TAXABLEAMOUNT", "NETVALUE", "AMOUNT", "ASSESSABLEVALUE", "PRICEBEFDI", "LINEAMOUNT"];

    await readTabRowsChunked(sapId, tabTitle, (chunk, startRow) => {
      for (let ri = 0; ri < chunk.length; ri++) {
        const row = chunk[ri];
        const globalRow = startRow + ri;

        if (!headerFound) {
          if (globalRow > 25) continue;
          const hd = row.map((v) => strV(v).toUpperCase().replace(/[^A-Z0-9]/g, ""));
          const aI = AMT_ALIASES.reduce((best, a) => (best >= 0 ? best : hd.indexOf(a)), -1);
          if (aI < 0) continue; // not a header row we can anchor on
          amtIdx = aI;
          invoiceIdx = INVOICE_ALIASES.reduce((best, a) => (best >= 0 ? best : hd.indexOf(a)), -1);
          dateIdx = DATE_ALIASES.reduce((best, a) => (best >= 0 ? best : hd.indexOf(a)), -1);
          headerFound = true;
          continue;
        }

        // Skip if no invoice column was found — we can't build the set
        if (invoiceIdx < 0) continue;

        const inv = strV(row[invoiceIdx]);
        if (!inv) continue;

        if (monthFilter && dateIdx >= 0) {
          const rawDate = parseIsoDate(row[dateIdx]);
          if (rawDate) {
            const d = new Date(rawDate + "T00:00:00Z");
            if (d.getUTCFullYear() !== monthFilter.year || d.getUTCMonth() + 1 !== monthFilter.month) continue;
          }
        }

        invoices.add(normInv(inv));
      }
    });

    logger.info(
      { sapId, tab: tabTitle, invoiceCount: invoices.size, invoiceColFound: invoiceIdx >= 0, monthFilter },
      "exportXlsx: SAP invoice set loaded",
    );
    return { set: invoices, loaded: true, invoiceColFound: invoiceIdx >= 0 };
  } catch (err) {
    logger.warn({ err, sapId, fy, monthLabel }, "exportXlsx: SAP invoice set load failed");
    return { set: invoices, loaded: false, invoiceColFound: false };
  }
}

// ── Excel styling helpers ─────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F3864" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: "FFFFFFFF" }, bold: true, size: 10 };
const REVIEW_HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF4A235A" },
};
const SAP_YES_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD5F5E3" },
};
const SAP_NO_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFDE8E8" },
};
const PARTIAL_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF3CD" },
};
const SECTION_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF0F0F0" },
};

function styleHeaderRow(row: ExcelJS.Row, isReview = false): void {
  row.eachCell((cell) => {
    cell.fill = isReview ? REVIEW_HEADER_FILL : HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF999999" } },
    };
  });
  row.height = 30;
}

function sectionHeader(ws: ExcelJS.Worksheet, cols: number, label: string): ExcelJS.Row {
  const row = ws.addRow([label]);
  row.getCell(1).font = { bold: true, size: 11, color: { argb: "FF1F3864" } };
  if (cols > 1) ws.mergeCells(row.number, 1, row.number, cols);
  return row;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function exportDbGapAsXlsx(fy: string, monthLabel: string): Promise<Buffer> {
  logger.info({ fy, monthLabel }, "exportXlsx: starting");

  // 1. Run the gap reconciliation — this also reads the live SALE SHEET so
  //    we know which rows are genuinely absent (not just unread).
  const gapResult = await reconcileDbVsSaleSheet(fy, monthLabel);
  const gapLineUids = new Set(gapResult.dbOnly.detail.map((r) => r.lineUid));

  // 2. Fetch ALL DB rows for this month (needed for partial-invoice detection
  //    and for all the extra columns not in DbGapRow).
  const allMonthRows = await db
    .select({
      lineUid: saleLines.lineUid,
      serialNo: saleLines.serialNo,
      invoiceNo: saleLines.invoiceNo,
      invoiceDate: saleLines.invoiceDate,
      customer: saleLines.customer,
      code: saleLines.code,
      qty: saleLines.qty,
      saleRate: saleLines.saleRate,
      amount: saleLines.amount,
      groupRaw: saleLines.groupRaw,
      station: saleLines.station,
      stateRaw: saleLines.stateRaw,
      headRaw: saleLines.headRaw,
      monthLabel: saleLines.monthLabel,
      ingestedAt: saleLines.ingestedAt,
      source: saleLines.source,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, monthLabel)));

  // Separate gap rows; keep total count per invoice for partial detection.
  const gapRows = allMonthRows.filter((r) => gapLineUids.has(r.lineUid));
  const totalLinesPerInvoice = new Map<string, number>();
  for (const r of allMonthRows) {
    const k = normInv(r.invoiceNo);
    totalLinesPerInvoice.set(k, (totalLinesPerInvoice.get(k) ?? 0) + 1);
  }

  // 3. MRP lookup from item_master.
  const allCodes = [...new Set(gapRows.map((r) => r.code))];
  const mrpMap = new Map<string, string>();
  if (allCodes.length > 0) {
    const items = await db
      .select({ code: itemMaster.code, mrp: itemMaster.mrp })
      .from(itemMaster);
    for (const item of items) {
      if (item.mrp != null) mrpMap.set(item.code, item.mrp);
    }
  }

  // 4. Ingest run lookup — match each gap row to the run whose startedAt ≤
  //    row.ingestedAt (latest such run).
  const runs = await db
    .select({ id: ingestRuns.id, startedAt: ingestRuns.startedAt })
    .from(ingestRuns)
    .where(eq(ingestRuns.fy, fy));
  runs.sort((a, b) => {
    const ta = a.startedAt ? a.startedAt.getTime() : 0;
    const tb = b.startedAt ? b.startedAt.getTime() : 0;
    return ta - tb;
  });

  function findRunId(ingestedAt: Date | null): number | null {
    if (!ingestedAt) return null;
    let best: number | null = null;
    for (const r of runs) {
      if (r.startedAt && r.startedAt.getTime() <= ingestedAt.getTime()) best = r.id;
    }
    return best;
  }

  // 5. SAP invoice set — may be empty if the workbook is unavailable.
  const [sapResult] = await Promise.all([loadSapInvoiceSet(fy, monthLabel)]);
  const sapInvoices = sapResult.set;
  const sapLoaded = sapResult.loaded;
  // sapCanLookup: loaded AND the invoice-number column was found.
  // When false, every row shows "unknown" rather than a misleading "no".
  const sapCanLookup = sapResult.loaded && sapResult.invoiceColFound;

  // ── Sort: Customer → Invoice No → Serial No ──
  gapRows.sort((a, b) => {
    const c1 = (a.customer ?? "").localeCompare(b.customer ?? "");
    if (c1 !== 0) return c1;
    const c2 = normInv(a.invoiceNo).localeCompare(normInv(b.invoiceNo));
    if (c2 !== 0) return c2;
    return (a.serialNo ?? 0) - (b.serialNo ?? 0);
  });

  // ── Build workbook ─────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = new Date();

  // ── Sheet 1: Disputed rows ─────────────────────────────────────────────────
  const ws1 = wb.addWorksheet("Disputed Rows", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  const PASTE_HEADERS = [
    "Serial No",
    "Invoice No",
    "Date",
    "Bill From",
    "Customer Name",
    "City",
    "Destination",
    "Item Code",
    "Color",
    "Quantity",
    "MRP",
    "Sale Rate",
    "Taxable Value",
    "GROUP",
    "STATION",
    "STATE",
    "STATE HEAD",
    "MONTH",
  ];
  const REVIEW_HEADERS = [
    "lineUid",
    "ingestedAt",
    "ingestRunId",
    "branchFromInvoice",
    "inSapSource",
  ];

  const allHeaders = [...PASTE_HEADERS, ...REVIEW_HEADERS];
  ws1.addRow(allHeaders);
  styleHeaderRow(ws1.lastRow!);

  // Review columns start at col 19 (1-based)
  const reviewStart = PASTE_HEADERS.length + 1;
  for (let c = reviewStart; c <= allHeaders.length; c++) {
    const cell = ws1.lastRow!.getCell(c);
    cell.fill = REVIEW_HEADER_FILL;
  }

  // Freeze header row
  ws1.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }];

  // Column widths (approximations for the two groups)
  const colWidths = [
    8, 20, 12, 16, 30, 14, 14, 12, 10, 10, 10, 10, 14, 14, 14, 14, 20, 10,
    // review
    36, 22, 12, 18, 14,
  ];
  colWidths.forEach((w, i) => {
    ws1.getColumn(i + 1).width = w;
  });

  // Count by invoice for partial detection
  const gapLinesPerInvoice = new Map<string, number>();
  for (const r of gapRows) {
    const k = normInv(r.invoiceNo);
    gapLinesPerInvoice.set(k, (gapLinesPerInvoice.get(k) ?? 0) + 1);
  }

  function isPartialInvoice(invoiceNo: string | null): boolean {
    const k = normInv(invoiceNo);
    const gap = gapLinesPerInvoice.get(k) ?? 0;
    const total = totalLinesPerInvoice.get(k) ?? 0;
    return gap > 0 && gap < total;
  }

  for (const r of gapRows) {
    const normInvoice = normInv(r.invoiceNo);
    const inSap = !sapCanLookup ? "unknown" : sapInvoices.has(normInvoice) ? "yes" : "no";
    const runId = findRunId(r.ingestedAt);
    const partial = isPartialInvoice(r.invoiceNo);

    const rowData = [
      // Paste-back group (A-R)
      r.serialNo ?? "",
      r.invoiceNo ?? "",
      r.invoiceDate ?? "",
      branchFromInvoice(r.invoiceNo),
      r.customer ?? "",
      "", // City — not stored
      "", // Destination — not stored
      r.code,
      "", // Color — not stored
      r.qty != null ? Number(r.qty) : "",
      mrpMap.get(r.code) != null ? Number(mrpMap.get(r.code)) : "",
      r.saleRate != null ? Number(r.saleRate) : "",
      r.amount != null ? Number(r.amount) : "",
      r.groupRaw ?? "",
      r.station ?? "",
      r.stateRaw ?? "",
      r.headRaw ?? "",
      r.monthLabel ?? "",
      // Review group (S-W)
      r.lineUid,
      r.ingestedAt ? r.ingestedAt.toISOString() : "",
      runId ?? "",
      branchFromInvoice(r.invoiceNo),
      inSap,
    ];

    const dataRow = ws1.addRow(rowData);

    // Date column: format as date if ISO string
    const dateCell = dataRow.getCell(3);
    if (r.invoiceDate) {
      dateCell.value = new Date(r.invoiceDate + "T00:00:00Z");
      dateCell.numFmt = "DD-MMM-YYYY";
    }

    // Number formats
    dataRow.getCell(10).numFmt = "#,##0.##";  // Qty
    dataRow.getCell(11).numFmt = "#,##0.00";  // MRP
    dataRow.getCell(12).numFmt = "#,##0.00";  // Sale Rate
    dataRow.getCell(13).numFmt = "#,##0";     // Taxable Value

    // inSapSource colour
    const sapCell = dataRow.getCell(allHeaders.length);
    if (inSap === "yes") sapCell.fill = SAP_YES_FILL;
    else if (inSap === "no") sapCell.fill = SAP_NO_FILL;

    // Partial invoice highlight on Invoice No column
    if (partial) {
      dataRow.getCell(2).fill = PARTIAL_FILL;
      dataRow.getCell(2).note = "PARTIAL — some lines of this invoice still exist in the live sheet";
    }

    dataRow.font = { size: 10 };
  }

  // ── Sheet 2: Summary ───────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet("Summary");
  ws2.views = [{ state: "normal", showGridLines: false }];

  // Helper: add a section heading
  function addSection(label: string, nCols: number): void {
    ws2.addRow([]);
    const hdr = ws2.addRow([label]);
    hdr.getCell(1).font = { bold: true, size: 12, color: { argb: "FF1F3864" } };
    if (nCols > 1) ws2.mergeCells(hdr.number, 1, hdr.number, nCols);
  }

  function addTableHeader(headers: string[]): void {
    const r = ws2.addRow(headers);
    r.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
      cell.alignment = { vertical: "middle" };
    });
  }

  // Cover block
  const coverRow = ws2.addRow([`Disputed Rows: ${monthLabel} (FY${fy})`]);
  coverRow.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1F3864" } };
  ws2.addRow([`Generated: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`]);
  ws2.addRow([`Total disputed rows: ${gapRows.length}`]);
  ws2.addRow([`SAP source workbook read: ${sapLoaded ? "yes" : "no (check server logs)"}`]);
  ws2.addRow([`SAP invoice column detected: ${sapResult.invoiceColFound ? "yes" : "no"}`]);
  if (!sapCanLookup) {
    const warn = ws2.addRow([
      sapLoaded
        ? "inSapSource shows 'unknown' — SAP invoice column not detected. Check column names in the Combined tab."
        : "inSapSource shows 'unknown' — SAP workbook could not be read. Check server logs.",
    ]);
    warn.getCell(1).font = { italic: true, color: { argb: "FF8B0000" } };
  }
  ws2.addRow([`DB rows for ${monthLabel} (total): ${allMonthRows.length}`]);
  ws2.addRow([`Gap: ${gapRows.length} rows / ₹${Math.round(gapResult.dbOnly.amount).toLocaleString("en-IN")}`]);

  // ── Partial invoices ───────────────────────────────────────────────────────
  const partialInvoices = [...gapLinesPerInvoice.entries()]
    .filter(([k]) => (totalLinesPerInvoice.get(k) ?? 0) > (gapLinesPerInvoice.get(k) ?? 0))
    .map(([k]) => k);

  addSection(`PARTIAL INVOICES  (${partialInvoices.length} — some lines still in sheet, some missing)`, 6);
  if (partialInvoices.length === 0) {
    ws2.addRow(["None — every removed invoice had ALL its lines removed."]);
  } else {
    const partWarn = ws2.addRow(["A partial removal is the strongest indicator of an accidental edit."]);
    partWarn.getCell(1).font = { bold: true, color: { argb: "FF8B0000" } };
    addTableHeader(["Invoice No (norm)", "Gap Lines", "Total DB Lines", "Lines Still In Sheet", "Customer", "In SAP"]);
    for (const normInvoiceKey of partialInvoices.sort()) {
      const gapCount = gapLinesPerInvoice.get(normInvoiceKey) ?? 0;
      const total = totalLinesPerInvoice.get(normInvoiceKey) ?? 0;
      const stillIn = total - gapCount;
      const exRow = gapRows.find((r) => normInv(r.invoiceNo) === normInvoiceKey);
      const inSap = !sapCanLookup ? "unknown" : sapInvoices.has(normInvoiceKey) ? "yes" : "no";
      const r = ws2.addRow([normInvoiceKey, gapCount, total, stillIn, exRow?.customer ?? "", inSap]);
      r.getCell(1).fill = PARTIAL_FILL;
      if (inSap === "yes") r.getCell(6).fill = SAP_YES_FILL;
      if (inSap === "no") r.getCell(6).fill = SAP_NO_FILL;
    }
  }

  // ── By customer ────────────────────────────────────────────────────────────
  addSection("BY CUSTOMER", 4);
  addTableHeader(["Customer", "Rows", "Invoice Count", "Taxable Value (₹)"]);
  const byCust = new Map<string, { rows: number; invoices: Set<string>; amount: number }>();
  for (const r of gapRows) {
    const k = r.customer ?? "(unknown)";
    const s = byCust.get(k) ?? { rows: 0, invoices: new Set(), amount: 0 };
    s.rows++;
    s.invoices.add(normInv(r.invoiceNo));
    s.amount += r.amount != null ? Number(r.amount) : 0;
    byCust.set(k, s);
  }
  const custArr = [...byCust.entries()].sort((a, b) => b[1].amount - a[1].amount);
  for (const [cust, s] of custArr) {
    const r = ws2.addRow([cust, s.rows, s.invoices.size, Math.round(s.amount)]);
    r.getCell(4).numFmt = "#,##0";
  }

  // ── By invoice ─────────────────────────────────────────────────────────────
  addSection("BY INVOICE", 7);
  addTableHeader(["Invoice No", "Date", "Customer", "Gap Lines", "Value (₹)", "In SAP", "PARTIAL?"]);
  const byInv = new Map<string, { invoiceNo: string | null; date: string | null; customer: string | null; lines: number; amount: number }>();
  for (const r of gapRows) {
    const k = normInv(r.invoiceNo);
    const s = byInv.get(k) ?? { invoiceNo: r.invoiceNo, date: r.invoiceDate, customer: r.customer, lines: 0, amount: 0 };
    s.lines++;
    s.amount += r.amount != null ? Number(r.amount) : 0;
    byInv.set(k, s);
  }
  const invArr = [...byInv.entries()].sort((a, b) => {
    const c = (a[1].customer ?? "").localeCompare(b[1].customer ?? "");
    return c !== 0 ? c : a[0].localeCompare(b[0]);
  });
  for (const [k, s] of invArr) {
    const inSap = !sapCanLookup ? "unknown" : sapInvoices.has(k) ? "yes" : "no";
    const partial = isPartialInvoice(s.invoiceNo) ? "PARTIAL" : "";
    const r = ws2.addRow([s.invoiceNo ?? k, s.date ?? "", s.customer ?? "", s.lines, Math.round(s.amount), inSap, partial]);
    r.getCell(5).numFmt = "#,##0";
    if (inSap === "yes") r.getCell(6).fill = SAP_YES_FILL;
    if (inSap === "no") r.getCell(6).fill = SAP_NO_FILL;
    if (partial) r.getCell(7).fill = PARTIAL_FILL;
  }

  // ── By branch ──────────────────────────────────────────────────────────────
  addSection("BY BRANCH (invoice prefix)", 3);
  addTableHeader(["Branch", "Rows", "Value (₹)"]);
  const byBranch = new Map<string, { rows: number; amount: number }>();
  for (const r of gapRows) {
    const nb = numericBranch(r.invoiceNo);
    const label = nb ? `${nb} — ${BRANCH_LABELS[nb] ?? "?"}` : "(unknown)";
    const s = byBranch.get(label) ?? { rows: 0, amount: 0 };
    s.rows++;
    s.amount += r.amount != null ? Number(r.amount) : 0;
    byBranch.set(label, s);
  }
  for (const [branch, s] of [...byBranch.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
    const r = ws2.addRow([branch, s.rows, Math.round(s.amount)]);
    r.getCell(3).numFmt = "#,##0";
  }

  // ── By STATE HEAD ──────────────────────────────────────────────────────────
  addSection("BY STATE HEAD", 3);
  addTableHeader(["State Head", "Rows", "Value (₹)"]);
  const byHead = new Map<string, { rows: number; amount: number }>();
  for (const r of gapRows) {
    const k = r.headRaw ?? "(unknown)";
    const s = byHead.get(k) ?? { rows: 0, amount: 0 };
    s.rows++;
    s.amount += r.amount != null ? Number(r.amount) : 0;
    byHead.set(k, s);
  }
  for (const [head, s] of [...byHead.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
    const r = ws2.addRow([head, s.rows, Math.round(s.amount)]);
    r.getCell(3).numFmt = "#,##0";
  }

  // ── Total ──────────────────────────────────────────────────────────────────
  addSection("TOTAL", 4);
  addTableHeader(["", "Rows", "Invoices", "Value (₹)"]);
  const totalAmt = gapRows.reduce((s, r) => s + (r.amount != null ? Number(r.amount) : 0), 0);
  const totalInv = new Set(gapRows.map((r) => normInv(r.invoiceNo))).size;
  const totRow = ws2.addRow(["Total", gapRows.length, totalInv, Math.round(totalAmt)]);
  totRow.font = { bold: true };
  totRow.getCell(4).numFmt = "#,##0";

  // Summary column widths
  ws2.getColumn(1).width = 36;
  ws2.getColumn(2).width = 14;
  ws2.getColumn(3).width = 20;
  ws2.getColumn(4).width = 20;
  ws2.getColumn(5).width = 20;
  ws2.getColumn(6).width = 14;
  ws2.getColumn(7).width = 12;

  // ── Write to buffer ────────────────────────────────────────────────────────
  const buf = await wb.xlsx.writeBuffer();
  logger.info(
    { fy, monthLabel, gapRows: gapRows.length, sapLoaded, partialInvoices: partialInvoices.length },
    "exportXlsx: complete",
  );
  return Buffer.from(buf);
}
