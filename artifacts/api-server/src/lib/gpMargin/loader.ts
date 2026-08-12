// GP Margin fact-table loader.
//
// Reads all GP MARGIN workbooks for FY2025-26 and FY2026-27 from Google Drive.
// Primary path: Sheets API subprocess.  Fallback: Drive export (xlsx bytes via
// downloadDriveFileBuffer) for files that hang on the Sheets API (e.g. CP segment).
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

import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import {
  listDriveFiles,
  listDriveFolder,
  downloadDriveFileBuffer,
  type DriveApiFile,
} from "../googleDrive.js";
import {
  type WorkbookLike,
  type WorksheetLike,
  type CellLike,
} from "../sheets.js";
import { logger } from "../logger.js";

// dist/ lives next to this bundle.
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

// OS `timeout` command — sends SIGTERM to the child after N seconds.
// Guaranteed to fire at the OS level regardless of the child's JS event loop.
// Resolved portably at startup via `which` so the path survives Nix store updates.
function resolveTimeoutCmd(): string {
  try {
    const found = execFileSync("which", ["timeout"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // ignore — fall through to bare name
  }
  return "timeout"; // last resort; will fail loudly if missing from PATH
}
const TIMEOUT_CMD = resolveTimeoutCmd();

// Standalone fetcher script (compiled separately by esbuild).
const FETCHER_PATH = path.join(DIST_DIR, "gpMarginFetcher.mjs");

// Current Node.js executable.
const NODE_EXEC = process.execPath;

// ── OS-timeout subprocess fetch ────────────────────────────────────────────
// Runs the Sheets API read in a CHILD PROCESS under the Unix `timeout` command.
//
// Why not worker_threads or Promise.race + setTimeout?
// When certain Google Sheets cause undici's socket to hang, Node.js's timer
// phase (setTimeout/setInterval) becomes unable to fire for that isolate —
// even inside isolated workers.  The symptom: a 90 s timer set at T fires
// correctly for files that complete before 90 s, but never fires for the
// stuck file.
//
// The `timeout` command solves this at the OS level: after N seconds it sends
// SIGTERM to the child Node.js process.  The child's stdout/stderr pipes close.
// The parent's execFile callback fires via an *I/O* event (pipe-close), which
// the parent processes reliably even when its timer phase is saturated.
//
// Result schema (written atomically to child stdout):
//   { ok: true,  sheets: [{name, rows}…] }
//   { ok: false, error: string }
//
// If the child is killed mid-write (partial JSON), JSON.parse fails and the
// load treats that file as a fetch failure.

type WorkerSheets = Array<{ name: string; rows: (string | number | boolean | null)[][] }>;

function buildWorkbookFromWorkerData(sheets: WorkerSheets): WorkbookLike {
  const worksheets: WorksheetLike[] = sheets.map(({ name, rows }) => ({
    name,
    eachRow(cb: (row: { getCell(col: number): CellLike }, rowNumber: number) => void) {
      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i] ?? [];
        if (cells.every((c) => c == null || c === "")) continue;
        cb(
          {
            getCell(col1Based: number): CellLike {
              return { value: cells[col1Based - 1] ?? null };
            },
          },
          i + 1,
        );
      }
    },
  }));
  return {
    worksheets,
    getWorksheet(name: string) {
      return worksheets.find((w) => w.name === name);
    },
  };
}

async function fetchWorkbookViaProcess(
  fileId: string,
  timeoutSec = 90,
): Promise<WorkbookLike> {
  return new Promise<WorkbookLike>((resolve, reject) => {
    execFile(
      TIMEOUT_CMD,
      [String(timeoutSec), NODE_EXEC, "--enable-source-maps", FETCHER_PATH, fileId],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        // stdout may contain valid JSON even when err is set (child wrote then errored).
        if (stdout) {
          try {
            const result = JSON.parse(stdout) as
              | { ok: true; sheets: WorkerSheets }
              | { ok: false; error: string };
            if (result.ok) {
              resolve(buildWorkbookFromWorkerData(result.sheets));
              return;
            }
            reject(new Error(result.error));
            return;
          } catch {
            // partial JSON (child killed mid-write) — fall through to err handling
          }
        }
        reject(err ?? new Error(`fetcher produced no output (fileId=${fileId})`));
      },
    );
  });
}

