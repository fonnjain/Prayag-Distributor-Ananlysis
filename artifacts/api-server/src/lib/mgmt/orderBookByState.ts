// Reads the Order Book FY2627 sheet and aggregates Taxable Value by
// (STATE HEAD, STATE, month-label).  Used for state-level primary achievement.
//
// The sheet has monthly tabs (Apr-26, May-26, …).  Each tab contains at least:
//   STATE HEAD column — used to group by head (same as orderBookSale.ts)
//   STATE column      — used to group by state (NEW — not read by the head-only loader)
//   Taxable Value     — booking amount
//
// If the STATE column is absent from a tab, amounts fall back to head-only
// (state="UNKNOWN") so nothing is silently lost.
import {
  listSheetTabs,
  readTabRowsChunked,
  isSheetsQuotaError,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { resolveHeadKey } from "./names.js";
import { logger } from "../logger.js";

const ORDER_BOOK_FY2627 = "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A";

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;
const MONTHLY_RE =
  /^(Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?|Jan(uary)?|Feb(ruary)?|Mar(ch)?)\b/i;

// Map tab title to fiscal-year month label, e.g. "Apr-26" → "Apr-26", "April" → "Apr-??".
// For the FY2026-27 sheet the tabs are named with year suffix ("Apr-26"), so we
// pass through as-is; plain-month tabs get the year appended from FY.
function tabToMonthLabel(tabTitle: string, fy: string): string {
  // Already has a year suffix like "Apr-26"
  if (/\b\d{2}$/.test(tabTitle.trim())) return tabTitle.trim();
  // Plain name like "April" or "Jul"
  const abbr = tabTitle.trim().slice(0, 3);
  const fyEnd = fy.slice(-2); // "27" from "2026-27"
  const fyStart = fy.slice(2, 4); // "26" from "2026-27"
  const LATE_MONTHS = new Set(["Jan", "Feb", "Mar"]);
  const yr = LATE_MONTHS.has(abbr) ? fyEnd : fyStart;
  return `${abbr}-${yr}`;
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

export type StateBookingKey = {
  stateHeadNorm: string;
  state: string;       // raw state from sheet
  monthLabel: string;  // "Apr-26", "May-26", etc.
};

export type StateBookingResult = {
  // Lookup: normHead|state|monthLabel → rupees
  amounts: Map<string, number>;
  error: string | null;
};

let _cache: { ts: number; result: StateBookingResult } | null = null;
const TTL_MS = 30 * 60 * 1000;

export function invalidateOrderBookByStateCache(): void {
  _cache = null;
}

export async function loadOrderBookByState(): Promise<StateBookingResult> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.result;

  const amounts = new Map<string, number>();

  try {
    const tabs = await listSheetTabs(ORDER_BOOK_FY2627);
    const monthlyTabs = tabs.filter((t) => MONTHLY_RE.test(t.title.trim()));

    logger.info(
      { monthlyTabs: monthlyTabs.map((t) => t.title) },
      "orderBookByState: reading monthly tabs",
    );

    for (const tab of monthlyTabs) {
      const monthLabel = tabToMonthLabel(tab.title, "2026-27");
      let taxIdx = -1, headIdx = -1, stateIdx = -1;
      let headerFound = false;

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
              // STATE column: match exact "state" (geographic state, column P in the
              // SALE SHEET / ORDER BOOK structure).
              // Do NOT match "station" — that is the delivery city column (column O)
              // which contains city names, not geographic state names.
              for (let ci = 0; ci < row.length; ci++) {
                const h = strVal(row[ci]).toLowerCase().trim();
                if (h === "state" && ci !== hI) {
                  stateIdx = ci;
                  break;
                }
              }
              if (stateIdx < 0) {
                // Broader fallback: any column containing "state" but not "head"
                // and not "station" (station = delivery city, not geographic state).
                for (let ci = 0; ci < row.length; ci++) {
                  const h = strVal(row[ci]).toLowerCase().trim();
                  if (
                    h.includes("state") &&
                    !h.includes("head") &&
                    !h.includes("station") &&
                    ci !== hI
                  ) {
                    stateIdx = ci;
                    break;
                  }
                }
              }
              headerFound = true;
            }
            continue;
          }

          const head = strVal(row[headIdx]);
          const amt  = numVal(row[taxIdx]);
          if (!head || amt <= 0) continue;
          const hKey = resolveHeadKey(head);
          if (!hKey || NON_TERRITORY_RE.test(hKey)) continue;

          const state = stateIdx >= 0 ? strVal(row[stateIdx]) : "UNKNOWN";
          const key = `${hKey}|${state}|${monthLabel}`;
          amounts.set(key, (amounts.get(key) ?? 0) + amt);
        }
      });

      if (!headerFound) {
        logger.warn({ tab: tab.title }, "orderBookByState: no header found in tab");
      }
    }

    const result: StateBookingResult = { amounts, error: null };
    _cache = { ts: Date.now(), result };
    logger.info(
      { keys: amounts.size },
      "orderBookByState: loaded",
    );
    return result;
  } catch (err) {
    // Let the Sheets quota window propagate so routes can respond 503 + quota
    // flag (respondIfQuotaError) instead of a generic degraded payload.
    if (isSheetsQuotaError(err)) throw err;
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "orderBookByState: failed to load");
    return { amounts: new Map(), error };
  }
}
