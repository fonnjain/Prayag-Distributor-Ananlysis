// GP Margin fact-table loader.
//
// Reads all GP MARGIN workbooks for FY2025-26 (107 files) and FY2026-27 (26
// files) from Google Drive, classifies each as monthly or cumulative, parses
// every GP-margin tab, and (re)populates the margin_fact table.
//
// MONTHLY IS TRUTH.  Cumulative files are used only to cross-validate that the
// per-month sums agree with the cumulative total within 1%.  They are NOT
// inserted into margin_fact.
//
// DISCOUNT is a FRACTION (0.5353 = realised sale is 46.47% of MRP).
// Stored as-is; never treat as a percentage.
//
// bom_cost is factory BOM / purchase cost per unit.  Label every derived
// figure "gross margin" / "gross contribution", never "profit" — no freight,
// overhead or SG&A is included.

import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import {
  listDriveFolder,
  downloadDriveFileBuffer,
  findDriveFoldersByName,
  type DriveApiFile,
} from "../googleDrive.js";
import { logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface MarginRow {
  fy: string;
  monthLabel: string;
  segment: string;
  itemCode: string;
  tabName: string;
  qty: number | null;
  weight: number | null;
  mrp: number | null;
  discountFrac: number | null;
  avgSale: number | null;
  bomCost: number | null;
  saleValue: number | null;
  bomValue: number | null;
  sourceFile: string;
}

type FileClass = "monthly" | "cumulative" | "summary" | "unknown";

interface ClassifiedFile {
  file: DriveApiFile;
  fy: string;
  segment: string;
  monthLabel: string | null;
  classification: FileClass;
}

interface ColMap {
  code: number;          // always col 2 (B)
  qty: number;           // col index, 1-based
  weight: number | null;
  mrp: number | null;
  discount: number | null;
  avgSale: number | null;
  bomCost: number | null;
  saleValue: number | null;
  bomValue: number | null;
}

export interface CumulativeCheck {
  segment: string;
  fy: string;
  filename: string;
  monthlySumQty: number;
  cumulativeQty: number;
  qtyDiffPct: number;
  monthlySumSale: number;
  cumulativeSale: number;
  saleDiffPct: number;
  flag: boolean;
}

export interface LoadReport {
  filesScanned: number;
  filesLoaded: number;
  filesCumulative: { name: string; fy: string; segment: string }[];
  filesSummary: { name: string; fy: string }[];
  filesUnknown: { name: string; fy: string; segment: string; reason: string }[];
  rowsInserted: number;
  rowsByFySegment: Record<string, number>;
  distinctCodes: number;
  cumulativeValidation: CumulativeCheck[];
  negativeContributionCount: number;
  negativeContributionTop10: {
    code: string; segment: string; qty: number; avgSale: number; bomCost: number;
  }[];
}

// ── Month helpers ──────────────────────────────────────────────────────────

const MONTH_CANON: Record<string, string> = {
  jan: "Jan", january: "Jan",
  feb: "Feb", february: "Feb",
  mar: "Mar", march: "Mar",
  apr: "Apr", april: "Apr",
  may: "May",
  jun: "Jun", june: "Jun",
  jul: "Jul", july: "Jul",
  aug: "Aug", august: "Aug",
  sep: "Sep", sept: "Sep", september: "Sep",
  oct: "Oct", october: "Oct",
  nov: "Nov", november: "Nov",
  dec: "Dec", december: "Dec",
};

const MONTH_FY_HALF: Record<string, "first" | "second"> = {
  Apr: "first", May: "first", Jun: "first",
  Jul: "first", Aug: "first", Sep: "first",
  Oct: "second", Nov: "second", Dec: "second",
  Jan: "second", Feb: "second", Mar: "second",
};

function fyYears(fy: string): { first: number; second: number } {
  // "2025-26" → first=25, second=26
  const [a, b] = fy.split("-");
  return {
    first: parseInt(a.slice(2), 10),
    second: parseInt(b, 10),
  };
}

function extractMonths(name: string): string[] {
  const lower = name.toLowerCase();
  const found: string[] = [];
  for (const [key, canon] of Object.entries(MONTH_CANON)) {
    const re = new RegExp(`(?<![a-z])${key}(?![a-z])`, "i");
    if (re.test(lower) && !found.includes(canon)) found.push(canon);
  }
  return found;
}

function classifyFilename(name: string): FileClass {
  const lower = name.toLowerCase();
  if (lower.includes("summary") || lower.includes("month on month")) return "summary";
  if (
    lower.includes(" to ") ||
    lower.includes("qtr") ||
    lower.includes("quarter") ||
    / & /.test(lower)
  )
    return "cumulative";
  const months = extractMonths(name);
  if (months.length > 1) return "cumulative";
  if (months.length === 1) return "monthly";
  return "unknown";
}

// Build month_label like "Apr-25" from a filename given the FY string.
function parseMonthLabel(name: string, fy: string): string | null {
  const months = extractMonths(name);
  if (months.length !== 1) return null;
  const m3 = months[0];
  const { first, second } = fyYears(fy);
  const year2d =
    MONTH_FY_HALF[m3] === "first" ? first : second;
  return `${m3}-${year2d.toString().padStart(2, "0")}`;
}

// ── Segment canonicalisation ───────────────────────────────────────────────

const SEGMENT_MAP: [RegExp, string][] = [
  [/waste\s*pipe/i,    "Waste Pipe & Connection"],
  [/garden\s*pipe/i,  "Garden Pipe"],
  [/sanitar/i,        "Sanitaryware"],
  [/plumb/i,          "Plumbing"],
  [/hardware/i,       "Hardware"],
  [/ptmt/i,           "PTMT"],
  [/\bcp\b|chrome/i,  "CP"],
  [/sink/i,           "Sink"],
];

function canonicalSegment(folderName: string): string {
  for (const [re, seg] of SEGMENT_MAP) {
    if (re.test(folderName)) return seg;
  }
  return folderName;
}

// ── GP-margin tab detection ────────────────────────────────────────────────
// Scans rows 2-6 for a row where:
//   • col B contains CODE or ITEM CODE
//   • the row contains DISCOUNT
//   • the row contains BOM COST or PUR RATE

function detectGpMarginTabs(
  wb: ExcelJS.Workbook,
): { ws: ExcelJS.Worksheet; headerRow: number; colMap: ColMap }[] {
  const hits: { ws: ExcelJS.Worksheet; headerRow: number; colMap: ColMap }[] = [];

  for (const ws of wb.worksheets) {
    for (let ri = 2; ri <= 6; ri++) {
      const cells: string[] = [];
      for (let ci = 1; ci <= 20; ci++) {
        cells.push(
          (ws.getRow(ri).getCell(ci).text ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase(),
        );
      }
      // Col B (index 1) must contain CODE
      if (!cells[1]?.includes("CODE")) continue;
      const hasDiscount = cells.some((c) => c === "DISCOUNT" || c.startsWith("DISCOUNT"));
      const hasBom = cells.some(
        (c) =>
          c.includes("BOM COST") ||
          c.includes("BOMCOST") ||
          c.includes("PUR RATE") ||
          c.includes("PURRATE"),
      );
      if (!hasDiscount || !hasBom) continue;

      const colMap = buildColMap(cells);
      if (!colMap) continue;
      hits.push({ ws, headerRow: ri, colMap });
      break;
    }
  }
  return hits;
}

function buildColMap(cells: string[]): ColMap | null {
  // cells is 0-indexed (cells[0] = col A), returns 1-based column numbers
  const idx = (...patterns: string[]): number | null => {
    for (const p of patterns) {
      let i = cells.findIndex((c) => c === p);
      if (i < 0) i = cells.findIndex((c) => c.startsWith(p));
      if (i < 0) i = cells.findIndex((c) => c.includes(p));
      if (i >= 0) return i + 1;
    }
    return null;
  };

  // Find all SALE VALUE columns (first = per avg sale rate, second = per bom)
  const saleValueCols: number[] = [];
  cells.forEach((c, i) => {
    if (c.includes("SALE VALUE") || c.includes("SALEVALUE")) saleValueCols.push(i + 1);
  });

  return {
    code: 2,
    qty: idx("QTY") ?? 3,
    weight: idx("TOTAL  WEIGHT", "TOTAL WEIGHT", "TOTALWEIGHT") ?? idx("WEIGHT"),
    mrp: idx("MRP"),
    discount: idx("DISCOUNT"),
    avgSale: idx("AVG SALE RATE", "AVG SALE", "AVGSALE"),
    bomCost: idx("BOM COST", "BOMCOST", "PUR RATE", "PURRATE"),
    saleValue: saleValueCols[0] ?? null,
    bomValue: saleValueCols[1] ?? null,
  };
}

// ── Cell helpers ───────────────────────────────────────────────────────────

function cellNum(cell: ExcelJS.Cell): number | null {
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "object" && "result" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    if (typeof r === "number") return isFinite(r) ? r : null;
    if (r == null) return null;
  }
  const n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}

function cellStr(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if ("richText" in v)
      return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").trim();
    if ("result" in v) {
      const r = (v as ExcelJS.CellFormulaValue).result;
      return r != null ? String(r).trim() : "";
    }
    if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text.trim();
  }
  return String(v).trim();
}

