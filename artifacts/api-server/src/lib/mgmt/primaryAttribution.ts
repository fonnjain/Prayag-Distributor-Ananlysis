// Attributes primary order booking and dispatched sale to individual team members
// by joining the Customer column in the primary sheets to the distributor-TM map.
//
// Primary sheets per FY
//   Order booking : Order Sheet 26-27  (booked orders, by order date)
//   Dispatch sale : State Head Sale sheet per FY (actual invoices from SAP / register)
//
// Rows whose Customer cannot be found in the TM map are counted as "Unassigned"
// under their STATE HEAD so company-wide totals are always preserved.
//
// Results are cached per-FY for TTL_MS. Cache is busted on distributor-map rebuild
// (call invalidatePrimaryAttributionCache()).
import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normParty, normHead } from "./names.js";
import { logger } from "../logger.js";
import type { DistributorTmMap } from "./distributorTmMap.js";

// ─── Sheet configuration by FY ───────────────────────────────────────────────

/** Sheets that hold primary ORDER BOOKING rows (Customer + Taxable Value) */
const ORDER_BOOKING_SHEET_IDS: Record<string, string> = {
  "2026-27": "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A", // Order Sheet 26-27
};

/** Sheets that hold primary DISPATCH SALE rows (same columns, invoice-date basis) */
const DISPATCH_SALE_SHEET_IDS: Record<string, string> = {
  "2026-27": "1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs", // State Head Sale 2026-27
  "2025-26": "1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA", // State Head Sale 2025-26
};

const TTL_MS = 30 * 60 * 1000;
const _cache = new Map<string, { ts: number; result: PrimaryAttributionResult }>();

export function invalidatePrimaryAttributionCache(fy?: string): void {
  if (fy) _cache.delete(fy);
  else _cache.clear();
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type MemberPrimaryStats = {
  orderAmount: number;
  saleAmount: number;
};

export type UnassignedPrimary = {
  /** Σ Taxable Value from order-booking rows where Customer was not in the TM map */
  orderAmount: number;
  /** Σ Taxable Value from dispatch-sale rows where Customer was not in the TM map */
  saleAmount: number;
  /** Distinct unmapped Customer keys encountered */
  customerCount: number;
};

export type PrimaryAttributionDiagnostics = {
  /** Was the distributor-TM map available? */
  distMapAvailable: boolean;
  /** Were order-booking sheets read? */
  orderBookingAvailable: boolean;
  /** Were dispatch-sale sheets read? */
  dispatchSaleAvailable: boolean;
  totalOrderRows: number;
  attributedOrderRows: number;
  totalOrderAmount: number;
  attributedOrderAmount: number;
  totalSaleRows: number;
  attributedSaleRows: number;
  totalSaleAmount: number;
  attributedSaleAmount: number;
  /** Fraction of order-booking Taxable Value attributed to a named member */
  attributionPct: number | null;
};

export type PrimaryAttributionResult = {
  perMember: Map<string, MemberPrimaryStats>;
  /** state-head normKey → unassigned bucket */
  unassignedByHead: Map<string, UnassignedPrimary>;
  diagnostics: PrimaryAttributionDiagnostics;
  error: string | null;
};

// ─── Row reader ──────────────────────────────────────────────────────────────

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

type ReadStats = {
  totalRows: number;
  attributedRows: number;
  totalAmount: number;
  attributedAmount: number;
};

const SKIP_TAB = /^(instruction|change.?log|legend|notes?|readme|cover|summary|index|template)/i;

async function readSheetByCustomer(
  sheetId: string,
  distMap: DistributorTmMap,
  perMember: Map<string, MemberPrimaryStats>,
  unassigned: Map<string, UnassignedPrimary>,
  kind: "order" | "sale",
): Promise<ReadStats> {
  const tabs = await listSheetTabs(sheetId);
  const dataTabs = tabs.filter((t) => !SKIP_TAB.test(t.title.trim()));

  let totalRows = 0;
  let attributedRows = 0;
  let totalAmount = 0;
  let attributedAmount = 0;

  for (const tab of dataTabs) {
    let customerColIdx = -1;
    let taxColIdx = -1;
    let headColIdx = -1;
    let headerFound = false;

    await readTabRowsChunked(sheetId, tab.title, (rows, startRow) => {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const globalRow = startRow + ri;

        // Header detection within first 30 rows — require at least Tax + StateHead.
        // Customer column is optional: if absent the rows go to the unassigned bucket.
        if (!headerFound) {
          if (globalRow > 30) continue;
          const tIdx = findCol(row, /taxable\s*value/i);
          const hIdx = findCol(row, /state\s*head/i);
          if (tIdx >= 0 && hIdx >= 0) {
            taxColIdx = tIdx;
            headColIdx = hIdx;
            // Customer column: try several common header names
            customerColIdx = findCol(
              row,
              /^(customer|party\s*name|firm\s*name|dealer\s*name|distributor\s*name)$/i,
            );
            if (customerColIdx < 0) {
              // Broader match: any column containing "customer" or "party"
              customerColIdx = findCol(row, /customer|party/i);
            }
            headerFound = true;
          }
          continue;
        }

        const head = strVal(row[headColIdx]);
        const amt = numVal(row[taxColIdx]);
        if (amt <= 0) continue;

        totalRows++;
        totalAmount += amt;

        if (customerColIdx >= 0) {
          const customer = strVal(row[customerColIdx]);
          if (customer) {
            const partyKey = normParty(customer);
            const entry = distMap.byPartyKey.get(partyKey);
            if (entry) {
              const s = perMember.get(entry.memberNormKey) ?? { orderAmount: 0, saleAmount: 0 };
              if (kind === "order") s.orderAmount += amt;
              else s.saleAmount += amt;
              perMember.set(entry.memberNormKey, s);
              attributedRows++;
              attributedAmount += amt;
              continue;
            }
          }
        }

        // Unassigned — preserve under state head so head-level totals balance
        const headKey = normHead(head) || "unknown";
        const ua = unassigned.get(headKey) ?? {
          orderAmount: 0,
          saleAmount: 0,
          customerCount: 0,
        };
        if (kind === "order") ua.orderAmount += amt;
        else ua.saleAmount += amt;
        ua.customerCount++;
        unassigned.set(headKey, ua);
      }
    });
  }

  return { totalRows, attributedRows, totalAmount, attributedAmount };
}

