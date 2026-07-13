// Reads primary order-booking and dispatch-sale sheets and returns company,
// head-level, and distributor-level aggregations — no distributor-TM bridge needed.
//
// FY2026-27:
//   Booking : Order Sheet 26-27  (1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A)
//   Sale    : State Head Sale 26-27 (1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs)
// FY2025-26:
//   Booking : none (no per-FY primary booking sheet for historical FYs)
//   Sale    : State Head Sale 25-26 (1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA)
//
// The byHead breakdown is always available from the STATE HEAD column.
// The byDistributor breakdown is always available from the Customer column.
// Both degrade to empty (with a reason) when sheets are unreachable.
import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normHead, buildHeadResolver } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

const BOOKING_SHEETS: Record<string, string> = {
  "2026-27": "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A",
};

const SALE_SHEETS: Record<string, string> = {
  // FY2026-27: "SALE SHEET 26-27" — monthly tabs Apr/May/Jun/July.
  // Columns: A=serial B=invoice C=date D=bill-from E=customer F=city G=dest
  //          H=code I=colour J=qty K=MRP L=rate M=TAXABLE VALUE N=group
  //          O=station P=state Q=STATE HEAD R=month
  "2026-27": "19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps",
  "2025-26": "1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA",
};

// Positional fallback column indices for the FY2026-27 sale sheet when
// header detection fails (0-based: M=12, Q=16).
const SALE_POSITIONAL: Record<string, { taxIdx: number; headIdx: number }> = {
  "19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps": { taxIdx: 12, headIdx: 16 },
};

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;
const SKIP_TAB_RE =
  /^(instruction|change.?log|legend|notes?|readme|cover|summary|index|template)/i;
// Match abbreviated OR full month names, with or without year suffix.
// Handles: "Apr", "April", "May", "Jun", "June", "Jul", "July", "Aug", "August",
//          "Sep", "September", "Oct", "October", "Nov", "November",
//          "Dec", "December", "Jan", "January", "Feb", "February", "Mar", "March"
const MONTHLY_RE =
  /^(Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?|Jan(uary)?|Feb(ruary)?|Mar(ch)?)\b/i;

// ── Public types ─────────────────────────────────────────────────────────────

export type PrimaryHeadRow = {
  head: string;
  booking: number;
  sale: number;
  pending: number;
};

export type PrimaryDistributorRow = {
  name: string;
  stateHead: string;
  booking: number;
};

export type PrimarySheetData = {
  fy: string;
  companyBooking: number;
  companySale: number;
  companyPending: number;
  byHead: PrimaryHeadRow[];
  byDistributor: PrimaryDistributorRow[];
  sources: { booking: string | null; sale: string | null };
  bookingAvailable: boolean;
  saleAvailable: boolean;
};

// ── Cache ─────────────────────────────────────────────────────────────────────

const _cache = new Map<string, { ts: number; data: PrimarySheetData }>();
const TTL_MS = 30 * 60 * 1000;

export function invalidatePrimarySheetCache(fy?: string): void {
  if (fy) _cache.delete(fy);
  else _cache.clear();
}

// ── Internal helpers ─────────────────────────────────────────────────────────

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

type SheetAgg = {
  byNormHead: Map<string, number>;
  byDistributor: Map<string, { displayName: string; stateHeadNorm: string; amount: number }>;
  nonTerritoryTotal: number;
  total: number;
};