// ── Row extraction ─────────────────────────────────────────────────────────

function extractRows(
  ws: ExcelJS.Worksheet,
  headerRow: number,
  colMap: ColMap,
  fy: string,
  monthLabel: string,
  segment: string,
  sourceFile: string,
): MarginRow[] {
  const rows: MarginRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, ri) => {
    if (ri <= headerRow) return;
    const itemCode = cellStr(row.getCell(colMap.code));
    if (!itemCode) return;
    const upper = itemCode.toUpperCase();
    if (
      upper === "CODE" ||
      upper === "ITEM CODE" ||
      upper.startsWith("TOTAL") ||
      upper.startsWith("SUB TOTAL") ||
      upper.startsWith("GRAND")
    )
      return;

    const qty      = cellNum(row.getCell(colMap.qty));
    const weight   = colMap.weight   ? cellNum(row.getCell(colMap.weight))   : null;
    const mrp      = colMap.mrp      ? cellNum(row.getCell(colMap.mrp))      : null;
    const discFrac = colMap.discount ? cellNum(row.getCell(colMap.discount)) : null;
    const avgSale  = colMap.avgSale  ? cellNum(row.getCell(colMap.avgSale))  : null;
    const bomCost  = colMap.bomCost  ? cellNum(row.getCell(colMap.bomCost))  : null;
    const saleVal  = colMap.saleValue ? cellNum(row.getCell(colMap.saleValue)) : null;
    const bomVal   = colMap.bomValue  ? cellNum(row.getCell(colMap.bomValue))  : null;

    if (qty == null && avgSale == null && bomCost == null) return;

    rows.push({
      fy, monthLabel, segment, itemCode,
      tabName: ws.name,
      qty, weight, mrp,
      discountFrac: discFrac,
      avgSale, bomCost,
      saleValue: saleVal,
      bomValue: bomVal,
      sourceFile,
    });
  });
  return rows;
}

