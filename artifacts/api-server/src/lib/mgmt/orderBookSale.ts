// Reads primary order booking data (Taxable Value) from the Order Book sheets,
// aggregated by State Head.
//
// Supports FY2024-25, FY2025-26, and FY2026-27.  Each FY has its own Google
// Sheet; the mapping is in ORDER_BOOK_SHEETS below.
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
import { normHead, buildHeadResolver, UNRESOLVED_HEAD } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

/**
 * FY → Order Book sheet ID for FYs that have per-tab monthly booking data
 * with a STATE HEAD column.  FY2023-24 is intentionally absent — that sheet
 * has no STATE HEAD data in monthly-tab rows (only a SEGMENT/channel column).
 */
export const ORDER_BOOK_SHEETS: Record<string, string> = {
  "2026-27": "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A",
  "2025-26": "1Xzq-gmB6K7iuMcE6gb-O7OpvGgSDU33DzEVyK60LK6E",
  "2024-25": "1cT6lWRPJ3oSeYhab-cqeVjJidGitFQsr0DOq-vNn6cI",
};

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

// 30-minute in-process TTL cache — keyed by FY.
const _caches = new Map<string, { ts: number; result: OrderBookSale }>();
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

/**
 * Load order booking data for the given fiscal year, aggregated by State Head.
 *
 * `fy` defaults to "2026-27" so existing callers that omit it continue to work.
 * Returns an error result when no sheet is registered for the requested FY.
 */
// Single-flight: concurrent callers share one in-flight load per FY (a
// cold-start stampede of parallel multi-tab reads exhausts the Sheets
// per-minute read quota → 429s in production).
const _inFlight = new Map<string, Promise<OrderBookSale>>();

export async function loadOrderBookSaleByHead(fy: string = "2026-27"): Promise<OrderBookSale> {
  const cached = _caches.get(fy);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.result;

  const existing = _inFlight.get(fy);
  if (existing) return existing;

  const p = _loadOrderBookSaleUncached(fy).finally(() => _inFlight.delete(fy));
  _inFlight.set(fy, p);
  return p;
}

async function _loadOrderBookSaleUncached(fy: string): Promise<OrderBookSale> {
  const sheetId = ORDER_BOOK_SHEETS[fy];
  if (!sheetId) {
    return {
      byHead: new Map(),
      byHeadByMonth: new Map(),
      total: 0,
      rowsRead: 0,
      error: `No order book sheet registered for FY ${fy}`,
    };
  }

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
    const tabs = await listSheetTabs(sheetId);

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

      await readTabRowsChunked(sheetId, tab.title, (rows, startRow) => {
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
    // Initial resolver returns null so that the UNRESOLVED_HEAD guard fires when
    // the roster is unavailable — same behaviour as when a head fails to match.
    let resolve: (key: string) => string | null = (_k) => null;
    try {
      const roster = await loadRoster();
      const canonicalHeads = new Set(
        roster.members.map((m) => m.stateHead).filter((h) => h.trim() !== ""),
      );
      resolve = buildHeadResolver(canonicalHeads);
    } catch {
      logger.warn({ fy }, "orderBookSale: roster unavailable — unresolved heads will be bucketed as [Unresolved]");
    }

    // Aggregate (all months) → byHead
    // Any name that cannot be matched to a canonical head goes to UNRESOLVED_HEAD
    // rather than leaking as a raw normHead string.  This ensures the merged byHead
    // in mgmt/primary never produces two rows for the same physical person.
    const byHead = new Map<string, number>();
    for (const [key, amt] of byNormKeyAll) {
      const display = resolve(key);
      if (!display) {
        logger.warn({ fy, key, amt }, "orderBookSale: unresolved head name → routing to [Unresolved]");
      }
      const bucket = display ?? UNRESOLVED_HEAD;
      byHead.set(bucket, (byHead.get(bucket) ?? 0) + amt);
    }
    if (nonTerritoryAll > 0) {
      byHead.set("Non-territory", (byHead.get("Non-territory") ?? 0) + nonTerritoryAll);
    }
    // Blank-STATE-HEAD rows — real amounts that cannot be attributed to any head.
    if (unattributedAll > 0) {
      byHead.set("Unattributed", (byHead.get("Unattributed") ?? 0) + unattributedAll);
    }

    // Per-tab → byHeadByMonth (same resolver, no duplicate warn — aggregate covers it)
    const byHeadByMonth = new Map<string, Map<string, number>>();
    for (const [tabTitle, { byNormKey: tabNK, nonTerritory: tabNT, unattributed: tabUA }] of tabAccums) {
      const tabHead = new Map<string, number>();
      for (const [key, amt] of tabNK) {
        const bucket = resolve(key) ?? UNRESOLVED_HEAD;
        tabHead.set(bucket, (tabHead.get(bucket) ?? 0) + amt);
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
    _caches.set(fy, { ts: Date.now(), result });
    logger.info(
      { fy, total, rowsRead, heads: byHead.size, tabs: byHeadByMonth.size },
      "orderBookSale: loaded Order Book sale data",
    );
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err, fy }, "orderBookSale: failed to load");
    return { byHead: new Map(), byHeadByMonth: new Map(), total: 0, rowsRead: 0, error };
  }
}

export function invalidateOrderBookSaleCache(fy?: string): void {
  if (fy) _caches.delete(fy);
  else _caches.clear();
}
