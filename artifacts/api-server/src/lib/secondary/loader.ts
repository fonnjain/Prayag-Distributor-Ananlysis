// Secondary register loader — xlsx backfill and live Sheets reads.
// Handles FY2021-22 through FY2025-26 secondary sale registers.
// Mirrors the primary backfill.ts + xlsxStream.ts pattern.
//
// dryRun=true: runs full parse + validation, counts what would be inserted,
//              records audit run as status='dry_run', but writes NO data.
//
// ── Reporting architecture rule ───────────────────────────────────────────────
// The State Head Dashboard is the SOLE source for headline order booking and
// sales figures presented to users. The register (this loader) is DRILL-DOWN
// only — it provides line-level detail for analysis, not top-line numbers.
// Register-to-dashboard reconciliation runs MONTHLY, not annually.
// Never surface register grand totals as primary KPIs.
import ExcelJS from "exceljs";
import { logger } from "../logger.js";
import { listSheetTabs, readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import {
  detectSecHeader,
  isSubTotalRow,
  parseSecRegisterRow,
  toSecRegLine,
  SecOccurrenceCounter,
} from "./normalize.js";
import { emptySecUnmapped } from "./types.js";
import type { CellValue, SecGrain, SecDryRunSummary } from "./types.js";
import { runSecRegisterValidators } from "./validate.js";
import { crossFootByHead } from "./rules.js";
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

// ── FY config helpers ─────────────────────────────────────────────────────────

type TabStrategy = "first" | "all";

type RegisterEntry = {
  sheet_id: string | null;
  column_map_key?: string;
  grain?: string;
  tab?: string;
  tab_strategy?: TabStrategy;
};

function getRegisterEntry(fy: string): RegisterEntry | null {
  const registers = (
    sheetsConfig as { registers: Record<string, RegisterEntry | null> }
  ).registers;
  return registers[fy] ?? null;
}

function getColMapVersion(fy: string): string {
  const entry = getRegisterEntry(fy);
  return entry?.column_map_key ?? "v1";
}

// Read the data grain for the given FY from secondary_sheets.json.
// Falls back to the version's grain_default (v1 -> "line").
function getFyGrain(fy: string): SecGrain {
  const entry = getRegisterEntry(fy);
  const grainRaw = entry?.grain;
  if (grainRaw === "subtotal") return "subtotal";
  // Fall back to version grain_default
  const mapVersion = entry?.column_map_key ?? "v1";
  const versionDefault = (
    colMapsConfig.versions as Record<string, Record<string, unknown>>
  )[mapVersion]?.grain_default;
  if (versionDefault === "subtotal") return "subtotal";
  return "line";
}

// ── Core parse pipeline (shared between xlsx and Sheets sources) ──────────────

type ParseResult = {
  lines: InsertSecRegLine[];
  grain: SecGrain;
  rowsRead: number;
  dataRows: number;
  subTotalRowsExcluded: number;
  blankRowsSkipped: number;
  fyCounts: Record<string, number>;
  unmapped: ReturnType<typeof emptySecUnmapped>;
  errors: string[];
};

// parseRows processes one contiguous block of raw rows (potentially spanning
// multiple concatenated tabs). Header detection runs once against the first
// 20 rows; subsequent tab-header rows are blank-skipped because their amount
// cell ("Order Value") is a string that toNumber() cannot parse.
//
// Discount carry: in FY2021-22 through FY2023-24 the Discount % column is
// populated only on the FIRST row of each order group; continuation rows
// have a blank cell. lastDiscountPct carries the most recent non-blank
// discount forward so every row gets a net_amount. FY2024-25 and FY2025-26
// always have a non-blank Discount column, so carry has no effect there.
function parseRows(
  rawRows: CellValue[][],
  fy: string,
  source: "sheets" | "xlsx_backfill",
  mapVersion: string,
  grain: SecGrain,
): ParseResult {
  const unmapped = emptySecUnmapped();
  const counter = new SecOccurrenceCounter();
  const lines: InsertSecRegLine[] = [];
  const fyCounts: Record<string, number> = {};
  const errors: string[] = [];
  let rowsRead = 0;
  let subTotalRowsExcluded = 0;
  let blankRowsSkipped = 0;

  const cols = detectSecHeader(rawRows, mapVersion, grain);
  if (!cols) {
    errors.push(`No secondary register header found in first 20 rows for FY ${fy}`);
    return { lines, grain, rowsRead, dataRows: 0, subTotalRowsExcluded, blankRowsSkipped, fyCounts, unmapped, errors };
  }

  // Rows after the header row
  const dataRows = rawRows.slice(cols.headerRowNumber);

  // Discount carry state — resets per parseRows call (one FY / one batch).
  let lastDiscountPct: number | null = null;

  for (const cells of dataRows) {
    rowsRead++;

    // Sub-total detection: exclude summary/aggregation rows before parsing.
    if (isSubTotalRow(cells)) {
      subTotalRowsExcluded++;
      continue;
    }

    const parsed = parseSecRegisterRow(cells, cols, fy);
    if (!parsed) {
      blankRowsSkipped++;
      continue;
    }

    // ── Discount carry ────────────────────────────────────────────────────────
    // rawDiscountPct: what the cell actually said (null when blank).
    // effectiveDiscount: use raw if available; otherwise inherit from last order.
    // lastDiscountPct is updated only from raw (non-carried) reads so a missing
    // discount at the start of a new order doesn't inherit a stale value across
    // unrelated order groups.
    const rawDiscountPct = parsed.discountPct;
    const effectiveDiscount = rawDiscountPct ?? lastDiscountPct;
    parsed.discountPct = effectiveDiscount;
    // Prefer the Sub Total cell read directly from the sheet (accurate, avoids
    // rounding). Fall back to computing from discount % for continuation rows
    // where Sub Total is blank.
    if (parsed.netAmount == null && effectiveDiscount != null) {
      parsed.netAmount = Math.round(
        parsed.grossAmount * (1 - effectiveDiscount / 100) * 100,
      ) / 100;
    }
    if (rawDiscountPct != null) lastDiscountPct = rawDiscountPct;
    // ─────────────────────────────────────────────────────────────────────────

    const line = toSecRegLine(parsed, counter, unmapped, source);
    lines.push(line);
    fyCounts[line.fy] = (fyCounts[line.fy] ?? 0) + 1;
  }

  // Row accounting identity:
  //   rowsRead === lines.length + subTotalRowsExcluded + blankRowsSkipped
  const accounted = lines.length + subTotalRowsExcluded + blankRowsSkipped;
  if (accounted !== rowsRead) {
    errors.push(
      `Row accounting mismatch for FY ${fy}: read=${rowsRead} but data=${lines.length} + subtotal=${subTotalRowsExcluded} + blank=${blankRowsSkipped} = ${accounted}`,
    );
  }

  return {
    lines,
    grain,
    rowsRead,
    dataRows: lines.length,
    subTotalRowsExcluded,
    blankRowsSkipped,
    fyCounts,
    unmapped,
    errors,
  };
}

// ── xlsx backfill ─────────────────────────────────────────────────────────────

export async function loadSecRegisterFromXlsx(
  filePath: string,
  fy: string,
  dryRun = false,
): Promise<SecDryRunSummary> {
  const grain = getFyGrain(fy);
  const mapVersion = getColMapVersion(fy);
  logger.info({ filePath, fy, dryRun, grain }, "sec: streaming xlsx register");

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

  const result = parseRows(allRows, fy, "xlsx_backfill", mapVersion, grain);
  const { lines, rowsRead, dataRows, subTotalRowsExcluded, blankRowsSkipped, fyCounts, unmapped, errors } = result;

  const crossFoot = crossFootByHead(lines);
  const assertions = runSecRegisterValidators(lines, unmapped, fyCounts, fy);
  const anyFailed = assertions.some((a) => !a.passed);
  const status = dryRun ? "dry_run" : anyFailed ? "fail" : "ok";

  let existingInDb = 0;
  let rowsInserted = 0;

  if (!dryRun && !anyFailed) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
    const ins = await insertSecRegLineBatches(lines, false);
    rowsInserted = ins.inserted;
  } else if (dryRun) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
  }

  await recordSecIngestRun(
    buildSecIngestRun({
      source: "register_xlsx",
      fy,
      rowsRead,
      rowsInserted,
      rowsSkipped: blankRowsSkipped + subTotalRowsExcluded,
      unmapped,
      assertions,
      status,
    }),
    dryRun,
  );

  logger.info(
    { fy, grain, rowsRead, dataRows, subTotalRowsExcluded, blankRowsSkipped, lines: lines.length, dryRun, status },
    "sec: xlsx register loaded",
  );

  return {
    fy,
    source: "register_xlsx",
    grain,
    rowsRead,
    dataRows,
    subTotalRowsExcluded,
    blankRowsSkipped,
    rowsToInsert: lines.length,
    existingInDb,
    crossFoot,
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
  const entry = getRegisterEntry(fy);
  const sheetId = entry?.sheet_id ?? null;
  const grain = getFyGrain(fy);

  if (!sheetId) {
    return {
      fy,
      source: "register_sheets",
      grain,
      rowsRead: 0,
      dataRows: 0,
      subTotalRowsExcluded: 0,
      blankRowsSkipped: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      crossFoot: null,
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

  logger.info({ fy, sheetId, dryRun, grain }, "sec: loading register from Sheets");
  const mapVersion = entry?.column_map_key ?? "v1";
  const tabStrategy: TabStrategy = entry?.tab_strategy ?? "first";

  // Discover tabs
  let tabs: Array<{ title: string }> = [];
  try {
    tabs = await listSheetTabs(sheetId);
    logger.info(
      { fy, sheetId, tabStrategy, allTabs: tabs.map((t) => t.title) },
      "sec: tabs found in workbook",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      fy,
      source: "register_sheets",
      grain,
      rowsRead: 0,
      dataRows: 0,
      subTotalRowsExcluded: 0,
      blankRowsSkipped: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      crossFoot: null,
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

  if (tabs.length === 0) {
    return {
      fy,
      source: "register_sheets",
      grain,
      rowsRead: 0,
      dataRows: 0,
      subTotalRowsExcluded: 0,
      blankRowsSkipped: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      crossFoot: null,
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

  // ── Tab selection ─────────────────────────────────────────────────────────
  // "first": pick the first tab matching known name patterns; fall back to
  //          tab[0]. This is sufficient for FY2021-22 through FY2022-23 and
  //          FY2024-25 through FY2025-26 (single "Data Sheet" per workbook).
  //
  // "all": read ALL tabs and concatenate their rows before parsing. This
  //        handles FY2023-24 where one workbook may have data split across
  //        multiple month-specific tabs. Subsequent tabs' header rows are
  //        automatically blank-skipped by parseRows (their amount cell is a
  //        string, so toNumber() returns null → blankRowsSkipped++).
  let tabsToRead: string[];

  if (tabStrategy === "all") {
    tabsToRead = tabs.map((t) => t.title);
    logger.info({ fy, tabsToRead }, "sec: tab_strategy=all, reading all tabs");
  } else {
    const PATTERNS = ["SECONDARY", "REGISTER", "DATA", "SALE"];
    const match =
      tabs.find((t) =>
        PATTERNS.some((p) => t.title.toUpperCase().includes(p)),
      )?.title ?? tabs[0]?.title ?? null;
    if (!match) {
      return {
        fy,
        source: "register_sheets",
        grain,
        rowsRead: 0,
        dataRows: 0,
        subTotalRowsExcluded: 0,
        blankRowsSkipped: 0,
        rowsToInsert: 0,
        existingInDb: 0,
        crossFoot: null,
        assertions: [
          {
            name: "sheet_reachable",
            passed: false,
            detail: "no matching tab found",
          },
        ],
        unmapped: emptySecUnmapped(),
        anomalies: [],
        errors: ["no matching tab found"],
      };
    }
    tabsToRead = [match];
  }

  // ── Tab reading strategy ──────────────────────────────────────────────────
  // "first": single tab, single parseRows call, single occurrence counter.
  //
  // "all": each tab is processed independently with its own parseRows call
  //   (and therefore its own fresh SecOccurrenceCounter). This means:
  //   - Copy tabs (e.g. "June" = copy of "Data Sheet") produce the same
  //     natural keys + same occurrence numbers → identical line_uids →
  //     deduplicated in-memory before insert/counting.
  //   - Report/summary tabs (no valid header) yield 0 lines and are skipped.
  //   - Tabs with different months (e.g. "Data Sheet" = Apr, "Data-Sheet" =
  //     May onwards) produce non-overlapping month labels → different line_uids
  //     → both included.
  //   After all tabs, lines are deduped by line_uid, then fyCounts and
  //   unmapped are re-aggregated from the deduped set.

  let lines: InsertSecRegLine[];
  let rowsRead: number;
  let dataRows: number;
  let subTotalRowsExcluded: number;
  let blankRowsSkipped: number;
  let fyCounts: Record<string, number>;
  let unmapped: ReturnType<typeof emptySecUnmapped>;
  let errors: string[];

  if (tabStrategy === "all") {
    const allLines: InsertSecRegLine[] = [];
    let totalRowsRead = 0, totalSubTotalExcluded = 0, totalBlankSkipped = 0;
    const totalErrors: string[] = [];

    for (const tabName of tabsToRead) {
      const tabRows: CellValue[][] = [];
      await readTabRowsChunked(sheetId, tabName, (chunk) => {
        for (const row of chunk) tabRows.push(row.map((c): CellValue => c as CellValue));
      });

      if (tabRows.length === 0) {
        logger.info({ fy, tabName, rowsFetched: 0 }, "sec: tab rows fetched");
        continue;
      }

      logger.info(
        {
          fy,
          tabName,
          rowsFetched: tabRows.length,
          sample: tabRows
            .slice(0, 3)
            .map((r) => r.slice(0, 12).map((c) => (c == null ? "" : String(c))).join(" | ")),
        },
        "sec: tab rows fetched",
      );

      // Fresh parseRows call per tab = fresh occurrence counter.
      // Tabs with no valid register header produce 0 lines — this is expected
      // for summary/report tabs in "all" strategy and is NOT propagated as an error.
      // Use for-loop push instead of push(...spread) to avoid V8 call-stack
      // overflow when a tab returns tens-of-thousands of lines.
      const tabResult = parseRows(tabRows, fy, "sheets", mapVersion, grain);
      for (const l of tabResult.lines) allLines.push(l);
      // Suppress "no header" errors — normal for report/summary tabs in an "all" strategy.
      for (const e of tabResult.errors) {
        if (!e.startsWith("No secondary register header")) totalErrors.push(e);
      }
      totalRowsRead += tabResult.rowsRead;
      totalSubTotalExcluded += tabResult.subTotalRowsExcluded;
      totalBlankSkipped += tabResult.blankRowsSkipped;
    }

    // Dedup by line_uid: copy tabs produce identical line_uids → keep first.
    const seen = new Set<string>();
    const dedupedLines = allLines.filter((l) => {
      if (seen.has(l.lineUid)) return false;
      seen.add(l.lineUid);
      return true;
    });
    const dupCount = allLines.length - dedupedLines.length;
    if (dupCount > 0) {
      logger.info({ fy, dupCount, totalBeforeDedup: allLines.length }, "sec: duplicate line_uids removed (copy tabs)");
    }

    // Re-aggregate fyCounts and unmapped from the deduped line set.
    const mergedFyCounts: Record<string, number> = {};
    const mergedUnmapped = emptySecUnmapped();
    for (const l of dedupedLines) {
      mergedFyCounts[l.fy] = (mergedFyCounts[l.fy] ?? 0) + 1;
      if (l.headRaw && !l.headCanon) {
        mergedUnmapped.unmapped_heads[l.headRaw] = (mergedUnmapped.unmapped_heads[l.headRaw] ?? 0) + 1;
      }
      if (l.stateRaw && !l.stateCanon) {
        mergedUnmapped.unmapped_states[l.stateRaw] = (mergedUnmapped.unmapped_states[l.stateRaw] ?? 0) + 1;
      }
    }

    logger.info(
      {
        fy,
        tabsRead: tabsToRead.length,
        totalRowsFetched: totalRowsRead,
        totalLinesParsed: allLines.length,
        dedupedLines: dedupedLines.length,
        dupCount,
      },
      "sec: all tabs processed",
    );

    lines = dedupedLines;
    rowsRead = totalRowsRead;
    // dataRows is the per-tab total BEFORE dedup, so the row-accounting identity
    //   dataRows + subTotalExcluded + blankSkipped == rowsRead
    // holds. Deduplication is tracked separately via dupCount above.
    // rows_to_insert (reported by the CLI) uses lines.length (= dedupedLines).
    dataRows = allLines.length;
    subTotalRowsExcluded = totalSubTotalExcluded;
    blankRowsSkipped = totalBlankSkipped;
    fyCounts = mergedFyCounts;
    unmapped = mergedUnmapped;
    errors = totalErrors;
  } else {
    // Single tab: existing behaviour.
    const tabName = tabsToRead[0]!;
    const allRows: CellValue[][] = [];
    await readTabRowsChunked(sheetId, tabName, (chunk) => {
      for (const row of chunk) allRows.push(row.map((c): CellValue => c as CellValue));
    });
    logger.info(
      {
        fy,
        tabName,
        rowsFetched: allRows.length,
        sample: allRows
          .slice(0, 3)
          .map((r) => r.slice(0, 12).map((c) => (c == null ? "" : String(c))).join(" | ")),
      },
      "sec: tab rows fetched",
    );

    const result = parseRows(allRows, fy, "sheets", mapVersion, grain);
    lines = result.lines;
    rowsRead = result.rowsRead;
    dataRows = result.dataRows;
    subTotalRowsExcluded = result.subTotalRowsExcluded;
    blankRowsSkipped = result.blankRowsSkipped;
    fyCounts = result.fyCounts;
    unmapped = result.unmapped;
    errors = result.errors;
  }

  const crossFoot = crossFootByHead(lines);
  const assertions = runSecRegisterValidators(lines, unmapped, fyCounts, fy);
  const anyFailed = assertions.some((a) => !a.passed);
  const status = dryRun ? "dry_run" : anyFailed ? "fail" : "ok";

  let existingInDb = 0;
  let rowsInserted = 0;

  if (!dryRun && !anyFailed) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
    const ins = await insertSecRegLineBatches(lines, false);
    rowsInserted = ins.inserted;
  } else if (dryRun) {
    existingInDb = await countExistingSecLineUids(lines.map((l) => l.lineUid));
  }

  await recordSecIngestRun(
    buildSecIngestRun({
      source: "register_sheets",
      fy,
      rowsRead,
      rowsInserted,
      rowsSkipped: blankRowsSkipped + subTotalRowsExcluded,
      unmapped,
      assertions,
      status,
    }),
    dryRun,
  );

  return {
    fy,
    source: "register_sheets",
    grain,
    rowsRead,
    dataRows,
    subTotalRowsExcluded,
    blankRowsSkipped,
    rowsToInsert: lines.length,
    existingInDb,
    crossFoot,
    assertions,
    unmapped,
    anomalies: [],
    errors,
  };
}
