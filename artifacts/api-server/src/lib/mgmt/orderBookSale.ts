// Reads primary-sale data (Taxable Value) from the Order Book FY2627 sheet,
// aggregated by State Head. Used as the Sale source for FY2026-27 when the
// secondary order booking file has not yet been created.
//
// The Order Book FY2627 sheet has monthly tabs (Apr-26, May-26, ...). Each tab
// has a header row containing STATE HEAD and Taxable Value columns. STATE HEAD
// values are normalised via normHead + buildHeadResolver so spelling drift
// (BIJJU -> Biju C.O, RIZVI JI -> Syed Aqil Rizvi, etc.) never drops a head.
// Non-territory buckets (OTHER, PROJECT, GOVT, GEM, JJM) are excluded from
// per-head attribution and tracked separately as non_territory.
import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normHead, buildHeadResolver } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

// Same sheet as ORDER_BOOK_FY2627 in dashboard/sync.ts.
const ORDER_BOOK_FY2627 = "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A";

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;

export type OrderBookSale = {
  /** Display head name -> Σ Taxable Value (rupees) */
  byHead: Map<string, number>;
  /** Company-wide total Taxable Value across all heads */
  total: number;
  /** Total data rows read (excludes header rows) */
  rowsRead: number;
  /** Non-null when the load failed entirely. */
  error: string | null;
};

// 30-minute in-process TTL cache — the sheet refreshes daily at most.
let _cache: { ts: number; result: OrderBookSale } | null = null;
const TTL_MS = 30 * 60 * 1000;

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

export async function loadOrderBookSaleByHead(): Promise<OrderBookSale> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.result;

  // Accumulate by normHead key first; resolve to display names after reading.
  const byNormKey = new Map<string, number>();
  let nonTerritoryTotal = 0;
  let total = 0;
  let rowsRead = 0;

  try {
    const tabs = await listSheetTabs(ORDER_BOOK_FY2627);

    // Include monthly tabs: abbreviated ("Apr", "Jul") or full ("April", "July"),
    // with or without a year suffix ("Apr-26", "Apr 2026", "April").
    // The sheet names some tabs with the full month name and no suffix.
    const MONTHLY_RE =
      /^(Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?|Jan(uary)?|Feb(ruary)?|Mar(ch)?)\b/i;
    const DATA_RE = /^data$/i;
    // Also include the "WT" tab — the booking sheet carries water-tank orders in a
    // dedicated WT tab that is NOT duplicated in the monthly tabs.
    const WT_TAB_RE = /^wt$/i;
    const relevantTabs = tabs.filter(
      (t) =>
        MONTHLY_RE.test(t.title.trim()) ||
        DATA_RE.test(t.title.trim()) ||
        WT_TAB_RE.test(t.title.trim()),
    );

    logger.info(
      { allTabs: tabs.map((t) => t.title), relevantTabs: relevantTabs.map((t) => t.title) },
      "orderBookSale: tabs selected",
    );

    if (relevantTabs.length === 0) {
      logger.warn(
        { allTabs: tabs.map((t) => t.title) },
        "orderBookSale: no monthly or data tabs found in sheet",
      );
    }

    for (const tab of relevantTabs) {
      let taxColIdx = -1;
      let headColIdx = -1;
      let headerFound = false;
      let rowNum = 0;

      await readTabRowsChunked(ORDER_BOOK_FY2627, tab.title, (rows, startRow) => {
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const globalRow = startRow + ri;
          rowNum = globalRow;

          if (!headerFound) {
            if (globalRow > 30) continue;
            const tIdx = findCol(row, /taxable\s*(value|amount)/i);
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
            rowsRead++;
            continue;
          }

          const key = normHead(head);
          if (!key) continue;

          byNormKey.set(key, (byNormKey.get(key) ?? 0) + amt);
          total += amt;
          rowsRead++;
        }
      });

      if (!headerFound) {
        logger.warn(
          { tab: tab.title, lastRow: rowNum },
          "orderBookSale: Taxable Value / STATE HEAD columns not found in tab",
        );
      }
    }

    // Resolve normHead keys to canonical display names using the live roster.
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
      // Roster unavailable — use normHead keys as-is.
      for (const [key, amt] of byNormKey) {
        byHead.set(key, amt);
      }
    }
    if (nonTerritoryTotal > 0) {
      byHead.set("Non-territory", (byHead.get("Non-territory") ?? 0) + nonTerritoryTotal);
    }

    const result: OrderBookSale = { byHead, total, rowsRead, error: null };
    _cache = { ts: Date.now(), result };
    logger.info(
      { total, rowsRead, heads: byHead.size },
      "orderBookSale: loaded Order Book FY2627 sale data",
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "orderBookSale: failed to load");
    return { byHead: new Map(), total: 0, rowsRead: 0, error };
  }
}

export function invalidateOrderBookSaleCache(): void {
  _cache = null;
}
