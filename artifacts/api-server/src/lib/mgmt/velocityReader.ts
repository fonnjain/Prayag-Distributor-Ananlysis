// Reads the ORDER BOOK FY2627 sheet for the CURRENT open month and aggregates
// Taxable Value by (STATE HEAD, day-of-month).  Used by the Velocity tab to
// compute intra-month booking pace per head.
//
// Only reads the ONE tab that matches today's calendar month — does NOT scan
// all tabs.  Returns a short-TTL (10 min) cached result.
//
// If the tab has no DATE column, hasDateData = false and each head's total is
// stored as a single sum (day 0) — the caller should suppress the sparkline.
import {
  listSheetTabs,
  readTabRowsChunked,
  isSheetsQuotaError,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { resolveHeadKey, parseOrderDate, serialToDate } from "./names.js";
import { logger } from "../logger.js";

const ORDER_BOOK_FY2627 = "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A";

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;

// Month abbreviations (0-indexed, Jan=0 ... Dec=11) for matching tab titles.
const MONTH_ABBRS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

// Tab titles we expect for each calendar month (0=Jan..11=Dec).
// Tabs in the ORDER BOOK are named like "Apr", "May", "June", "July".
function tabMatchesCalMonth(title: string, calMonth: number): boolean {
  const t = title.trim().toLowerCase();
  const abbr = MONTH_ABBRS[calMonth].toLowerCase();
  return t === abbr || t.startsWith(abbr);
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

export type VelocityDailyResult = {
  // headKey -> Map<dayOfMonth (1-based), total rupees booked on that day>
  dailyByHead: Map<string, Map<number, number>>;
  // headKey -> total rupees (all days in the tab)
  totalByHead: Map<string, number>;
  hasDateData: boolean;
  calMonth: number;   // 0-based calendar month read
  calYear: number;
  tabTitle: string;
  error: string | null;
};

type CacheEntry = { ts: number; result: VelocityDailyResult };
let _cache: CacheEntry | null = null;
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function invalidateVelocityCache(): void {
  _cache = null;
}

export async function loadVelocityDailyBooking(
  calMonth: number,  // 0-based: July = 6
  calYear: number,
): Promise<VelocityDailyResult> {
  const now = Date.now();
  if (
    _cache &&
    now - _cache.ts < TTL_MS &&
    _cache.result.calMonth === calMonth &&
    _cache.result.calYear === calYear
  ) {
    return _cache.result;
  }

  const dailyByHead = new Map<string, Map<number, number>>();
  const totalByHead = new Map<string, number>();

  try {
    const tabs = await listSheetTabs(ORDER_BOOK_FY2627);
    const tab = tabs.find((t) => tabMatchesCalMonth(t.title, calMonth));

    if (!tab) {
      const result: VelocityDailyResult = {
        dailyByHead, totalByHead, hasDateData: false,
        calMonth, calYear, tabTitle: "",
        error: `No tab found for month ${MONTH_ABBRS[calMonth]} in ORDER BOOK FY2627`,
      };
      return result;
    }

    let taxIdx = -1, headIdx = -1, dateIdx = -1;
    let headerFound = false;
    let hasDateData = false;

    await readTabRowsChunked(ORDER_BOOK_FY2627, tab.title, (rows, startRow) => {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const globalRow = startRow + ri;

        if (!headerFound) {
          if (globalRow > 30) continue;
          const tI = findCol(row, /taxable\s*(value|amount)/i);
          const hI = findCol(row, /state\s*head/i);
          if (tI >= 0 && hI >= 0) {
            taxIdx  = tI;
            headIdx = hI;
            // DATE column: look for "date" not containing "update" or "state"
            for (let ci = 0; ci < row.length; ci++) {
              const h = strVal(row[ci]).toLowerCase().trim();
              if (/\bdate\b/.test(h) && !h.includes("update") && !h.includes("state")) {
                dateIdx = ci;
                break;
              }
            }
            if (dateIdx >= 0) hasDateData = true;
            headerFound = true;
          }
          continue;
        }

        const head = strVal(row[headIdx]);
        const amt  = numVal(row[taxIdx]);
        if (!head || amt <= 0) continue;
        const hKey = resolveHeadKey(head);
        if (!hKey || NON_TERRITORY_RE.test(hKey)) continue;

        // Total accumulation (regardless of date)
        totalByHead.set(hKey, (totalByHead.get(hKey) ?? 0) + amt);

        // Daily accumulation
        let dayOfMonth = 0; // 0 = no date
        if (dateIdx >= 0) {
          const serial = parseOrderDate(row[dateIdx]);
          if (serial != null) {
            const d = serialToDate(serial);
            // Only count rows that fall in the expected calendar month+year
            if (d.getUTCFullYear() === calYear && d.getUTCMonth() === calMonth) {
              dayOfMonth = d.getUTCDate();
            }
          }
        }

        if (!dailyByHead.has(hKey)) dailyByHead.set(hKey, new Map());
        const dayMap = dailyByHead.get(hKey)!;
        dayMap.set(dayOfMonth, (dayMap.get(dayOfMonth) ?? 0) + amt);
      }
    });

    if (!headerFound) {
      logger.warn({ tab: tab.title }, "velocityReader: no header found in tab");
    }

    logger.info(
      {
        tab: tab.title,
        heads: totalByHead.size,
        hasDateData,
        total: [...totalByHead.values()].reduce((a, b) => a + b, 0),
      },
      "velocityReader: loaded",
    );

    const result: VelocityDailyResult = {
      dailyByHead, totalByHead, hasDateData,
      calMonth, calYear, tabTitle: tab.title, error: null,
    };
    _cache = { ts: now, result };
    return result;
  } catch (err) {
    // Let the Sheets quota window propagate so routes can respond 503 + quota
    // flag (respondIfQuotaError) instead of a generic degraded payload.
    if (isSheetsQuotaError(err)) throw err;
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "velocityReader: failed to load");
    return { dailyByHead, totalByHead, hasDateData: false, calMonth, calYear, tabTitle: "", error };
  }
}
