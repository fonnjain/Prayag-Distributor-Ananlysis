// Secondary register loader — xlsx backfill and live Sheets reads.
// Handles FY2021-22 through FY2025-26 secondary sale registers.
// Mirrors the primary backfill.ts + xlsxStream.ts pattern.
//
// dryRun=true: runs full parse + validation, counts what would be inserted,
//              records audit run as status='dry_run', but writes NO data.
import ExcelJS from "exceljs";
import { logger } from "../logger.js";
import { listSheetTabs, readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import {
  detectSecHeader,
  parseSecRegisterRow,
  toSecRegLine,
  SecOccurrenceCounter,
} from "./normalize.js";
import { emptySecUnmapped } from "./types.js";
import type { CellValue, SecDryRunSummary } from "./types.js";
import { runSecRegisterValidators } from "./validate.js";
import {
  insertSecRegLineBatches,
  countExistingSecLineUids,
  recordSecIngestRun,
  buildSecIngestRun,
} from "./ingest.js";
import type { InsertSecRegLine } from "@workspace/db";
import sheetsConfig from "../../../config/secondary_sheets.json";
import colMapsConfig from "../../../config/secondary_column_maps.json";

// ── Shared cell-value flattener (same logic as xlsxStream.ts plainCellValue) ──

function plainCell(v: unknown): CellValue {
  if (v != null && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plainCell(o.result);
    if ("text" in o) return plainCell(o.text);
    if ("richText" in o && Array.isArray(o.richText)) {
      return o.richText
        .map((r) => (r as { text?: string }).text ?? "")
        .join("");
    }
    if ("error" in o) return null;
    return null;
  }
  return v as CellValue;
}

// ── Column-map version lookup ─────────────────────────────────────────────────

function getColMapVersion(fy: string): string {
  const registers = (
    sheetsConfig as {
      registers: Record<string, { column_map_key?: string } | null>;
    }
  ).registers;
  const entry = registers[fy];
  if (!entry) return "v1";
  return (entry as { column_map_key?: string }).column_map_key ?? "v1";
}

// ── Core parse pipeline (shared between xlsx and Sheets sources) ──────────────

function parseRows(
  rawRows: CellValue[][],
  fy: string,
  source: "sheets" | "xlsx_backfill",
  mapVersion: string,
): {
  lines: InsertSecRegLine[];
  rowsRead: number;
  fyCounts: Record<string, number>;
  unmapped: ReturnType<typeof emptySecUnmapped>;
  errors: string[];
} {
  const unmapped = emptySecUnmapped();
  const counter = new SecOccurrenceCounter();
  const lines: InsertSecRegLine[] = [];
  const fyCounts: Record<string, number> = {};
  const errors: string[] = [];
  let rowsRead = 0;

  const cols = detectSecHeader(rawRows, mapVersion);
  if (!cols) {
    errors.push(`No secondary register header found in first 20 rows for FY ${fy}`);
    return { lines, rowsRead, fyCounts, unmapped, errors };
  }

  // Rows after the header row
  const dataRows = rawRows.slice(cols.headerRowNumber);
  for (const cells of dataRows) {
    rowsRead++;
    const parsed = parseSecRegisterRow(cells, cols, fy);
    if (!parsed) continue;
    const line = toSecRegLine(parsed, counter, unmapped, source);
    lines.push(line);
    fyCounts[line.fy] = (fyCounts[line.fy] ?? 0) + 1;
  }

  return { lines, rowsRead, fyCounts, unmapped, errors };
}

// ── xlsx backfill ─────────────────────────────────────────────────────────────

export async function loadSecRegisterFromXlsx(
  filePath: string,
  fy: string,
  dryRun = false,
): Promise<SecDryRunSummary> {
  logger.info({ filePath, fy, dryRun }, "sec: streaming xlsx register");
  const mapVersion = getColMapVersion(fy);

  // Collect all rows first (secondary registers are significantly smaller than
  // primary ones — typically <20k rows — so full in-memory load is fine).
  const allRows: CellValue[][] = [];
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    worksheets: "emit",
  } as ConstructorParameters<typeof ExcelJS.stream.xlsx.WorkbookReader>[1]);

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).map(plainCell);
      allRows.push(values);
    }
    break; // first worksheet only
  }

  const { lines, rowsRead, fyCounts, unmapped, errors } = parseRows(
    allRows,
    fy,
    "xlsx_backfill",
    mapVersion,
  );

  const assertions = runSecRegisterValidators(lines, unmapped, fyCounts, fy);
  const anyFailed = assertions.some((a) => !a.passed);
  const status = dryRun ? "dry_run" : anyFailed ? "fail" : "ok";

  let existingInDb = 0;
  let rowsInserted = 0;

  if (!dryRun && !anyFailed) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
    const result = await insertSecRegLineBatches(lines, false);
    rowsInserted = result.inserted;
  } else if (dryRun) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
  }

  await recordSecIngestRun(
    buildSecIngestRun({
      source: "register_xlsx",
      fy,
      rowsRead,
      rowsInserted,
      rowsSkipped: lines.length - rowsInserted,
      unmapped,
      assertions,
      status,
    }),
    dryRun,
  );

  logger.info(
    { fy, rowsRead, lines: lines.length, dryRun, status },
    "sec: xlsx register loaded",
  );

  return {
    fy,
    source: "register_xlsx",
    rowsRead,
    rowsToInsert: lines.length,
    existingInDb,
    assertions,
    unmapped,
    anomalies: [],
    errors,
  };
}