// ── Parse cumulative file for validation totals ────────────────────────────

function parseCumulativeTotals(
  wb: ExcelJS.Workbook,
): { qty: number; saleValue: number } | null {
  const tabs = detectGpMarginTabs(wb);
  if (tabs.length === 0) return null;
  let totalQty = 0, totalSale = 0;
  for (const { ws, headerRow, colMap } of tabs) {
    ws.eachRow({ includeEmpty: false }, (row, ri) => {
      if (ri <= headerRow) return;
      const code = cellStr(row.getCell(colMap.code));
      const upper = code.toUpperCase();
      if (!code || upper.startsWith("TOTAL") || upper.startsWith("GRAND")) return;
      totalQty  += cellNum(row.getCell(colMap.qty))      ?? 0;
      totalSale += colMap.saleValue ? (cellNum(row.getCell(colMap.saleValue)) ?? 0) : 0;
    });
  }
  return { qty: totalQty, saleValue: totalSale };
}

// ── Drive discovery ────────────────────────────────────────────────────────

async function discoverFyFolders(): Promise<{ fy: string; folderId: string; name: string }[]> {
  const folders = await findDriveFoldersByName("GP MARGIN FY");
  const result: { fy: string; folderId: string; name: string }[] = [];
  for (const f of folders) {
    if (f.name.includes("25-26") || f.name.includes("2025-26")) {
      result.push({ fy: "2025-26", folderId: f.id, name: f.name });
    } else if (f.name.includes("26-27") || f.name.includes("2026-27")) {
      result.push({ fy: "2026-27", folderId: f.id, name: f.name });
    }
  }
  return result;
}

// ── Main load ──────────────────────────────────────────────────────────────

