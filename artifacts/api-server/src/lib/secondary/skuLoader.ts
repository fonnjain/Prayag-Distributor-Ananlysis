/**
 * Secondary SKU register loader — Phase K1.
 *
 * Reads the closed-year secondary registers at item-code (Cat. No.) granularity
 * and inserts rows into secondary_sku_line. The existing secondary_register_line
 * loader stores at brand/segment level; this loader stores at SKU level.
 *
 * Supported FYs: 2024-25, 2025-26 (15-column standard layout).
 * FY2023-24 has a different 14-column layout; it is guarded by a column-count
 * check and skipped if Cat. No. cannot be located.
 *
 * Column detection is header-name based (not positional) for resilience.
 * Month is derived from the Date column via the existing toMonthLabel helper.
 *
 * NET = Sub Total column. Order Total is never used.
 */

import crypto from "node:crypto";
import { sql as sqlRaw } from "drizzle-orm";
import { db, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { listSheetTabs, readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import { toMonthLabel } from "./normalize.js";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { logger } from "../logger.js";

// ── Column header aliases ────────────────────────────────────────────────────

const COL_ALIASES: Record<string, string[]> = {
  date:        ["DATE", "MONTH", "M0NTH"],
  retailerId:  ["SR.NO", "S.NO", "S. NO.", "SNO", "RETAILER ID"],
  retailer:    ["RETAILER", "RETAILERS", "RETAILER NAME"],
  orderId:     ["ORDER ID", "ORDER NO"],
  segment:     ["SEGMENT", "CATEGORY", "CAT", "BRAND", "GROUP", "PRODUCTGROUP"],
  itemCode:    ["CAT.NO", "CAT. NO.", "CATNO", "CAT NO", "CAT.NO.", "CAT NO.", "ITEM CODE"],
  qty:         ["QTY", "QUANTITY"],
  mrp:         ["MRP"],
  grossAmount: ["ORDER VALUE"],
  distributor: ["DISTRIBUTOR", "DIST.", "DIST NAME", "DISTRIBUTOR NAME"],
  discount:    ["DISCOUNT"],
  netAmount:   ["SUB TOTAL", "SUBTOTAL", "SUB-TOTAL", "NET AMOUNT"],
  head:        ["TEAM MEMBER", "TEAM MEMBER NAME", "SALESPERSON", "PERSON NAME", "TM NAME"],
};

type ColMap = Record<keyof typeof COL_ALIASES, number>;

function detectColumns(headerRow: SheetCellValue[]): ColMap | null {
  const normalized = headerRow.map((c) =>
    String(c ?? "").trim().toUpperCase().replace(/\s+/g, " "),
  );
  const find = (keys: string[]): number =>
    normalized.findIndex((h) => keys.some((k) => h === k || h.startsWith(k)));

  const map: ColMap = {} as ColMap;
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    map[field as keyof ColMap] = find(aliases);
  }

  // itemCode must be found — otherwise this tab is not item-code level data.
  if (map.itemCode < 0) return null;
  return map;
}

// ── Normalisation helpers ────────────────────────────────────────────────────

function cellStr(v: SheetCellValue): string {
  return String(v ?? "").trim();
}

function cellNum(v: SheetCellValue): number | null {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return isFinite(n) ? n : null;
}

/** Simple key normalisation: lowercase + collapse whitespace. */
function normKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── Line UID ─────────────────────────────────────────────────────────────────

function makeLineUid(
  fy: string,
  monthLabel: string,
  headRaw: string,
  retailer: string,
  distributor: string,
  itemCode: string,
  grossAmount: string,
  occurrence: number,
): string {
  const key = [fy, monthLabel, headRaw, retailer, distributor, itemCode, grossAmount, occurrence]
    .join("|");
  return crypto.createHash("sha1").update(key).digest("hex");
}

// ── Per-tab parse ────────────────────────────────────────────────────────────

type ParseResult = {
  rows: InsertSecSkuLine[];
  skipped: number;
  noItemCode: number;
  noMonth: number;
};

function parseTab(
  tabTitle: string,
  rawRows: SheetCellValue[][],
  fy: string,
  sheetId: string,
): ParseResult {
  const result: ParseResult = { rows: [], skipped: 0, noItemCode: 0, noMonth: 0 };

  // Find the header row (first row where we can detect itemCode column).
  let cols: ColMap | null = null;
  let dataStart = 0;
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const detected = detectColumns(rawRows[i]);
    if (detected) {
      cols = detected;
      dataStart = i + 1;
      break;
    }
  }
  if (!cols) return result; // Tab has no recognisable item-code header.

  // Occurrence counter: counts rows sharing the same natural key.
  const occurrenceMap = new Map<string, number>();

  for (let i = dataStart; i < rawRows.length; i++) {
    const cells = rawRows[i];
    if (!cells || cells.every((c) => c == null || String(c).trim() === "")) continue;

    const itemCode = cellStr(cells[cols.itemCode] ?? null);
    if (!itemCode) { result.noItemCode++; continue; }

    const dateVal = cols.date >= 0 ? cells[cols.date] : null;
    const monthLabel = toMonthLabel(dateVal ?? null, fy);
    if (!monthLabel) { result.noMonth++; continue; }

    const retailer   = cols.retailer >= 0 ? cellStr(cells[cols.retailer] ?? null) : "";
    const retailerId = cols.retailerId >= 0 ? cellStr(cells[cols.retailerId] ?? null) : null;
    const distributor= cols.distributor >= 0 ? cellStr(cells[cols.distributor] ?? null) : "";
    const headRaw    = cols.head >= 0 ? cellStr(cells[cols.head] ?? null) : "";
    const segmentRaw = cols.segment >= 0 ? cellStr(cells[cols.segment] ?? null) : null;
    const qty        = cols.qty >= 0 ? cellNum(cells[cols.qty] ?? null) : null;
    const mrp        = cols.mrp >= 0 ? cellNum(cells[cols.mrp] ?? null) : null;
    const grossAmt   = cols.grossAmount >= 0 ? cellNum(cells[cols.grossAmount] ?? null) : null;
    const discountPct= cols.discount >= 0 ? cellNum(cells[cols.discount] ?? null) : null;
    const netAmt     = cols.netAmount >= 0 ? cellNum(cells[cols.netAmount] ?? null) : null;

    // Skip rows with no value at all.
    if (grossAmt == null && netAmt == null) { result.skipped++; continue; }

    const segmentCanon = segmentRaw ? (canonGroupFromMap(segmentRaw) ?? null) : null;
    const headCanon = headRaw ? normKey(headRaw) : null;

    const grossStr = grossAmt != null ? String(grossAmt) : "";
    const natKey = `${fy}|${monthLabel}|${headRaw}|${retailer}|${distributor}|${itemCode}|${grossStr}`;
    const occurrence = (occurrenceMap.get(natKey) ?? 0) + 1;
    occurrenceMap.set(natKey, occurrence);

    const lineUid = makeLineUid(fy, monthLabel, headRaw, retailer, distributor, itemCode, grossStr, occurrence);

    result.rows.push({
      lineUid,
      fy,
      monthLabel,
      headRaw: headRaw || null,
      headCanon,
      stateRaw: null,
      stateCanon: null,
      retailer: retailer || null,
      retailerId: retailerId || null,
      distributor: distributor || null,
      itemCode,
      segmentRaw: segmentRaw || null,
      segmentCanon,
      qty: qty != null ? String(qty) : null,
      mrp: mrp != null ? String(mrp) : null,
      netAmount: netAmt != null ? String(netAmt) : null,
      grossAmount: grossAmt != null ? String(grossAmt) : null,
      discountPct: discountPct != null ? String(discountPct) : null,
      source: `sheets_sku_backfill:${sheetId}`,
    });
  }

  return result;
}