// ── Sheets register loader ────────────────────────────────────────────────────

export async function loadSecRegisterFromSheets(
  fy: string,
  dryRun = false,
): Promise<SecDryRunSummary> {
  const registers = (
    sheetsConfig as {
      registers: Record<
        string,
        { sheet_id: string | null; column_map_key?: string } | null
      >;
    }
  ).registers;

  const entry = registers[fy];
  const sheetId = entry?.sheet_id ?? null;

  if (!sheetId) {
    return {
      fy,
      source: "register_sheets",
      rowsRead: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      assertions: [
        {
          name: "sheet_configured",
          passed: false,
          detail: `no sheet_id configured for FY ${fy} in secondary_sheets.json; add the real spreadsheet ID to enable this FY`,
        },
      ],
      unmapped: emptySecUnmapped(),
      anomalies: [],
      errors: [`FY ${fy} secondary register sheet_id is null — update secondary_sheets.json`],
    };
  }

  logger.info({ fy, sheetId, dryRun }, "sec: loading register from Sheets");
  const mapVersion = (entry as { column_map_key?: string }).column_map_key ?? "v1";

  // Discover tabs (secondary registers may have all data on one tab)
  let tabName: string | null = null;
  try {
    const tabs = await listSheetTabs(sheetId);
    // Try to find a tab matching known patterns; fall back to first tab.
    const PATTERNS = ["SECONDARY", "REGISTER", "DATA", "SALE"];
    tabName =
      tabs.find((t) =>
        PATTERNS.some((p) => t.title.toUpperCase().includes(p)),
      )?.title ?? tabs[0]?.title ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      fy,
      source: "register_sheets",
      rowsRead: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      assertions: [
        {
          name: "sheet_reachable",
          passed: false,
          detail: `could not list tabs: ${msg}`,
        },
      ],
      unmapped: emptySecUnmapped(),
      anomalies: [],
      errors: [msg],
    };
  }

  if (!tabName) {
    return {
      fy,
      source: "register_sheets",
      rowsRead: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      assertions: [
        {
          name: "sheet_reachable",
          passed: false,
          detail: "sheet has no tabs",
        },
      ],
      unmapped: emptySecUnmapped(),
      anomalies: [],
      errors: ["sheet has no tabs"],
    };
  }

  // Read all rows via chunked API (50k rows per request, 429-retried by sheetsApi)
  const allRows: CellValue[][] = [];
  await readTabRowsChunked(sheetId, tabName, (chunk) => {
    for (const row of chunk) {
      allRows.push(row.map((c): CellValue => c as CellValue));
    }
  });

  const { lines, rowsRead, fyCounts, unmapped, errors } = parseRows(
    allRows,
    fy,
    "sheets",
    mapVersion,
  );

  const assertions = runSecRegisterValidators(lines, unmapped, fyCounts, fy);
  const anyFailed = assertions.some((a) => !a.passed);
  const status = dryRun ? "dry_run" : anyFailed ? "fail" : "ok";

  let existingInDb = 0;
  let rowsInserted = 0;

  if (!dryRun && !anyFailed) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
    const result = await insertSecRegLineBatches(lines, false);
    rowsInserted = result.inserted;
  } else if (dryRun) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
  }

  await recordSecIngestRun(
    buildSecIngestRun({
      source: "register_sheets",
      fy,
      rowsRead,
      rowsInserted,
      rowsSkipped: lines.length - rowsInserted,
      unmapped,
      assertions,
      status,
    }),
    dryRun,
  );

  return {
    fy,
    source: "register_sheets",
    rowsRead,
    rowsToInsert: lines.length,
    existingInDb,
    assertions,
    unmapped,
    anomalies: [],
    errors,
  };
}