function excelCellValue(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object") return raw;
  // exceljs formula result
  if ("result" in (raw as Record<string, unknown>)) {
    return excelCellValue((raw as { result: unknown }).result);
  }
  // exceljs rich-text
  if ("richText" in (raw as Record<string, unknown>)) {
    return (raw as { richText: { text: string }[] }).richText
      .map((r) => r.text)
      .join("");
  }
  // exceljs hyperlink
  if ("text" in (raw as Record<string, unknown>)) {
    return (raw as { text: unknown }).text;
  }
  return null;
}
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
  mimeType: string;
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

// ── Cell helpers (Sheets API values — no formula objects, no richText) ─────

function cellNum(cell: CellLike): number | null {
  const v = cell.value;
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  // Sheets API may return numbers as strings in some locales
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isFinite(n) ? n : null;
}

function cellStr(cell: CellLike): string {
  const v = cell.value;
  if (v == null) return "";
  return String(v).trim();
}

// ── GP-margin tab detection ────────────────────────────────────────────────
// Scans rows 2-6 for a row where:
//   • col B contains CODE or ITEM CODE
//   • the row contains DISCOUNT
//   • the row contains BOM COST or PUR RATE

function detectGpMarginTabs(
  wb: WorkbookLike,
): { ws: WorksheetLike; headerRow: number; colMap: ColMap }[] {
  const hits: { ws: WorksheetLike; headerRow: number; colMap: ColMap }[] = [];

  for (const ws of wb.worksheets) {
    let hit: { headerRow: number; colMap: ColMap } | null = null;

    ws.eachRow((row, ri) => {
      if (hit) return; // already found header for this sheet
      if (ri < 2 || ri > 8) return; // header must be in rows 2-8

      const cells: string[] = [];
      for (let ci = 1; ci <= 25; ci++) {
        cells.push(
          String(row.getCell(ci).value ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase(),
        );
      }

      // Col B (index 1) must contain CODE
      if (!cells[1]?.includes("CODE")) return;
      const hasDiscount = cells.some((c) => c === "DISCOUNT" || c.startsWith("DISCOUNT"));
      const hasBom = cells.some(
        (c) =>
          c.includes("BOM COST") ||
          c.includes("BOMCOST") ||
          c.includes("PUR RATE") ||
          c.includes("PURRATE"),
      );
      if (!hasDiscount || !hasBom) return;

      const colMap = buildColMap(cells);
      if (!colMap) return;
      hit = { headerRow: ri, colMap };
    });

    if (hit) {
      hits.push({ ws, headerRow: (hit as { headerRow: number; colMap: ColMap }).headerRow, colMap: (hit as { headerRow: number; colMap: ColMap }).colMap });
    }
  }
  return hits;
}

function buildColMap(cells: string[]): ColMap | null {
  const idx = (...patterns: string[]): number | null => {
    for (const p of patterns) {
      let i = cells.findIndex((c) => c === p);
      if (i < 0) i = cells.findIndex((c) => c.startsWith(p));
      if (i < 0) i = cells.findIndex((c) => c.includes(p));
      if (i >= 0) return i + 1;
    }
    return null;
  };

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

// ── Row extraction ─────────────────────────────────────────────────────────

function extractRows(
  ws: WorksheetLike,
  headerRow: number,
  colMap: ColMap,
  fy: string,
  monthLabel: string,
  segment: string,
  sourceFile: string,
): MarginRow[] {
  const rows: MarginRow[] = [];
  ws.eachRow((row, ri) => {
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
  wb: WorkbookLike,
): { qty: number; saleValue: number } | null {
  const tabs = detectGpMarginTabs(wb);
  if (tabs.length === 0) return null;
  let totalQty = 0, totalSale = 0;
  for (const { ws, headerRow, colMap } of tabs) {
    ws.eachRow((row, ri) => {
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

interface SegmentFolderInfo {
  folderId: string;
  fy: string;
  segment: string;
  name: string;
  isWrapper: boolean;
}

function detectFy(folderName: string): "2025-26" | "2026-27" | null {
  if (/25-26|2025-26/.test(folderName)) return "2025-26";
  if (/26-27|2026-27/.test(folderName)) return "2026-27";
  return null;
}

async function discoverSegmentFolders(): Promise<SegmentFolderInfo[]> {
  const result = await listDriveFiles({ q: "GP MARGIN" });
  const folders: SegmentFolderInfo[] = [];

  for (const item of result.files) {
    if (item.mimeType !== "application/vnd.google-apps.folder") continue;
    const fy = detectFy(item.name);
    if (!fy) continue;
    const isWrapper = /^GP MARGIN FY/i.test(item.name.trim());
    const segment = canonicalSegment(item.name);
    folders.push({ folderId: item.id, fy, segment, name: item.name, isWrapper });
  }

  return folders;
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

  // 1 — discover all segment-level GP MARGIN folders
  const segmentFolders = await discoverSegmentFolders();
  if (segmentFolders.length === 0) {
    throw new Error(
      "No GP MARGIN folders found for FY 2025-26 or 2026-27 on Google Drive. " +
        "Ensure the Drive integration has access to those folders.",
    );
  }
  logger.info(
    { found: segmentFolders.map((f) => `${f.fy}|${f.segment}|${f.name}`) },
    "gpMargin: segment folders discovered",
  );

  // 2 — classify all spreadsheets inside each segment folder
  const allClassified: ClassifiedFile[] = [];
  const seenFileIds = new Set<string>();

  function isSpreadsheet(f: DriveApiFile): boolean {
    return (
      f.mimeType === "application/vnd.google-apps.spreadsheet" ||
      /\.(xlsx|xls)$/i.test(f.name)
    );
  }

  async function scanFolder(
    folderId: string,
    fy: string,
    segment: string,
  ): Promise<void> {
    let children: DriveApiFile[];
    try {
      children = await listDriveFolder(folderId);
    } catch (err) {
      logger.warn({ folderId, err }, "gpMargin: folder list failed");
      return;
    }

    for (const child of children) {
      if (child.mimeType === "application/vnd.google-apps.folder") {
        const childSegment = canonicalSegment(child.name) === "UNKNOWN" ? segment : canonicalSegment(child.name);
        await scanFolder(child.id, fy, childSegment);
        continue;
      }
      if (!isSpreadsheet(child)) continue;
      if (seenFileIds.has(child.id)) continue;
      seenFileIds.add(child.id);

      report.filesScanned++;
      const cls = classifyFilename(child.name);
      const monthLabel = cls === "monthly" ? parseMonthLabel(child.name, fy) : null;
      allClassified.push({
        file: child, fy, segment,
        monthLabel,
        mimeType: child.mimeType,
        classification: cls === "monthly" && monthLabel == null ? "unknown" : cls,
      });
    }
  }

  for (const sf of segmentFolders) {
    await scanFolder(sf.folderId, sf.fy, sf.segment);
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

  // 3 — parse monthly files via Sheets API.
  //
  // Each file is fetched in a worker thread with a 90 s per-worker timeout
  // (`worker.terminate()` is the only reliable kill switch for hanging sockets).
  // Files are processed in parallel batches of BATCH_SIZE so that a stuck
  // worker for one file cannot stall the rest of the load.
  const allRows: MarginRow[] = [];
  const cumulativeParsed: Map<string, { filename: string; qty: number; saleValue: number }> = new Map();

  const BATCH_SIZE = 5;
  const WORKER_TIMEOUT_MS = 90_000;

  async function fetchAndParse(
    cf: (typeof monthlyFiles)[0],
    idx: number,
  ): Promise<void> {
    logger.info(
      { n: idx, of: monthlyFiles.length, file: cf.file.name, fy: cf.fy, segment: cf.segment },
      "gpMargin: reading monthly file",
    );
    let wb: WorkbookLike;
    try {
      wb = await fetchWorkbookViaProcess(cf.file.id, WORKER_TIMEOUT_MS / 1000);
    } catch (sheetsErr) {
      // Sheets API subprocess timed out (common for large CP segment files).
      // Retry via the Drive export API — different code path, no Sheets quota.
      logger.warn(
        { file: cf.file.name, err: String(sheetsErr) },
        "gpMargin: Sheets fetch failed — retrying via Drive export",
      );
      try {
        wb = await fetchWorkbookViaDriveExport(cf.file.id, cf.mimeType);
        logger.info({ file: cf.file.name }, "gpMargin: Drive export fallback succeeded");
      } catch (driveErr) {
        logger.warn(
          { file: cf.file.name, sheetsErr: String(sheetsErr), driveErr: String(driveErr) },
          "gpMargin: Drive export fallback also failed — skipping",
        );
        report.filesUnknown.push({
          name: cf.file.name, fy: cf.fy, segment: cf.segment,
          reason: `fetch failed (sheets: ${String(sheetsErr)}; drive: ${String(driveErr)})`,
        });
        return;
      }
    }

    const tabs = detectGpMarginTabs(wb);
    if (tabs.length === 0) {
      logger.warn({ file: cf.file.name, segment: cf.segment, sheets: wb.worksheets.map((w) => w.name) }, "gpMargin: no GP margin tabs — skipping");
      report.filesUnknown.push({ name: cf.file.name, fy: cf.fy, segment: cf.segment, reason: "no GP margin tabs detected" });
      return;
    }

    let fileRows = 0;
    for (const { ws, headerRow, colMap } of tabs) {
      const rows = extractRows(ws, headerRow, colMap, cf.fy, cf.monthLabel!, cf.segment, cf.file.name);
      allRows.push(...rows);
      fileRows += rows.length;
    }
    logger.info(
      { n: idx, of: monthlyFiles.length, file: cf.file.name, tabs: tabs.length, rows: fileRows },
      "gpMargin: file loaded",
    );
    report.filesLoaded++;
  }

  for (let b = 0; b < monthlyFiles.length; b += BATCH_SIZE) {
    const batch = monthlyFiles.slice(b, b + BATCH_SIZE);
    logger.info(
      { batchStart: b + 1, batchEnd: b + batch.length, total: monthlyFiles.length },
      "gpMargin: starting batch",
    );
    await Promise.allSettled(
      batch.map((cf, i) => fetchAndParse(cf, b + i + 1)),
    );
    logger.info({ batchStart: b + 1, batchEnd: b + batch.length }, "gpMargin: batch complete");
  }

  // 4 — parse cumulative files for cross-validation (subprocess, same timeout)
  for (const cf of cumulativeFiles) {
    let wb: WorkbookLike;
    try {
      wb = await fetchWorkbookViaProcess(cf.file.id, 90);
    } catch {
      // Sheets subprocess timed out — retry via Drive export for cross-validation too.
      try { wb = await fetchWorkbookViaDriveExport(cf.file.id, cf.mimeType); }
      catch { continue; }
    }
    const totals = parseCumulativeTotals(wb);
    if (totals) {
      const key = `${cf.fy}|${cf.segment}`;
      cumulativeParsed.set(key, { filename: cf.file.name, ...totals });
    }
  }

  // 5 — coverage guard: refuse to wipe the table if fetch results are catastrophically low.
  // This prevents a broken TIMEOUT_CMD or a connector-wide Sheets failure from silently
  // replacing all existing margin data with zero rows.
  if (monthlyFiles.length > 0) {
    const minRequired = Math.max(5, Math.ceil(monthlyFiles.length * 0.40));
    if (report.filesLoaded < minRequired) {
      throw new Error(
        `GP Margin load aborted — coverage too low to replace table: ` +
        `${report.filesLoaded} of ${monthlyFiles.length} monthly files loaded successfully ` +
        `(minimum required: ${minRequired}). ` +
        `margin_fact has NOT been modified. ` +
        `Fix the fetch failures and retry.`,
      );
    }
  }

  // 6 — truncate + insert
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

async function fetchWorkbookViaDriveExport(
  fileId: string,
  mimeType: string,
  timeoutMs = 120_000,
): Promise<WorkbookLike> {
  const rawBuf = await downloadDriveFileBuffer(fileId, mimeType, timeoutMs);
  const excelWb = new ExcelJS.Workbook();
  // exceljs types declare load(buffer: Buffer) using the legacy non-generic
  // Buffer; newer @types/node returns Buffer<ArrayBufferLike> which tsc
  // rejects.  The runtime value is identical — suppress the mismatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await excelWb.xlsx.load(rawBuf as any);

  const worksheets: WorksheetLike[] = excelWb.worksheets.map((ws) => ({
    name: ws.name,
    eachRow(
      cb: (row: { getCell(col: number): CellLike }, rowNumber: number) => void,
    ) {
      ws.eachRow((row, rowNumber) => {
        cb(
          {
            getCell(col1Based: number): CellLike {
              const cell = row.getCell(col1Based);
              return { value: excelCellValue(cell.value) };
            },
          },
          rowNumber,
        );
      });
    },
  }));

  return {
    worksheets,
    getWorksheet(name: string) {
      return worksheets.find((w) => w.name === name);
    },
  };
}