async function readAndAggregate(
  sheetId: string,
  forBooking: boolean,
): Promise<SheetAgg> {
  const tabs = await listSheetTabs(sheetId);

  // Both booking and sale sheets use monthly tabs (Apr/April, May, Jun/June, Jul/July, …).
  // Fallback to all non-skip tabs when no monthly tabs are found (e.g. legacy sheets
  // where all data sits on a single tab).
  // Also read "WT" (booking) and "WT-LTR" (sale) tabs — water-tank orders and
  // dispatches are tracked in dedicated tabs separate from the monthly tabs.
  let dataTabs = tabs.filter(
    (t) =>
      MONTHLY_RE.test(t.title.trim()) ||
      /^data$/i.test(t.title.trim()) ||
      /^wt(-ltr)?$/i.test(t.title.trim()),
  );
  if (dataTabs.length === 0)
    dataTabs = tabs.filter((t) => !SKIP_TAB_RE.test(t.title.trim()));

  logger.info(
    { sheetId, forBooking, allTabs: tabs.map((t) => t.title), dataTabs: dataTabs.map((t) => t.title) },
    "primarySheets: tabs selected",
  );

  // Positional fallback column indices (used when header-scan finds nothing).
  const positional = SALE_POSITIONAL[sheetId];

  const byNormHead = new Map<string, number>();
  const byDistributor = new Map<
    string,
    { displayName: string; stateHeadNorm: string; amount: number }
  >();
  let nonTerritoryTotal = 0;
  let total = 0;

  for (const tab of dataTabs) {
    let taxIdx = -1,
      headIdx = -1,
      custIdx = -1;
    let headerFound = false;
    let tabRows = 0;

    await readTabRowsChunked(sheetId, tab.title, (rows, startRow) => {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const globalRow = startRow + ri;

        if (!headerFound) {
          if (globalRow > 30) {
            // Header not found in first 30 rows — try positional fallback once.
            if (positional) {
              taxIdx = positional.taxIdx;
              headIdx = positional.headIdx;
              headerFound = true;
              logger.warn(
                { sheetId, tab: tab.title },
                "primarySheets: header not detected, using positional fallback",
              );
            }
            if (!headerFound) continue;
          } else {
            // Accept "Taxable Value" or "Taxable Amount" (case-insensitive).
            const tI = findCol(row, /taxable\s*(value|amount)/i);
            const hI = findCol(row, /state\s*head/i);
            if (tI >= 0 && hI >= 0) {
              taxIdx = tI;
              headIdx = hI;
              if (forBooking) {
                custIdx = findCol(
                  row,
                  /^(customer|party\s*name|firm\s*name|dealer\s*name|distributor\s*name)$/i,
                );
                if (custIdx < 0) custIdx = findCol(row, /customer|party/i);
              }
              headerFound = true;
            }
            continue;
          }
        }

        const head = strVal(row[headIdx]);
        const amt = numVal(row[taxIdx]);
        if (!head || amt <= 0) continue;

        const hNorm = normHead(head);
        if (NON_TERRITORY_RE.test(hNorm)) {
          nonTerritoryTotal += amt;
          total += amt;
          tabRows++;
          continue;
        }
        if (!hNorm) continue;

        byNormHead.set(hNorm, (byNormHead.get(hNorm) ?? 0) + amt);
        total += amt;
        tabRows++;

        // Distributor-level granularity for the booking sheet.
        if (forBooking && custIdx >= 0) {
          const cust = strVal(row[custIdx]);
          if (cust) {
            const key = cust.toLowerCase().replace(/\s+/g, " ").trim();
            const ex = byDistributor.get(key);
            if (ex) {
              ex.amount += amt;
            } else {
              byDistributor.set(key, {
                displayName: cust,
                stateHeadNorm: hNorm,
                amount: amt,
              });
            }
          }
        }
      }
    });

    logger.info(
      { sheetId, tab: tab.title, tabRows, tabTotal: Math.round(total) },
      "primarySheets: tab processed",
    );
  }

  if (total === 0) {
    logger.warn(
      { sheetId, forBooking, dataTabs: dataTabs.map((t) => t.title) },
      "primarySheets: all tabs yielded 0 rows — check sheet structure and column headers",
    );
  }

  return { byNormHead, byDistributor, nonTerritoryTotal, total };
}

// ── Public loader ─────────────────────────────────────────────────────────────

