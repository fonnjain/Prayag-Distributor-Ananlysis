// Loads primary-dispatch Sale data (Taxable Value) from per-FY "State Head Sale"
// sheets, aggregated by STATE HEAD.
//
// Each FY has a dedicated spreadsheet containing Taxable Value and STATE HEAD
// columns. We read ALL tabs (not just monthly ones) to handle varying sheet
// layouts. The loader is intentionally identical in pattern to orderBookSale.ts
// so the same normalisation / head-resolver logic applies — spelling drift
// (BIJJU → Biju C.O, RIZVI JI → Syed Aqil Rizvi) never drops a head.
//
// Result is head-level only. It is passed to the frontend as meta.headSales;
// individual member rows have saleAmount = null (no per-member breakdown here).
import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normHead, buildHeadResolver } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

// Per-FY sheet configuration.
// Add a new entry whenever a "State Head Sale <FY>" sheet is created.
const SALE_SHEETS: Record<string, { id: string; label: string }> = {
  "2025-26": {
    id: "1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA",
    label: "State Head Sale 2025-26",
  },
  // FY2026-27 primary dispatch/invoice register (SAP-sourced, "2 years combined").
  // Order Sheet 26-27 (1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A) holds BOOKED
  // ORDERS, not dispatched invoices — it is handled separately as the primary order
  // booking source (loadOrderBookSaleByHead) and returned in meta.orderBookingPrimary.
  "2026-27": {
    id: "1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs",
    label: "State Head Sale 2026-27",
  },
};

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;

export type StateHeadSaleResult = {
  /** Display head name → Σ Taxable Value (rupees) */
  byHead: Map<string, number>;
  /** Company-wide total (all territory heads + non-territory) */
  total: number;
  /** Human-readable source label for UI attribution */
  label: string;
  /** Null on success; error message on failure */
  error: string | null;
};

// 30-minute in-process TTL cache keyed by FY.
const _cache = new Map<string, { ts: number; result: StateHeadSaleResult }>();
const TTL_MS = 30 * 60 * 1000;

export function invalidateStateHeadSaleCache(fy?: string): void {
  if (fy) {
    _cache.delete(fy);
  } else {
    _cache.clear();
  }
}

function numVal(v: SheetCellValue | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function strVal(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function findCol(headers: SheetCellValue[], re: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (re.test(strVal(headers[i]))) return i;
  }
  return -1;
}

/**
 * Load Taxable Value by STATE HEAD for the given FY.
 * Returns null-byHead result (error set) when no sheet is configured for the FY
 * or when the sheet cannot be reached.
 */
export async function loadStateHeadSale(fy: string): Promise<StateHeadSaleResult> {
  const cached = _cache.get(fy);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.result;

  const sheetCfg = SALE_SHEETS[fy];
  if (!sheetCfg) {
    // No primary-sale sheet configured for this FY — caller falls back to
    // orderBookSale (FY2026-27) or shows blank.
    return { byHead: new Map(), total: 0, label: `Primary Sale ${fy}`, error: `No sale sheet configured for ${fy}` };
  }

  const { id: sheetId, label } = sheetCfg;
  const byNormKey = new Map<string, number>();
  let nonTerritoryTotal = 0;
  let total = 0;
  let rowsRead = 0;
  let tabsWithData = 0;

  try {
    const tabs = await listSheetTabs(sheetId);

    // Exclude obvious non-data tabs (instructions, change logs, etc.)
    const SKIP_RE = /^(instruction|change.log|legend|notes?|readme|cover)/i;
    const dataTabs = tabs.filter((t) => !SKIP_RE.test(t.title.trim()));

    if (dataTabs.length === 0) {
      logger.warn(
        { fy, sheetId, allTabs: tabs.map((t) => t.title) },
        "stateHeadSale: no data tabs found",
      );
    }

    for (const tab of dataTabs) {
      let taxColIdx = -1;
      let headColIdx = -1;
      let headerFound = false;
      let tabRows = 0;

      await readTabRowsChunked(sheetId, tab.title, (rows, startRow) => {
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const globalRow = startRow + ri;

          if (!headerFound) {
            // Header can appear in first 30 rows (some sheets have multi-row titles).
            if (globalRow > 30) continue;
            const tIdx = findCol(row, /taxable\s*value/i);
            const hIdx = findCol(row, /state\s*head/i);
            if (tIdx >= 0 && hIdx >= 0) {
              taxColIdx = tIdx;
              headColIdx = hIdx;
              headerFound = true;
            }
            continue;
          }

          const head = strVal(row[headColIdx]);
          const amt = numVal(row[taxColIdx]);
          if (!head || amt <= 0) continue;

          if (NON_TERRITORY_RE.test(normHead(head))) {
            nonTerritoryTotal += amt;
            total += amt;
            tabRows++;
            continue;
          }

          const key = normHead(head);
          if (!key) continue;

          byNormKey.set(key, (byNormKey.get(key) ?? 0) + amt);
          total += amt;
          tabRows++;
        }
      });

      if (headerFound && tabRows > 0) {
        tabsWithData++;
      } else if (!headerFound) {
        // Not a warn — many sheets have summary/helper tabs without STATE HEAD col.
        logger.debug(
          { fy, tab: tab.title },
          "stateHeadSale: tab has no STATE HEAD + Taxable Value columns — skipped",
        );
      }
    }

    rowsRead = [...byNormKey.values()].reduce((s, v) => s + v, 0);
    if (tabsWithData === 0) {
      logger.warn(
        { fy, sheetId, tabCount: tabs.length },
        "stateHeadSale: loaded but no tabs contained STATE HEAD + Taxable Value — check sheet structure",
      );
    }

    // Resolve normHead keys to canonical roster display names.
    const byHead = new Map<string, number>();
    try {
      const roster = await loadRoster();
      const canonicalHeads = new Set(
        roster.members.map((m) => m.stateHead).filter((h) => h.trim() !== ""),
      );
      const resolve = buildHeadResolver(canonicalHeads);
      for (const [key, amt] of byNormKey) {
        const display = resolve(key) ?? key;
        byHead.set(display, (byHead.get(display) ?? 0) + amt);
      }
    } catch {
      // Roster unavailable — use raw normHead keys.
      for (const [key, amt] of byNormKey) {
        byHead.set(key, amt);
      }
    }
    if (nonTerritoryTotal > 0) {
      byHead.set("Non-territory", (byHead.get("Non-territory") ?? 0) + nonTerritoryTotal);
    }

    const result: StateHeadSaleResult = { byHead, total, label, error: null };
    _cache.set(fy, { ts: Date.now(), result });
    logger.info(
      { fy, total, rowsRead, heads: byHead.size, tabsWithData },
      "stateHeadSale: loaded",
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err, fy, sheetId }, "stateHeadSale: load failed");
    return { byHead: new Map(), total: 0, label, error };
  }
}
