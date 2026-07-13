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
  "2026-27": "1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs",
  "2025-26": "1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA",
};

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;
const SKIP_TAB_RE =
  /^(instruction|change.?log|legend|notes?|readme|cover|summary|index|template)/i;
const MONTHLY_RE =
  /^(Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar)[-\s\d]/i;

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

  // Order booking sheet uses monthly tabs; sale sheets use all non-skip tabs.
  let dataTabs = forBooking
    ? tabs.filter(
        (t) =>
          MONTHLY_RE.test(t.title.trim()) || /^data$/i.test(t.title.trim()),
      )
    : tabs.filter((t) => !SKIP_TAB_RE.test(t.title.trim()));
  // Fallback: if no monthly tabs, use all non-skip tabs.
  if (dataTabs.length === 0)
    dataTabs = tabs.filter((t) => !SKIP_TAB_RE.test(t.title.trim()));

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

    await readTabRowsChunked(sheetId, tab.title, (rows, startRow) => {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const globalRow = startRow + ri;

        if (!headerFound) {
          if (globalRow > 30) continue;
          const tI = findCol(row, /taxable\s*value/i);
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

        const head = strVal(row[headIdx]);
        const amt = numVal(row[taxIdx]);
        if (!head || amt <= 0) continue;

        const hNorm = normHead(head);
        if (NON_TERRITORY_RE.test(hNorm)) {
          nonTerritoryTotal += amt;
          total += amt;
          continue;
        }
        if (!hNorm) continue;

        byNormHead.set(hNorm, (byNormHead.get(hNorm) ?? 0) + amt);
        total += amt;

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
