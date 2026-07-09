// Secondary order booking reader + per-team-member aggregation.
//
// Source: "Secondary Order Booking Segment Wise(<FY>)" Google Sheets, tab
// "Data Sheet" (~380k rows per FY). Read via chunked values.get only — never
// files.export. Measure = the per-line "Sub Total" column, which reconciles
// exactly with the workbook's own header total (verified for 2025-26:
// 2,310,913,869). Order count = distinct Order ID.
//
// Aggregates are cached in-process per FY (the sheets change slowly and a
// full read costs ~8 API calls per file).
import { logger } from "../logger.js";
import {
  readTabRowsChunked,
  getGoogleAccessToken,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import {
  normName,
  parseOrderDate,
  fiscalMonthIndex,
  fyBoundsSerial,
} from "./names.js";
import { mgmtSources } from "./roster.js";

export type RetailerStat = { amount: number; orderIds: Set<string> };

export type TmOrderAgg = {
  displayName: string;
  amount: number;
  monthAmount: number[];
  monthOrderIds: Array<Set<string>>;
  orderIds: Set<string>;
  retailers: Map<string, RetailerStat>;
  directAmount: number;
  directRetailers: Set<string>;
  distributors: Set<string>;
};

export type OrderFileAgg = {
  fy: string;
  spreadsheetId: string;
  perTm: Map<string, TmOrderAgg>;
  // retailerId -> earliest order date serial seen in this file
  retailerFirst: Map<string, number>;
  totalAmount: number;
  rowsRead: number;
  loadedAt: number;
};

const ORDERS_TTL_MS = 15 * 60_000;
const cache = new Map<string, OrderFileAgg>();
let discoveredCurrent: { fy: string; id: string | null; at: number } | null =
  null;

function isDirectDealer(distributor: string): boolean {
  const d = distributor.toLowerCase().replace(/[^a-z]/g, "");
  return d === "" || d === "direct" || d === "directdealer";
}

// The 2026-27 file id is blank in config until the company creates it;
// autodiscover it from the folder by name.
export async function resolveOrderFileId(fy: string): Promise<string | null> {
  const cfg = mgmtSources().secondary_order_booking;
  const configured = cfg.files_by_year[fy];
  if (configured) return configured;
  if (!(fy in cfg.files_by_year)) return null;
  if (
    discoveredCurrent &&
    discoveredCurrent.fy === fy &&
    Date.now() - discoveredCurrent.at < ORDERS_TTL_MS
  ) {
    return discoveredCurrent.id;
  }
  try {
    const token = await getGoogleAccessToken();
    const q = encodeURIComponent(
      `'${cfg.folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
    );
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Drive folder list failed (${res.status})`);
    const data = (await res.json()) as {
      files?: Array<{ id: string; name: string }>;
    };
    const hit = (data.files ?? []).find((f) => f.name.includes(fy));
    discoveredCurrent = { fy, id: hit?.id ?? null, at: Date.now() };
    return hit?.id ?? null;
  } catch (err) {
    logger.warn({ err, fy }, "order booking folder autodiscovery failed");
    return null;
  }
}

// Header names drift across years (Team member vs Team Member Name, ID vs
// Retailer Id) — detect columns by content, not position.
type ColMap = {
  date: number;
  retailerId: number;
  orderId: number;
  subTotal: number;
  distributor: number;
  teamMember: number;
};

function detectColumns(row: SheetCellValue[]): ColMap | null {
  const idx: Record<string, number> = {};
  row.forEach((c, i) => {
    const label = String(c ?? "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (label) idx[label] = i;
  });
  const find = (...names: string[]): number => {
    for (const n of names) {
      if (n in idx) return idx[n];
    }
    return -1;
  };
  const date = find("date", "orderdate");
  const retailerId = find("retailerid", "retid", "id");
  const orderId = find("orderid", "orderno");
  const subTotal = find("subtotal");
  const distributor = find("distributor", "distributorname");
  const teamMember = find("teammembername", "teammember");
  if (date < 0 || teamMember < 0 || subTotal < 0) return null;
  return { date, retailerId, orderId, subTotal, distributor, teamMember };
}

// Concurrent requests for the same uncached FY share one Sheets read.
const inFlight = new Map<string, Promise<OrderFileAgg | null>>();

export async function loadOrderFile(
  fy: string,
): Promise<OrderFileAgg | null> {
  const hit = cache.get(fy);
  if (hit && Date.now() - hit.loadedAt < ORDERS_TTL_MS) return hit;
  const pending = inFlight.get(fy);
  if (pending) return pending;
  const p = loadOrderFileUncached(fy).finally(() => {
    inFlight.delete(fy);
  });
  inFlight.set(fy, p);
  return p;
}

async function loadOrderFileUncached(
  fy: string,
): Promise<OrderFileAgg | null> {
  const spreadsheetId = await resolveOrderFileId(fy);
  if (!spreadsheetId) return null;
  const tab = mgmtSources().secondary_order_booking.tab;
  const bounds = fyBoundsSerial(fy);
  const perTm = new Map<string, TmOrderAgg>();
  const retailerFirst = new Map<string, number>();
  let cols: ColMap | null = null;
  let totalAmount = 0;
  let skippedOutOfFy = 0;

  const { rowsRead } = await readTabRowsChunked(
    spreadsheetId,
    tab,
    (rows, startRowNumber) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        if (!cols) {
          cols = detectColumns(r);
          continue;
        }
        const tmRaw = r[cols.teamMember];
        if (tmRaw == null || tmRaw === "") continue;
        const dateSerial = parseOrderDate(r[cols.date]);
        if (dateSerial == null) continue;
        const amount = Number(r[cols.subTotal]);
        const lineAmount = Number.isFinite(amount) ? amount : 0;
        const retailerId =
          cols.retailerId >= 0 ? String(r[cols.retailerId] ?? "").trim() : "";
        if (retailerId) {
          const prev = retailerFirst.get(retailerId);
          if (prev === undefined || dateSerial < prev) {
            retailerFirst.set(retailerId, dateSerial);
          }
        }
        if (dateSerial < bounds.start || dateSerial > bounds.end) {
          skippedOutOfFy++;
          continue;
        }
        const monthIdx = fiscalMonthIndex(dateSerial, fy);
        if (monthIdx == null) continue;
        const key = normName(tmRaw);
        if (!key) continue;
        let agg = perTm.get(key);
        if (!agg) {
          agg = {
            displayName: String(tmRaw).trim(),
            amount: 0,
            monthAmount: new Array(12).fill(0) as number[],
            monthOrderIds: Array.from({ length: 12 }, () => new Set<string>()),
            orderIds: new Set<string>(),
            retailers: new Map<string, RetailerStat>(),
            directAmount: 0,
            directRetailers: new Set<string>(),
            distributors: new Set<string>(),
          };
          perTm.set(key, agg);
        }
        agg.amount += lineAmount;
        agg.monthAmount[monthIdx] += lineAmount;
        totalAmount += lineAmount;
        const orderId =
          cols.orderId >= 0 ? String(r[cols.orderId] ?? "").trim() : "";
        if (orderId) {
          agg.orderIds.add(orderId);
          agg.monthOrderIds[monthIdx].add(orderId);
        }
        if (retailerId) {
          let rs = agg.retailers.get(retailerId);
          if (!rs) {
            rs = { amount: 0, orderIds: new Set<string>() };
            agg.retailers.set(retailerId, rs);
          }
          rs.amount += lineAmount;
          if (orderId) rs.orderIds.add(orderId);
        }
        const distributor =
          cols.distributor >= 0 ? String(r[cols.distributor] ?? "").trim() : "";
        if (isDirectDealer(distributor)) {
          agg.directAmount += lineAmount;
          if (retailerId) agg.directRetailers.add(retailerId);
        } else if (distributor) {
          agg.distributors.add(distributor.toLowerCase());
        }
      }
      // keep referenced to satisfy the callback signature
      void startRowNumber;
    },
  );
  if (!cols) {
    logger.warn({ fy, spreadsheetId }, "order file header row not detected");
    return null;
  }
  const agg: OrderFileAgg = {
    fy,
    spreadsheetId,
    perTm,
    retailerFirst,
    totalAmount,
    rowsRead,
    loadedAt: Date.now(),
  };
  logger.info(
    {
      fy,
      rowsRead,
      teamMembers: perTm.size,
      retailers: retailerFirst.size,
      totalAmount: Math.round(totalAmount),
      skippedOutOfFy,
    },
    "order booking file aggregated",
  );
  cache.set(fy, agg);
  return agg;
}

// Earliest order date per retailer across all configured FY files up to and
// including maxFy. Used to split retailers into new (first order inside the
// report FY) vs old.
export async function loadRetailerFirstSeen(
  maxFy: string,
): Promise<Map<string, number>> {
  const cfg = mgmtSources().secondary_order_booking;
  const fys = Object.keys(cfg.files_by_year)
    .filter((fy) => fy <= maxFy)
    .sort();
  const first = new Map<string, number>();
  for (const fy of fys) {
    const agg = await loadOrderFile(fy);
    if (!agg) continue;
    for (const [retailerId, serial] of agg.retailerFirst) {
      const prev = first.get(retailerId);
      if (prev === undefined || serial < prev) first.set(retailerId, serial);
    }
  }
  return first;
}

export function invalidateOrderCache(): void {
  cache.clear();
  discoveredCurrent = null;
}