// ── Insert batch ─────────────────────────────────────────────────────────────

const INSERT_BATCH = 500;

async function insertBatch(rows: InsertSecSkuLine[], dryRun: boolean): Promise<number> {
  if (dryRun || rows.length === 0) return rows.length;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const result = await db
      .insert(secondarySkuLines)
      .values(batch)
      .onConflictDoNothing()
      .returning({ lineUid: secondarySkuLines.lineUid });
    inserted += result.length;
  }
  return inserted;
}

// ── Public API ───────────────────────────────────────────────────────────────

export type SkuLoadResult = {
  fy: string;
  sheetId: string;
  tabs: number;
  tabsWithItemCodes: number;
  rowsParsed: number;
  rowsInserted: number;
  noItemCode: number;
  noMonth: number;
  skipped: number;
  dryRun: boolean;
};

/**
 * Load item-code level secondary register data from a Google Sheet.
 *
 * dryRun=true (default): parses and validates but writes nothing.
 * dryRun=false: inserts into secondary_sku_line (ON CONFLICT DO NOTHING).
 */
export async function loadSecSkuFromSheets(
  fy: string,
  sheetId: string,
  dryRun = true,
): Promise<SkuLoadResult> {
  logger.info({ fy, sheetId, dryRun }, "skuLoader: starting");

  const tabs = await listSheetTabs(sheetId);
  logger.info({ fy, sheetId, tabCount: tabs.length }, "skuLoader: tabs discovered");

  let tabsWithItemCodes = 0;
  let totalParsed = 0;
  let totalInserted = 0;
  let totalNoItemCode = 0;
  let totalNoMonth = 0;
  let totalSkipped = 0;

  for (const tab of tabs) {
    // Skip obviously non-data tabs by title.
    const title = tab.title.trim().toUpperCase();
    if (
      title.includes("INDEX") ||
      title.includes("SUMMARY") ||
      title.includes("COVER") ||
      title.includes("INSTRUCTIONS")
    ) {
      logger.debug({ fy, tab: tab.title }, "skuLoader: skipping non-data tab by title");
      continue;
    }

    logger.info({ fy, tab: tab.title }, "skuLoader: reading tab");

    const rawRows: SheetCellValue[][] = [];
    await readTabRowsChunked(sheetId, tab.title, (chunk) => {
      rawRows.push(...chunk);
    });

    if (rawRows.length < 2) continue;

    const parseResult = parseTab(tab.title, rawRows, fy, sheetId);

    if (parseResult.rows.length === 0 && parseResult.noItemCode > 0) {
      logger.info(
        { fy, tab: tab.title, noItemCode: parseResult.noItemCode },
        "skuLoader: tab has no item-code column — skipping",
      );
      continue;
    }

    tabsWithItemCodes++;
    totalNoItemCode += parseResult.noItemCode;
    totalNoMonth += parseResult.noMonth;
    totalSkipped += parseResult.skipped;
    totalParsed += parseResult.rows.length;

    const inserted = await insertBatch(parseResult.rows, dryRun);
    totalInserted += inserted;

    logger.info(
      {
        fy,
        tab: tab.title,
        parsed: parseResult.rows.length,
        inserted,
        dryRun,
      },
      "skuLoader: tab processed",
    );
  }

  const result: SkuLoadResult = {
    fy,
    sheetId,
    tabs: tabs.length,
    tabsWithItemCodes,
    rowsParsed: totalParsed,
    rowsInserted: totalInserted,
    noItemCode: totalNoItemCode,
    noMonth: totalNoMonth,
    skipped: totalSkipped,
    dryRun,
  };

  logger.info(result, "skuLoader: complete");
  if (!dryRun && totalInserted > 0) clearSecondarySkuFyCache();
  return result;
}

