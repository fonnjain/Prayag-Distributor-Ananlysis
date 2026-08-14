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
  getDriveFileMeta,
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
  /** Duplicate files skipped because every code and value matched row-for-row. */
  filesSkipped: { skipped: string; keptInstead: string; segment: string; monthLabel: string }[];
  /** Groups where copies agree on all shared-code values but some codes appear in only
   *  a subset of files (extra rows).  The union of all codes was loaded — no data lost. */
  filesUnion: {
    files: string[];
    segment: string;
    monthLabel: string;
    extraCodes: { code: string; fromFile: string }[];
    rowsLoaded: number;
  }[];
  /** Groups where at least one shared item code carries different values across copies.
   *  NONE of the files was loaded — requires manual resolution.
   *  files[].modifiedTime / files[].owners come from Drive files.get at load time.
   *  Never infer currency from folder position or filename — use modifiedTime. */
  filesConflict: {
    files: { name: string; id: string; modifiedTime?: string; owners?: string[] }[];
    segment: string;
    monthLabel: string;
    codeDiffs: {
      code: string;
      values: {
        filename: string;
        qty: number | null; avgSale: number | null;
        bomCost: number | null; mrp: number | null; discountFrac: number | null;
      }[];
    }[];
  }[];
  rowsInserted: number;
  rowsByFySegment: Record<string, number>;
  distinctCodes: number;
  cumulativeValidation: CumulativeCheck[];
  negativeContributionCount: number;
  negativeContributionTop10: {
    code: string; segment: string; qty: number; avgSale: number; bomCost: number;
  }[];
}

// ── Parsed-file result (for dedup) ────────────────────────────────────────

interface ParsedResult {
  cf: ClassifiedFile;
  rows: MarginRow[];
}

// ── Numeric equality with tiny tolerance for float representation noise ────────
function numsEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;   // both absent
  if (a == null || b == null) return false;  // one absent, one present
  if (a === b) return true;                  // fast path: exact match
  const mag = (Math.abs(a) + Math.abs(b)) / 2;
  return mag < 1e-12 || Math.abs(a - b) / mag < 1e-9;
}

/** For conflict-detection only: treat null and 0 as equivalent no-cost markers.
 *  Stored values are never coerced — NULL and 0 remain distinguishable in margin_fact,
 *  because 0 may one day represent a real (zero) BOM cost. */
function bomCostEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  const aNone = a == null || a === 0;
  const bNone = b == null || b === 0;
  if (aNone && bNone) return true;   // both are "no cost" — not a conflict
  return numsEqual(a, b);
}

// ── Row-by-row code-level comparison for deduplication ────────────────────────

interface CodeDiff {
  code: string;
  values: {
    filename: string;
    qty: number | null;
    avgSale: number | null;
    bomCost: number | null;
    mrp: number | null;
    discountFrac: number | null;
  }[];
}

type CompareResult =
  | { kind: "identical"; rows: MarginRow[]; skippedFiles: string[] }
  | { kind: "union"; rows: MarginRow[]; extraCodes: { code: string; fromFile: string }[] }
  | { kind: "conflict"; codeDiffs: CodeDiff[] };

/**
 * Compare multiple ParsedResult objects for the same (segment, monthLabel).
 *
 *   identical — every copy carries the same codes with identical values.
 *               Keep the first; log the rest as SKIP.
 *   union     — copies agree on every shared code's values, but some codes appear
 *               in only a subset of files.  Load the union (superset) of all codes.
 *   conflict  — at least one code that appears in 2+ files has differing values.
 *               Load NONE; report the disagreeing codes and each file's values.
 *
 * Aggregate-sum equality (the old gate) is not sufficient: two files can have the
 * same rounded sum(qty)/sum(avgSale)/sum(bomCost) while individual codes carry
 * different per-unit costs — confirmed for PTMT (1.06pp BOM% gap).
 */