export async function loadGpMarginFiles(): Promise<LoadReport> {
  const report: LoadReport = {
    filesScanned: 0,
    filesLoaded: 0,
    filesCumulative: [],
    filesSummary: [],
    filesUnknown: [],
    rowsInserted: 0,
    rowsByFySegment: {},
    distinctCodes: 0,
    cumulativeValidation: [],
    negativeContributionCount: 0,
    negativeContributionTop10: [],
  };

  // 1 — discover FY folders
  const fyFolders = await discoverFyFolders();
  if (fyFolders.length === 0) {
    throw new Error(
      "No 'GP MARGIN FY' folders found on Google Drive. " +
        "Ensure the Drive integration has access to those folders.",
    );
  }
  logger.info({ found: fyFolders.map((f) => f.name) }, "gpMargin: FY folders");

  // 2 — classify all files
  const allClassified: ClassifiedFile[] = [];

  for (const { fy, folderId } of fyFolders) {
    const children = await listDriveFolder(folderId);

    for (const child of children) {
      const isFolder = child.mimeType === "application/vnd.google-apps.folder";

      if (isFolder) {
        const segment = canonicalSegment(child.name);
        const segFiles = await listDriveFolder(child.id);
        for (const f of segFiles) {
          if (!/\.(xlsx|xls)$/i.test(f.name)) continue;
          report.filesScanned++;
          const cls = classifyFilename(f.name);
          const monthLabel = cls === "monthly" ? parseMonthLabel(f.name, fy) : null;
          allClassified.push({
            file: f, fy, segment,
            monthLabel,
            classification: cls === "monthly" && monthLabel == null ? "unknown" : cls,
          });
        }
      } else {
        if (!/\.(xlsx|xls)$/i.test(child.name)) continue;
        report.filesScanned++;
        const cls = classifyFilename(child.name);
        allClassified.push({
          file: child, fy,
          segment: "SUMMARY",
          monthLabel: null,
          classification: cls === "monthly" ? "unknown" : cls,
        });
      }
    }
  }

  const monthlyFiles    = allClassified.filter((f) => f.classification === "monthly");
  const cumulativeFiles = allClassified.filter((f) => f.classification === "cumulative");
  const summaryFiles    = allClassified.filter((f) => f.classification === "summary");
  const unknownFiles    = allClassified.filter((f) => f.classification === "unknown");

  report.filesCumulative = cumulativeFiles.map((f) => ({ name: f.file.name, fy: f.fy, segment: f.segment }));
  report.filesSummary    = summaryFiles.map((f)    => ({ name: f.file.name, fy: f.fy }));
  report.filesUnknown    = unknownFiles.map((f)    => ({ name: f.file.name, fy: f.fy, segment: f.segment, reason: "unparseable filename" }));

  logger.info(
    { monthly: monthlyFiles.length, cumulative: cumulativeFiles.length, summary: summaryFiles.length, unknown: unknownFiles.length },
    "gpMargin: classification done",
  );

  // 3 — parse monthly files
  const allRows: MarginRow[] = [];
  // Track cumulative parsed totals for validation, keyed by "fy|segment"
  const cumulativeParsed: Map<string, { filename: string; qty: number; saleValue: number }> = new Map();

  for (const cf of monthlyFiles) {
    let buf: Buffer;
    try {
      buf = await downloadDriveFileBuffer(cf.file.id);
    } catch (err) {
      logger.warn({ file: cf.file.name, err }, "gpMargin: download failed");
      report.filesUnknown.push({ name: cf.file.name, fy: cf.fy, segment: cf.segment, reason: "download failed" });
      continue;
    }

    let wb: ExcelJS.Workbook;
    try {
      wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await wb.xlsx.load(buf as any);
    } catch (err) {
      logger.warn({ file: cf.file.name, err }, "gpMargin: parse failed");
      report.filesUnknown.push({ name: cf.file.name, fy: cf.fy, segment: cf.segment, reason: "parse failed" });
      continue;
    }

    const tabs = detectGpMarginTabs(wb);
    if (tabs.length === 0) {
      logger.warn({ file: cf.file.name, segment: cf.segment }, "gpMargin: no GP margin tabs found");
      report.filesUnknown.push({ name: cf.file.name, fy: cf.fy, segment: cf.segment, reason: "no GP margin tabs detected" });
      continue;
    }

    for (const { ws, headerRow, colMap } of tabs) {
      const rows = extractRows(ws, headerRow, colMap, cf.fy, cf.monthLabel!, cf.segment, cf.file.name);
      allRows.push(...rows);
    }
    report.filesLoaded++;
  }

  // 4 — parse cumulative files for validation cross-totals
  for (const cf of cumulativeFiles) {
    let buf: Buffer;
    try { buf = await downloadDriveFileBuffer(cf.file.id); } catch { continue; }
    let wb: ExcelJS.Workbook;
    try {
      wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await wb.xlsx.load(buf as any);
    } catch { continue; }
    const totals = parseCumulativeTotals(wb);
    if (totals) {
      const key = `${cf.fy}|${cf.segment}`;
      // Use last cumulative file per segment (likely widest range)
      cumulativeParsed.set(key, { filename: cf.file.name, ...totals });
    }
  }

  // 5 — truncate + insert
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM margin_fact");

    const CHUNK = 500;
    for (let i = 0; i < allRows.length; i += CHUNK) {
      const chunk = allRows.slice(i, i + CHUNK);
      if (!chunk.length) break;
      const vals: unknown[] = [];
      const ph = chunk.map((r, j) => {
        const b = j * 14;
        vals.push(
          r.fy, r.monthLabel, r.segment, r.itemCode, r.tabName,
          r.qty, r.weight, r.mrp, r.discountFrac, r.avgSale,
          r.bomCost, r.saleValue, r.bomValue, r.sourceFile,
        );
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14})`;
      }).join(",");
      await client.query(
        `INSERT INTO margin_fact
           (fy,month_label,segment,item_code,tab_name,qty,weight,mrp,
            discount_frac,avg_sale,bom_cost,sale_value,bom_value,source_file)
         VALUES ${ph}`,
        vals,
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  report.rowsInserted = allRows.length;

  // 6 — counts by FY+segment
  const segRes = await pool.query<{ fy: string; segment: string; cnt: string }>(
    "SELECT fy, segment, COUNT(*) AS cnt FROM margin_fact GROUP BY fy, segment ORDER BY fy, segment",
  );
  for (const r of segRes.rows) report.rowsByFySegment[`${r.fy}|${r.segment}`] = parseInt(r.cnt, 10);

  // 7 — distinct codes
  const distRes = await pool.query<{ n: string }>("SELECT COUNT(DISTINCT item_code) AS n FROM margin_fact");
  report.distinctCodes = parseInt(distRes.rows[0]?.n ?? "0", 10);

  // 8 — cumulative validation
  for (const [key, cum] of cumulativeParsed.entries()) {
    const [fy, seg] = key.split("|");
    const mRes = await pool.query<{ qty: string; sv: string }>(
      "SELECT COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(sale_value),0) AS sv FROM margin_fact WHERE fy=$1 AND segment=$2",
      [fy, seg],
    );
    const mQty  = parseFloat(mRes.rows[0]?.qty ?? "0");
    const mSale = parseFloat(mRes.rows[0]?.sv  ?? "0");
    const qtyDiff  = cum.qty   > 0 ? Math.abs(mQty  - cum.qty)   / cum.qty   : 0;
    const saleDiff = cum.saleValue > 0 ? Math.abs(mSale - cum.saleValue) / cum.saleValue : 0;
    report.cumulativeValidation.push({
      segment: seg, fy, filename: cum.filename,
      monthlySumQty: mQty, cumulativeQty: cum.qty, qtyDiffPct: qtyDiff * 100,
      monthlySumSale: mSale, cumulativeSale: cum.saleValue, saleDiffPct: saleDiff * 100,
      flag: qtyDiff > 0.01 || saleDiff > 0.01,
    });
  }

  // 9 — negative contribution codes
  const negRes = await pool.query<{ code: string; segment: string; qty: string; avs: string; bom: string }>(
    `SELECT item_code AS code, segment,
            SUM(qty) AS qty, AVG(avg_sale) AS avs, AVG(bom_cost) AS bom
       FROM margin_fact
      WHERE bom_cost IS NOT NULL AND avg_sale IS NOT NULL AND bom_cost > avg_sale
      GROUP BY item_code, segment
      ORDER BY SUM(qty) DESC NULLS LAST LIMIT 10`,
  );
  const negCnt = await pool.query<{ n: string }>(
    "SELECT COUNT(DISTINCT item_code) AS n FROM margin_fact WHERE bom_cost IS NOT NULL AND avg_sale IS NOT NULL AND bom_cost > avg_sale",
  );
  report.negativeContributionCount = parseInt(negCnt.rows[0]?.n ?? "0", 10);
  report.negativeContributionTop10 = negRes.rows.map((r) => ({
    code: r.code, segment: r.segment,
    qty: parseFloat(r.qty ?? "0"),
    avgSale: parseFloat(r.avs ?? "0"),
    bomCost: parseFloat(r.bom ?? "0"),
  }));

  logger.info({ rows: report.rowsInserted, codes: report.distinctCodes, files: report.filesLoaded }, "gpMargin: load complete");
  return report;
}