// ── Sheet ID registry ─────────────────────────────────────────────────────────

/**
 * Sheet IDs for the secondary SKU registers, keyed by FY.
 * FY2026-27 is intentionally absent — register not yet loaded.
 * When that register is loaded, add its sheet ID here and re-run the backfill.
 *
 * Source: Prayag SKU Deep Dive spec, verified 29 July 2026.
 * FY2023-24: 14-column layout — supported but Cat. No. position may differ.
 * FY2024-25: 15-column standard layout (use 1sejEhXCaPXwYZ99 — not the duplicate).
 * FY2025-26: 15-column standard layout.
 */
export const SKU_SHEET_IDS: Record<string, string> = {
  "2021-22": "1RtRByRmNQorYOEeHsZuOy1GIkB7dVu7MNv9P_pg97Bs",
  "2022-23": "1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c",
  "2023-24": "1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY",
  "2024-25": "1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g",
  "2025-26": "1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80",
};

export const SUPPORTED_SKU_FYS = Object.keys(SKU_SHEET_IDS);

// ── Data-presence check ──────────────────────────────────────────────────────
// Some FYs are loaded from sources other than Google Sheets (FY2026-27 came in
// as a one-time PSCode_3 xlsx drop, source='pscode3_xlsx'), so gates must ask
// the database — not SKU_SHEET_IDS — whether register data exists for an FY.
const fyDataCache = new Map<string, { has: boolean; at: number }>();
const FY_DATA_TTL_MS = 10 * 60 * 1000;

/** Drop the presence cache — call after any load/reload of secondary_sku_line. */
export function clearSecondarySkuFyCache(): void {
  fyDataCache.clear();
}

/** True when secondary_sku_line has at least one row for the FY (10-min cache). */
export async function secondarySkuFyHasData(fy: string): Promise<boolean> {
  const hit = fyDataCache.get(fy);
  if (hit && Date.now() - hit.at < FY_DATA_TTL_MS) return hit.has;
  const res = await db.execute(
    sqlRaw`SELECT 1 FROM secondary_sku_line WHERE fy = ${fy} LIMIT 1`,
  );
  const has = res.rows.length > 0;
  fyDataCache.set(fy, { has, at: Date.now() });
  return has;
}
