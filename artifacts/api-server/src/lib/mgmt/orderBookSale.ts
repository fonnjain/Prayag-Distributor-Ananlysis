// Reads primary order booking data (Taxable Value) from the Order Book FY2627
// sheet, aggregated by State Head.
//
// The sheet has monthly tabs (Apr-26, May-26, …). Each tab has a header row
// containing STATE HEAD and Taxable Value columns. STATE HEAD values are
// normalised via normHead + buildHeadResolver so spelling drift never drops a
// head. Non-territory buckets (OTHER, PROJECT, GOVT, GEM, JJM) are tracked
// separately.
//
// byHead       — all months aggregated (backward-compatible).
// byHeadByMonth — per-tab map (tab title → display head → Σ amount).
//                 Use this in the route to produce period-filtered totals.
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
  /** Display head name → Σ Taxable Value (rupees), all months aggregated. */
  byHead: Map<string, number>;
  /** Tab title (e.g. "Apr-26") → display head → Σ Taxable Value. */
  byHeadByMonth: Map<string, Map<string, number>>;
  /** Company-wide total Taxable Value across all heads. */
  total: number;
  /** Total data rows read (excludes header rows). */
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

  // Per-tab accumulators: tab title → { normKey → amount, nonTerritory, unattributed }
  type TabAccum = {
    byNormKey: Map<string, number>;
    nonTerritory: number;
    /** Rows where the STATE HEAD cell is blank — real amounts, unattributable. */
    unattributed: number;
  };
  const tabAccums = new Map<string, TabAccum>();

  // Global aggregates (sum across all tabs — kept for byHead backward compat).
  const byNormKeyAll = new Map<string, number>();
  let nonTerritoryAll = 0;
  let unattributedAll = 0;
  let total = 0;
  let rowsRead = 0;

  try {
    const tabs = await listSheetTabs(ORDER_BOOK_FY2627);

    // Include monthly tabs (abbreviated or full name, optional year suffix) and
    // a "data" tab when present.
    // Explicitly excluded:
    //   WT / WT-LTR — the tank-size LOOKUP TABLE (digits→litre capacity), NOT order data.
    //     The user verified: "It is a reference table, exactly like the INDEX tab."
    //   Combined / Last Month Order — duplicate pivot summaries of monthly data.
    //   Per-state-head tabs (e.g. "ANUJ SHARMA") — duplicate monthly data in head view.
    // None of these should be summed.
    const MONTHLY_RE =
      /^(Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?|Jan(uary)?|Feb(ruary)?|Mar(ch)?)\b/i;
    const DATA_RE = /^data$/i;
    const relevantTabs = tabs.filter(
      (t) =>
        MONTHLY_RE.test(t.title.trim()) ||
        DATA_RE.test(t.title.trim()),
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

      const tabAccum: TabAccum = { byNormKey: new Map(), nonTerritory: 0, unattributed: 0 };

      await readTabRowsChunked(ORDER_BOOK_FY2627, tab.title, (rows, startRow) => {
        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const globalRow = startRow + ri;
          rowNum = globalRow;

          if (!headerFound) {
            if (globalRow > 30) continue;
            // Primary match: "Taxable Value" / "Taxable Amount" + "State Head".
            let tIdx = findCol(row, /taxable\s*(value|amount)/i);
            let hIdx = findCol(row, /state\s*head/i);
            // Broader fallback for tabs with different column names (e.g. WT tab):
            // try any "Booking Amount", "Net Amount", or bare "Amount" column.
            if (tIdx < 0) tIdx = findCol(row, /booking\s*am(ou)?nt|net\s*am(ou)?nt|^amount$|total\s*am(ou)?nt/i);
            // Fallback head: any column titled exactly "Head" or "State" when combined
            // with a numeric amount column.
            if (hIdx < 0 && tIdx >= 0) hIdx = findCol(row, /^head$|^state$/i);
            if (tIdx >= 0 && hIdx >= 0) {
              taxColIdx = tIdx;
              headColIdx = hIdx;
              headerFound = true;
            }
            continue;
          }

          const head = strVal(row[headColIdx]);
          const amt = numVal(row[taxColIdx]);
          if (amt <= 0) continue;

          if (!head) {
            // No STATE HEAD value — real booking amount but cannot be attributed to a head.
            // Count in the company total and in a per-tab "Unattributed" bucket.
            tabAccum.unattributed += amt;
            unattributedAll += amt;
            total += amt;
            rowsRead++;
            continue;
          }

          if (NON_TERRITORY_RE.test(normHead(head))) {
            tabAccum.nonTerritory += amt;
            nonTerritoryAll += amt;
            total += amt;
            rowsRead++;
            continue;
          }

          const key = normHead(head);
          if (!key) continue;

          tabAccum.byNormKey.set(key, (tabAccum.byNormKey.get(key) ?? 0) + amt);
          byNormKeyAll.set(key, (byNormKeyAll.get(key) ?? 0) + amt);
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

      tabAccums.set(tab.title, tabAccum);
    }

    // ── Resolve normHead keys → canonical display names ────────────────────────
    // Build the resolver once and apply it to both the aggregate and per-tab maps.
    let resolve: (key: string) => string | null = (k) => k;
    try {
      const roster = await loadRoster();
      const canonicalHeads = new Set(
        roster.members.map((m) => m.stateHead).filter((h) => h.trim() !== ""),
      );
      resolve = buildHeadResolver(canonicalHeads);
    } catch {
      // Roster unavailable — use normHead keys as-is.
    }

    // Aggregate (all months) → byHead
    const byHead = new Map<string, number>();
    for (const [key, amt] of byNormKeyAll) {
      const display = resolve(key) ?? key;
      byHead.set(display, (byHead.get(display) ?? 0) + amt);
    }
    if (nonTerritoryAll > 0) {
      byHead.set("Non-territory", (byHead.get("Non-territory") ?? 0) + nonTerritoryAll);
    }
    // Blank-STATE-HEAD rows — real amounts that cannot be attributed to any head.
    if (unattributedAll > 0) {
      byHead.set("Unattributed", (byHead.get("Unattributed") ?? 0) + unattributedAll);
    }

    // Per-tab → byHeadByMonth
    const byHeadByMonth = new Map<string, Map<string, number>>();
    for (const [tabTitle, { byNormKey: tabNK, nonTerritory: tabNT, unattributed: tabUA }] of tabAccums) {
      const tabHead = new Map<string, number>();
      for (const [key, amt] of tabNK) {
        const display = resolve(key) ?? key;
        tabHead.set(display, (tabHead.get(display) ?? 0) + amt);
      }
      if (tabNT > 0) {
        tabHead.set("Non-territory", (tabHead.get("Non-territory") ?? 0) + tabNT);
      }
      if (tabUA > 0) {
        tabHead.set("Unattributed", (tabHead.get("Unattributed") ?? 0) + tabUA);
      }
      byHeadByMonth.set(tabTitle, tabHead);
    }

    const result: OrderBookSale = { byHead, byHeadByMonth, total, rowsRead, error: null };
    _cache = { ts: Date.now(), result };
    logger.info(
      { total, rowsRead, heads: byHead.size, tabs: byHeadByMonth.size },
      "orderBookSale: loaded Order Book FY2627 sale data",
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "orderBookSale: failed to load");
    return { byHead: new Map(), byHeadByMonth: new Map(), total: 0, rowsRead: 0, error };
  }
}

export function invalidateOrderBookSaleCache(): void {
  _cache = null;
}