function compareCodeLevel(group: ParsedResult[]): CompareResult {
  const maps = group.map((g) => new Map(g.rows.map((r) => [r.itemCode, r])));
  const allCodes = new Set<string>(group.flatMap((g) => g.rows.map((r) => r.itemCode)));

  const codeDiffs: CodeDiff[] = [];
  const extraItems: { code: string; fromFile: string; row: MarginRow }[] = [];

  for (const code of allCodes) {
    const present = group
      .map((g, i) => ({ i, filename: g.cf.file.name, row: maps[i].get(code) }))
      .filter((e): e is { i: number; filename: string; row: MarginRow } => e.row !== undefined);

    if (present.length === 1) {
      // Present in exactly one file — extra row; no conflict possible.
      extraItems.push({ code, fromFile: present[0].filename, row: present[0].row });
    } else {
      // Present in 2+ files — check value agreement across those files.
      const base = present[0].row;
      const hasDiff = present.slice(1).some(
        (e) =>
          !numsEqual(e.row.qty, base.qty) ||
          !numsEqual(e.row.avgSale, base.avgSale) ||
          !bomCostEqual(e.row.bomCost, base.bomCost) ||
          !numsEqual(e.row.mrp, base.mrp) ||
          !numsEqual(e.row.discountFrac, base.discountFrac),
      );
      if (hasDiff) {
        codeDiffs.push({
          code,
          values: present.map((e) => ({
            filename: e.filename,
            qty: e.row.qty,
            avgSale: e.row.avgSale,
            bomCost: e.row.bomCost,
            mrp: e.row.mrp,
            discountFrac: e.row.discountFrac,
          })),
        });
      } else if (present.length < group.length) {
        // Agrees across files that have it, but missing from some others.
        extraItems.push({ code, fromFile: present[0].filename, row: base });
      }
      // All files have it and all agree → covered by base row set; no action needed.
    }
  }

  if (codeDiffs.length > 0) {
    return { kind: "conflict", codeDiffs };
  }

  if (extraItems.length === 0) {
    return {
      kind: "identical",
      rows: group[0].rows,
      skippedFiles: group.slice(1).map((g) => g.cf.file.name),
    };
  }

  // Extra-codes-only: build union = first file's rows + extra codes from other files.
  const firstCodeSet = new Set(group[0].rows.map((r) => r.itemCode));
  const unionRows: MarginRow[] = [...group[0].rows];
  const seenExtra = new Set<string>();
  for (const { code, row } of extraItems) {
    if (!firstCodeSet.has(code) && !seenExtra.has(code)) {
      unionRows.push(row);
      seenExtra.add(code);
    }
  }

  const reportedExtra = extraItems
    .filter((e, idx, arr) => arr.findIndex((x) => x.code === e.code) === idx)
    .map((e) => ({ code: e.code, fromFile: e.fromFile }));

  return { kind: "union", rows: unionRows, extraCodes: reportedExtra };
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
  // Oct–Dec belong to the first calendar year of the Indian FY (Apr–Mar).
  // e.g. FY2025-26 October = Oct-25, not Oct-26.
  Oct: "first", Nov: "first", Dec: "first",
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
// Scans rows 1-12 for a row where:
//   • col B contains CODE or ITEM CODE
//   • the row contains DISCOUNT
//   • the row contains BOM COST or PUR RATE
//
// Column scan covers the full used range (up to 50 cols) so that dual-section
// workbooks like Plumbing — where BOM Cost appears at col 27+ — are detected.

export function detectGpMarginTabs(
  wb: WorkbookLike,
): { ws: WorksheetLike; headerRow: number; colMap: ColMap }[] {
  const hits: { ws: WorksheetLike; headerRow: number; colMap: ColMap }[] = [];

  for (const ws of wb.worksheets) {
    let hit: { headerRow: number; colMap: ColMap } | null = null;

    ws.eachRow((row, ri) => {
      if (hit) return; // already found header for this sheet
      if (ri > 12) return; // header must be in rows 1-12

      const cells: string[] = [];
      for (let ci = 1; ci <= 50; ci++) {
        cells.push(
          String(row.getCell(ci).value ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase(),
        );
      }
      // Trim trailing empty cells so the array length reflects actual content
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();

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
  // ── Precision-ordered column lookup ──────────────────────────────────────
  // Three passes across ALL patterns before falling to the next precision tier.
  // This prevents a low-precision match on an early pattern from beating a
  // high-precision match on a later pattern.
  //
  // Pass 1 — exact match (all patterns)
  // Pass 2 — startsWith (all patterns)
  // Pass 3 — includes  (all patterns), but reject growth / percentage headers
  //           because a column like "Growth % New Bom Cost VS Old Bom Cost"
  //           must never be treated as a cost column.
  const idx = (...patterns: string[]): number | null => {
    // Pass 1: exact
    for (const p of patterns) {
      const i = cells.findIndex((c) => c === p);
      if (i >= 0) return i + 1;
    }
    // Pass 2: startsWith
    for (const p of patterns) {
      const i = cells.findIndex((c) => c.startsWith(p));
      if (i >= 0) return i + 1;
    }
    // Pass 3: includes — skip growth/percentage columns
    for (const p of patterns) {
      const i = cells.findIndex(
        (c) => c.includes(p) && !c.includes("GROWTH") && !c.includes("%"),
      );
      if (i >= 0) return i + 1;
    }
    return null;
  };

  // Resolve the two anchor columns first — they establish which "section" of
  // a dual-section workbook (e.g. Plumbing) contains the actual sales data.
  const avgSaleCol = idx("AVG SALE RATE", "AVG SALE", "AVGSALE");
  const bomCostCol = idx("BOM COST", "BOMCOST", "PUR RATE", "PURRATE");

  // sectionStart: the leftmost position of the key cost/sale columns.
  // For single-section workbooks this is just left of col 8-9.
  // For dual-section workbooks (Plumbing: cols 19-33) this jumps to col 25+,
  // pushing the CODE and QTY search window into the correct right-hand section.
  const sectionStart =
    avgSaleCol != null || bomCostCol != null
      ? Math.min(avgSaleCol ?? Infinity, bomCostCol ?? Infinity) - 1
      : cells.length;

  // CODE: search right-to-left from just before sectionStart.
  // The rightmost exact "CODE" / "ITEM CODE" wins, so the sales-section code
  // column is preferred over any same-named BOM-breakdown column to its left.
  const codeCol = (() => {
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "CODE" || h === "ITEM CODE") return i + 1;
    }
    return 2; // fallback: col B
  })();

  // QTY: same right-to-left search so we pick the sales QTY, not a BOM
  // consumption quantity that appears earlier in a dual-section layout.
  const qtyCol = (() => {
    for (let i = sectionStart - 1; i >= 0; i--) {
      const h = cells[i];
      if (h === "QTY" || h.startsWith("QTY")) return i + 1;
    }
    return 3; // fallback: col C
  })();

  const saleValueCols: number[] = [];
  cells.forEach((c, i) => {
    if (c.includes("SALE VALUE") || c.includes("SALEVALUE")) saleValueCols.push(i + 1);
  });

  return {
    code: codeCol,
    qty: qtyCol,
    weight: idx("TOTAL  WEIGHT", "TOTAL WEIGHT", "TOTALWEIGHT") ?? idx("WEIGHT"),
    mrp: idx("MRP"),
    discount: idx("DISCOUNT"),
    avgSale: avgSaleCol,
    bomCost: bomCostCol,
    saleValue: saleValueCols[0] ?? null,
    bomValue: saleValueCols[1] ?? null,
  };
}

// ── Row extraction ─────────────────────────────────────────────────────────

export function extractRows(
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

export async function loadGpMarginFiles(opts?: { segments?: string[] }): Promise<LoadReport> {
  const report: LoadReport = {
    filesScanned: 0,
    filesLoaded: 0,
    filesCumulative: [],
    filesSummary: [],
    filesUnknown: [],
    filesSkipped: [],
    filesUnion: [],
    filesConflict: [],
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

  // When opts.segments is given, restrict the load to those segments only.
  // Step 6 DELETE is also scoped so other segments' rows are untouched.
  const segFilter = opts?.segments && opts.segments.length > 0 ? opts.segments : null;
  const filteredMonthly    = segFilter ? monthlyFiles.filter((f) => segFilter.includes(f.segment!))    : monthlyFiles;
  const filteredCumulative = segFilter ? cumulativeFiles.filter((f) => segFilter.includes(f.segment!)) : cumulativeFiles;

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
  //
  // Parsed results are collected first (not pushed directly to allRows) so that
  // content-fingerprint deduplication can run across the full result set before
  // any rows are committed.  See Step 3b below.
  const parsedResults: ParsedResult[] = [];
  const cumulativeParsed: Map<string, { filename: string; qty: number; saleValue: number }> = new Map();

  const BATCH_SIZE = 5;
  const WORKER_TIMEOUT_MS = 90_000;

  async function fetchAndParse(
    cf: (typeof monthlyFiles)[0],
    fileIdx: number,
  ): Promise<void> {
    logger.info(
      { n: fileIdx, of: filteredMonthly.length, file: cf.file.name, fy: cf.fy, segment: cf.segment },
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

    const fileRows: MarginRow[] = [];
    for (const { ws, headerRow, colMap } of tabs) {
      const rows = extractRows(ws, headerRow, colMap, cf.fy, cf.monthLabel!, cf.segment, cf.file.name);
      fileRows.push(...rows);
    }
    logger.info(
      { n: fileIdx, of: filteredMonthly.length, file: cf.file.name, tabs: tabs.length, rows: fileRows.length },
      "gpMargin: file loaded",
    );
    report.filesLoaded++;

    parsedResults.push({ cf, rows: fileRows });
  }

  for (let b = 0; b < filteredMonthly.length; b += BATCH_SIZE) {
    const batch = filteredMonthly.slice(b, b + BATCH_SIZE);
    logger.info(
      { batchStart: b + 1, batchEnd: b + batch.length, total: filteredMonthly.length },
      "gpMargin: starting batch",
    );
    await Promise.allSettled(
      batch.map((cf, i) => fetchAndParse(cf, b + i + 1)),
    );
    logger.info({ batchStart: b + 1, batchEnd: b + batch.length }, "gpMargin: batch complete");
  }

  // 3b — Row-by-row code-level deduplication.
  //
  // Drive may have two folders per segment per FY (e.g. "Plumbing GP MARGIN 25-26" inside
  // "GP MARGIN FY 25-26" AND "PLUMBING SALE GP MARGIN 25-26" at the top level).  The same
  // monthly files appear in both folders with DIFFERENT file IDs, so seenFileIds cannot catch
  // them.  We deduplicate here by comparing files code-by-code.
  //
  // Three outcomes per (segment, monthLabel) group with multiple files:
  //   identical — every copy carries the same codes and identical per-code values.
  //               Keep the first; log the rest as SKIP.
  //   union     — copies agree on every shared code's values, but some codes appear in only a
  //               subset of files (extra rows only).  Load the union (superset) — no data lost.
  //   conflict  — at least one code present in 2+ files carries different values across them.
  //               Load NONE; record the disagreeing codes with both files' values and metadata.
  //               Never infer which copy is "current" from folder position or filename.
  //
  // Aggregate-sum equality (the old gate) was insufficient: two files can have identical
  // rounded sum(qty)/sum(avgSale)/sum(bomCost) while individual codes carry different values
  // (confirmed for PTMT: 1.06pp BOM% gap despite passing the old gate).
  const allRows: MarginRow[] = [];

  const byMonth = new Map<string, ParsedResult[]>();
  for (const pr of parsedResults) {
    const k = `${pr.cf.segment}|${pr.cf.monthLabel!}`;
    const arr = byMonth.get(k) ?? [];
    arr.push(pr);
    byMonth.set(k, arr);
  }

  for (const [, group] of byMonth.entries()) {
    if (group.length === 1) {
      allRows.push(...group[0].rows);
      continue;
    }

    const cmp = compareCodeLevel(group);
    const seg = group[0].cf.segment;
    const ml  = group[0].cf.monthLabel!;

    if (cmp.kind === "identical") {
      allRows.push(...cmp.rows);
      for (const skipped of cmp.skippedFiles) {
        logger.warn(
          { segment: seg, monthLabel: ml, keptInstead: group[0].cf.file.name, skipped },
          "gpMargin: duplicate file skipped — row-for-row identical",
        );
        report.filesSkipped.push({ skipped, keptInstead: group[0].cf.file.name, segment: seg, monthLabel: ml });
      }

    } else if (cmp.kind === "union") {
      allRows.push(...cmp.rows);
      logger.info(
        {
          segment: seg, monthLabel: ml,
          files: group.map((g) => g.cf.file.name),
          extraCodes: cmp.extraCodes.map((e) => e.code),
          rowsLoaded: cmp.rows.length,
        },
        "gpMargin: extra-codes-only duplicate — union loaded",
      );
      report.filesUnion.push({
        files: group.map((g) => g.cf.file.name),
        segment: seg, monthLabel: ml,
        extraCodes: cmp.extraCodes,
        rowsLoaded: cmp.rows.length,
      });

    } else {
      // conflict — fetch Drive metadata for all files in parallel (non-fatal).
      const metas = await Promise.all(
        group.map((g) =>
          getDriveFileMeta(g.cf.file.id).catch((err) => {
            logger.warn({ fileId: g.cf.file.id, err: String(err) }, "gpMargin: conflict metadata fetch failed");
            return null;
          }),
        ),
      );
      logger.error(
        {
          segment: seg, monthLabel: ml,
          files: group.map((g) => g.cf.file.name),
          codeDiffsCount: cmp.codeDiffs.length,
          conflictCodes: cmp.codeDiffs.map((d) => d.code).slice(0, 10),
        },
        "gpMargin: CONFLICT — shared item codes have differing values; loading NONE",
      );
      report.filesConflict.push({
        files: group.map((g, i) => ({
          name: g.cf.file.name,
          id: g.cf.file.id,
          modifiedTime: metas[i]?.modifiedTime,
          owners: metas[i]?.owners?.map((o) => `${o.displayName} <${o.emailAddress}>`),
        })),
        segment: seg,
        monthLabel: ml,
        codeDiffs: cmp.codeDiffs,
      });
    }
  }

  // 4 — parse cumulative files for cross-validation (subprocess, same timeout)
  for (const cf of filteredCumulative) {
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
  // For segment-targeted loads, require at least 1 file loaded (no 40% threshold — Drive's
  // absence of a segment's files is already caught by filteredMonthly.length === 0 below).
  // For full loads, the 40% threshold catches connector-wide Sheets failures.
  if (segFilter && filteredMonthly.length === 0) {
    throw new Error(
      `GP Margin segment reload aborted — no monthly files found on Drive for ` +
      `segment(s): ${segFilter.join(", ")}. margin_fact has NOT been modified.`,
    );
  }
  if (filteredMonthly.length > 0) {
    const minRequired = segFilter
      ? 1
      : Math.max(5, Math.ceil(filteredMonthly.length * 0.40));
    if (report.filesLoaded < minRequired) {
      throw new Error(
        `GP Margin load aborted — coverage too low to replace table: ` +
        `${report.filesLoaded} of ${filteredMonthly.length} monthly files loaded successfully ` +
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
    if (segFilter) {
      // Segment-targeted reload: only remove rows for the segments being reloaded
      // so all other segments' data survives.
      await client.query(
        "DELETE FROM margin_fact WHERE segment = ANY($1::text[])",
        [segFilter],
      );
    } else {
      await client.query("DELETE FROM margin_fact");
    }

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

// ── Read-only conflict detail (no DB writes) ───────────────────────────────

export interface ConflictDetailRow {
  month: string;
  files: { name: string; id: string }[];
  /** Code-level diffs — empty if copies are identical or only one copy was found. */
  codeDiffs: {
    code: string;
    qty: number | null;
    avgSale: number | null;
    copies: { filename: string; bomCost: number | null; bomPct: number | null }[];
  }[];
  /** Top 10 differing codes sorted by qty desc. */
  top10ByQty: {
    code: string;
    qty: number;
    avgSale: number;
    copies: { filename: string; bomCost: number | null; bomPct: number | null }[];
  }[];
  /** Weighted BOM% for each file copy across its full code set. */
  segBomPctPerCopy: { filename: string; bomPct: number | null }[];
}

/**
 * Fetch and compare all Drive copies of specific months for a given segment+FY.
 * Never writes to the database — read-only diagnostic.
 *
 * Use to produce an owner-facing comparison table when two Drive copies carry
 * different BOM cost values and a human must decide which is authoritative.
 */
export async function fetchSegmentConflictDetail(
  segment: string,
  fy: string,
  targetMonths: string[],
): Promise<ConflictDetailRow[]> {
  const segmentFolders = await discoverSegmentFolders();
  const seenFileIds = new Set<string>();
  const allClassified: ClassifiedFile[] = [];

  async function scanFolderReadOnly(
    folderId: string,
    folderFy: string,
    folderSegment: string,
  ): Promise<void> {
    let children: DriveApiFile[];
    try { children = await listDriveFolder(folderId); } catch { return; }
    for (const child of children) {
      if (child.mimeType === "application/vnd.google-apps.folder") {
        const childSeg =
          canonicalSegment(child.name) === "UNKNOWN" ? folderSegment : canonicalSegment(child.name);
        await scanFolderReadOnly(child.id, folderFy, childSeg);
        continue;
      }
      if (
        child.mimeType !== "application/vnd.google-apps.spreadsheet" &&
        !/\.(xlsx|xls)$/i.test(child.name)
      ) continue;
      if (seenFileIds.has(child.id)) continue;
      seenFileIds.add(child.id);
      if (folderSegment !== segment) continue;
      const cls = classifyFilename(child.name);
      if (cls !== "monthly") continue;
      const ml = parseMonthLabel(child.name, folderFy);
      if (!ml || !targetMonths.includes(ml)) continue;
      allClassified.push({
        file: child, fy: folderFy, segment: folderSegment,
        monthLabel: ml, mimeType: child.mimeType, classification: "monthly",
      });
    }
  }

  for (const sf of segmentFolders) {
    if (sf.fy !== fy) continue;
    await scanFolderReadOnly(sf.folderId, sf.fy, sf.segment);
  }

  // Fetch each file — Sheets subprocess first, Drive export fallback
  const TIMEOUT_S = 90;
  const parsedResults: ParsedResult[] = [];
  for (const cf of allClassified) {
    let wb: WorkbookLike;
    try {
      wb = await fetchWorkbookViaProcess(cf.file.id, TIMEOUT_S);
    } catch (sheetsErr) {
      try { wb = await fetchWorkbookViaDriveExport(cf.file.id, cf.mimeType); }
      catch { continue; }
    }
    const tabs = detectGpMarginTabs(wb);
    if (tabs.length === 0) continue;
    const fileRows: MarginRow[] = [];
    for (const { ws, headerRow, colMap } of tabs) {
      fileRows.push(...extractRows(ws, headerRow, colMap, cf.fy, cf.monthLabel!, cf.segment, cf.file.name));
    }
    parsedResults.push({ cf, rows: fileRows });
  }

  // Group by month and compare
  const byMonth = new Map<string, ParsedResult[]>();
  for (const pr of parsedResults) {
    const k = pr.cf.monthLabel!;
    const arr = byMonth.get(k) ?? [];
    arr.push(pr);
    byMonth.set(k, arr);
  }

  const results: ConflictDetailRow[] = [];
  for (const month of targetMonths) {
    const group = byMonth.get(month) ?? [];
    const files = group.map((g) => ({ name: g.cf.file.name, id: g.cf.file.id }));

    if (group.length < 2) {
      results.push({ month, files, codeDiffs: [], top10ByQty: [], segBomPctPerCopy: [] });
      continue;
    }

    const cmp = compareCodeLevel(group);
    if (cmp.kind !== "conflict") {
      results.push({ month, files, codeDiffs: [], top10ByQty: [], segBomPctPerCopy: [] });
      continue;
    }

    const codeDiffs = cmp.codeDiffs.map((d) => ({
      code: d.code,
      qty:     d.values[0]?.qty     ?? null,
      avgSale: d.values[0]?.avgSale ?? null,
      copies: d.values.map((v) => ({
        filename: v.filename,
        bomCost: v.bomCost,
        bomPct:
          v.avgSale != null && v.avgSale !== 0 && v.bomCost != null
            ? +((1 - v.bomCost / v.avgSale) * 100).toFixed(2)
            : null,
      })),
    }));

    const top10ByQty = [...codeDiffs]
      .sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0))
      .slice(0, 10)
      .map((d) => ({ code: d.code, qty: d.qty ?? 0, avgSale: d.avgSale ?? 0, copies: d.copies }));

    const segBomPctPerCopy = group.map((g) => {
      const totalSale = g.rows.reduce((s, r) => s + (r.avgSale ?? 0) * (r.qty ?? 0), 0);
      const totalBom  = g.rows.reduce((s, r) => s + (r.bomCost ?? 0) * (r.qty ?? 0), 0);
      return {
        filename: g.cf.file.name,
        bomPct: totalSale > 0 ? +((1 - totalBom / totalSale) * 100).toFixed(2) : null,
      };
    });

    results.push({ month, files, codeDiffs, top10ByQty, segBomPctPerCopy });
  }

  return results;
}

export async function fetchWorkbookViaDriveExport(
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