// ─── Public loader ───────────────────────────────────────────────────────────

export async function loadPrimaryAttribution(
  fy: string,
  distMap: DistributorTmMap,
): Promise<PrimaryAttributionResult> {
  const cached = _cache.get(fy);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.result;

  const noDiag = (distMapAvailable: boolean): PrimaryAttributionDiagnostics => ({
    distMapAvailable,
    orderBookingAvailable: false,
    dispatchSaleAvailable: false,
    totalOrderRows: 0,
    attributedOrderRows: 0,
    totalOrderAmount: 0,
    attributedOrderAmount: 0,
    totalSaleRows: 0,
    attributedSaleRows: 0,
    totalSaleAmount: 0,
    attributedSaleAmount: 0,
    attributionPct: null,
  });

  if (distMap.error || distMap.byPartyKey.size === 0) {
    return {
      perMember: new Map(),
      unassignedByHead: new Map(),
      diagnostics: noDiag(!distMap.error),
      error: distMap.error ?? "Distributor-TM map is empty — per-member primary attribution unavailable",
    };
  }

  const orderSheetId = ORDER_BOOKING_SHEET_IDS[fy];
  const saleSheetId = DISPATCH_SALE_SHEET_IDS[fy];

  if (!orderSheetId && !saleSheetId) {
    return {
      perMember: new Map(),
      unassignedByHead: new Map(),
      diagnostics: noDiag(true),
      error: `No primary attribution sheets configured for FY${fy}`,
    };
  }

  const perMember = new Map<string, MemberPrimaryStats>();
  const unassigned = new Map<string, UnassignedPrimary>();

  let orderStats: ReadStats = { totalRows: 0, attributedRows: 0, totalAmount: 0, attributedAmount: 0 };
  let saleStats: ReadStats = { totalRows: 0, attributedRows: 0, totalAmount: 0, attributedAmount: 0 };
  let orderAvailable = false;
  let saleAvailable = false;

  try {
    if (orderSheetId) {
      orderStats = await readSheetByCustomer(orderSheetId, distMap, perMember, unassigned, "order");
      orderAvailable = true;
      logger.info(
        { fy, ...orderStats },
        "primaryAttribution: order booking attributed",
      );
    }
  } catch (err) {
    logger.warn({ err, fy }, "primaryAttribution: order booking sheet unavailable");
  }

  try {
    if (saleSheetId) {
      saleStats = await readSheetByCustomer(saleSheetId, distMap, perMember, unassigned, "sale");
      saleAvailable = true;
      logger.info(
        { fy, ...saleStats },
        "primaryAttribution: dispatch sale attributed",
      );
    }
  } catch (err) {
    logger.warn({ err, fy }, "primaryAttribution: dispatch sale sheet unavailable");
  }

  const diag: PrimaryAttributionDiagnostics = {
    distMapAvailable: true,
    orderBookingAvailable: orderAvailable,
    dispatchSaleAvailable: saleAvailable,
    totalOrderRows: orderStats.totalRows,
    attributedOrderRows: orderStats.attributedRows,
    totalOrderAmount: orderStats.totalAmount,
    attributedOrderAmount: orderStats.attributedAmount,
    totalSaleRows: saleStats.totalRows,
    attributedSaleRows: saleStats.attributedRows,
    totalSaleAmount: saleStats.totalAmount,
    attributedSaleAmount: saleStats.attributedAmount,
    attributionPct:
      orderStats.totalAmount > 0
        ? orderStats.attributedAmount / orderStats.totalAmount
        : null,
  };

  const result: PrimaryAttributionResult = {
    perMember,
    unassignedByHead: unassigned,
    diagnostics: diag,
    error: null,
  };

  _cache.set(fy, { ts: Date.now(), result });
  return result;
}