export async function loadPrimarySheetData(fy: string): Promise<PrimarySheetData> {
  const cached = _cache.get(fy);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  // Build head resolver from roster (best-effort).
  let resolve: (raw: unknown) => string | null;
  try {
    const roster = await loadRoster();
    const canonicalHeads = new Set(
      roster.members.map((m) => m.stateHead).filter((h) => h && h.trim() !== ""),
    );
    resolve = buildHeadResolver(canonicalHeads);
  } catch {
    resolve = (raw) => (normHead(raw) ? normHead(raw) : null);
  }

  const bookingSheetId = BOOKING_SHEETS[fy];
  const saleSheetId = SALE_SHEETS[fy];

  let bookingAgg: SheetAgg = {
    byNormHead: new Map(),
    byDistributor: new Map(),
    nonTerritoryTotal: 0,
    total: 0,
  };
  let saleAgg: SheetAgg = {
    byNormHead: new Map(),
    byDistributor: new Map(),
    nonTerritoryTotal: 0,
    total: 0,
  };
  let bookingAvailable = false;
  let saleAvailable = false;

  if (bookingSheetId) {
    try {
      bookingAgg = await readAndAggregate(bookingSheetId, true);
      bookingAvailable = bookingAgg.total > 0;
      logger.info(
        { fy, total: bookingAgg.total, heads: bookingAgg.byNormHead.size },
        "primarySheets: booking loaded",
      );
    } catch (err) {
      logger.warn({ err, fy }, "primarySheets: booking load failed");
    }
  }

  if (saleSheetId) {
    try {
      saleAgg = await readAndAggregate(saleSheetId, false);
      saleAvailable = saleAgg.total > 0;
      logger.info(
        { fy, total: saleAgg.total, heads: saleAgg.byNormHead.size },
        "primarySheets: sale loaded",
      );
    } catch (err) {
      logger.warn({ err, fy }, "primarySheets: sale load failed");
    }
  }

  // Merge head entries from both aggregations into display-name keyed map.
  const allKeys = new Set([
    ...bookingAgg.byNormHead.keys(),
    ...saleAgg.byNormHead.keys(),
  ]);
  const headDisplayMap = new Map<string, { booking: number; sale: number }>();

  for (const key of allKeys) {
    const display = resolve(key) ?? key;
    const ex = headDisplayMap.get(display) ?? { booking: 0, sale: 0 };
    ex.booking += bookingAgg.byNormHead.get(key) ?? 0;
    ex.sale += saleAgg.byNormHead.get(key) ?? 0;
    headDisplayMap.set(display, ex);
  }

  // Non-territory bucket.
  const ntBooking = bookingAgg.nonTerritoryTotal;
  const ntSale = saleAgg.nonTerritoryTotal;
  if (ntBooking > 0 || ntSale > 0) {
    const ex = headDisplayMap.get("Non-territory") ?? { booking: 0, sale: 0 };
    ex.booking += ntBooking;
    ex.sale += ntSale;
    headDisplayMap.set("Non-territory", ex);
  }

  const byHead: PrimaryHeadRow[] = Array.from(headDisplayMap.entries())
    .map(([head, { booking, sale }]) => ({
      head,
      booking,
      sale,
      pending: Math.max(0, booking - sale),
    }))
    .sort((a, b) => b.booking - a.booking);

  // Distributor rows — resolve state head to display name.
  const byDistributor: PrimaryDistributorRow[] = Array.from(
    bookingAgg.byDistributor.values(),
  )
    .map(({ displayName, stateHeadNorm, amount }) => ({
      name: displayName,
      stateHead: resolve(stateHeadNorm) ?? stateHeadNorm,
      booking: amount,
    }))
    .sort((a, b) => b.booking - a.booking)
    .slice(0, 300); // cap payload size

  const data: PrimarySheetData = {
    fy,
    companyBooking: bookingAgg.total,
    companySale: saleAgg.total,
    companyPending: Math.max(0, bookingAgg.total - saleAgg.total),
    byHead,
    byDistributor,
    sources: {
      booking: bookingAvailable ? `Order Sheet ${fy}` : null,
      sale: saleAvailable ? `State Head Sale ${fy}` : null,
    },
    bookingAvailable,
    saleAvailable,
  };

  _cache.set(fy, { ts: Date.now(), data });
  return data;
}
