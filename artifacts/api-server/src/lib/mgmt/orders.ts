// Secondary order booking reader + per-team-member aggregation.
//
// Source: "Secondary Order Booking Segment Wise(<FY>)" Google Sheets, tab
// "Data Sheet" (~380k rows per FY). Read via chunked values.get only — never
// files.export (the 2025-26 file is ~8.3 MB; export has a 10 MB cap). Measure
// = the per-line "Sub Total" column, which reconciles exactly with the
// workbook's own header total (verified for 2025-26: 2,310,913,869; the
// "Order Value" column is the gross MRP value before discount). In the older
// files (2023-24 and earlier) Sub Total is a per-discount-block subtotal on
// the block's first line with blank continuation lines, so summing per-line
// values still reproduces the workbook total.
//
// Header names drift across years (Team member vs TEAM MEMBER vs Team Member
// Name, ID vs Retailer Id, Retailers vs Retailer) — columns are detected by
// content, never by position, and the header row is found by scanning past
// any leading totals/ids rows.
//
// Every load records an OrderLoadStatus so the report and the options
// endpoint can surface the real reason a file was not read (403 = not
// shared, 404 = wrong id, no file in folder, header not detected) instead of
// a silent "source needed".
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
  fyShort,
  fyStartYear,
} from "./names.js";
import { mgmtSources } from "./roster.js";

export type RetailerStat = { amount: number; orderIds: Set<string> };

export type TmOrderAgg = {
  displayName: string;
  amount: number;
  monthAmount: number[];
  // Sale Report measure = Σ "Order Value" (gross MRP, per-line) — distinct
  // from `amount`/`monthAmount`, which are Σ "Sub Total" (net Order Booked).
  saleAmount: number;
  saleMonthAmount: number[];
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
  // raw Segment label -> total in-FY amount (for INDEX-map reconciliation)
  segmentTotals: Map<string, number>;
  totalAmount: number;
  // Σ "Order Value" (gross MRP) across in-FY rows = the Sale Report total.
  totalSaleAmount: number;
  rowsRead: number;
  loadedAt: number;
};

// Why a file did or did not load. "no-file" = nothing to read (id blank and
// folder autodiscovery found no match); "error" = the read itself failed and
// detail carries the exact reason (Google HTTP status included when known).
export type OrderLoadStatus = {
  fy: string;
  status: "ok" | "no-file" | "error";
  httpStatus?: number;
  detail: string;
  rowsRead?: number;
  spreadsheetId?: string;
};

const ORDERS_TTL_MS = 15 * 60_000;
const cache = new Map<string, OrderFileAgg>();
const loadStatus = new Map<string, OrderLoadStatus>();
let discoveredCurrent: { fy: string; id: string | null; at: number } | null =
  null;

export function getOrderLoadStatus(fy: string): OrderLoadStatus | undefined {
  return loadStatus.get(fy);
}

function isDirectDealer(distributor: string): boolean {
  const d = distributor.toLowerCase().replace(/[^a-z]/g, "");
  return d === "" || d === "direct" || d === "directdealer";
}

// The 2026-27 file id is blank in config until the company creates it;
// autodiscover it from the folder by name. Per spec, match a title containing
// the full FY ("2026-27"), the short form ("26-27"), or the start year
// ("2026") — sibling files are named like "...(2025-26)" so a bare start-year
// match cannot collide with them.
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
  const token = await getGoogleAccessToken();
  const q = encodeURIComponent(
    `'${cfg.folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Drive folder listing failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as {
    files?: Array<{ id: string; name: string }>;
  };
  const needles = [fy, fyShort(fy), String(fyStartYear(fy))];
  const hit = (data.files ?? []).find((f) =>
    needles.some((n) => f.name.includes(n)),
  );
  if (hit) {
    logger.info(
      { fy, fileId: hit.id, fileName: hit.name },
      "order booking file autodiscovered in Drive folder",
    );
  }
  discoveredCurrent = { fy, id: hit?.id ?? null, at: Date.now() };
  return hit?.id ?? null;
}

// Header names drift across years (Team member vs Team Member Name, ID vs
// Retailer Id) — detect columns by content, not position.
type ColMap = {
  date: number;
  retailerId: number;
  orderId: number;
  subTotal: number;
  // Gross MRP per line ("Order Value"); -1 in older files that lack it.
  orderValue: number;
  distributor: number;
  teamMember: number;
  segment: number;
};

function detectColumns(row: SheetCellValue[]): ColMap | null {
  const idx: Record<string, number> = {};
  row.forEach((c, i) => {
    const label = String(c ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .toLowerCase();
    if (label && !(label in idx)) idx[label] = i;
  });
  const find = (...names: string[]): number => {
    for (const n of names) {
      if (n in idx) return idx[n];
    }
    return -1;
  };
  const date = find("date", "orderdate");
  const retailerId = find("retailerid", "retid", "id", "retailers", "retailer", "retailername");
  const orderId = find("orderid", "orderno");
  // "Sub Total" (net) is the Order Booked measure and reconciles with the
  // workbook's own header total; fall back to "Order Value" only if Sub Total
  // is absent. "Order Value" (gross MRP) is captured separately as the Sale
  // Report measure — it may be absent in older files.
  const subTotal = find("subtotal", "ordervalue");
  const orderValue = find("ordervalue");
  const distributor = find("distributor", "distributorname");
  const teamMember = find("teammembername", "teammember");
  const segment = find("segment");
  // Require a retailer/id column too, so a stray banner row that happens to
  // carry date/team/segment/value labels cannot be mistaken for the header.
  if (date < 0 || teamMember < 0 || subTotal < 0 || segment < 0 || retailerId < 0)
    return null;
  return { date, retailerId, orderId, subTotal, orderValue, distributor, teamMember, segment };
}

// Extract the Google HTTP status from a Sheets/Drive error message like
// "Sheets API request failed (403): ...".
function googleStatus(err: unknown): number | undefined {
  const m = /\((\d{3})\)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : undefined;
}

function errorDetail(fy: string, spreadsheetId: string, err: unknown): OrderLoadStatus {
  const httpStatus = googleStatus(err);
  const raw = err instanceof Error ? err.message : String(err);
  let detail: string;
  if (httpStatus === 403) {
    detail =
      `Google returned 403 (not shared) reading spreadsheet ${spreadsheetId} for ${fy}. ` +
      `Share the file with the connected Google account, then refresh.`;
  } else if (httpStatus === 404) {
    detail =
      `Google returned 404 (file not found) for spreadsheet id ${spreadsheetId} (${fy}). ` +
      `The configured id looks wrong or the file was deleted.`;
  } else {
    detail = `Reading spreadsheet ${spreadsheetId} for ${fy} failed: ${raw.slice(0, 300)}`;
  }
  return { fy, status: "error", httpStatus, detail, spreadsheetId };
}

// Concurrent requests for the same uncached FY share one Sheets read.
const inFlight = new Map<string, Promise<OrderFileAgg | null>>();

// Never throws: any failure is recorded in the per-FY load status (visible
// via getOrderLoadStatus) and logged with the exact reason.
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
  let spreadsheetId: string | null;
  try {
    spreadsheetId = await resolveOrderFileId(fy);
  } catch (err) {
    const st: OrderLoadStatus = {
      fy,
      status: "error",
      httpStatus: googleStatus(err),
      detail: `Could not list the order-booking Drive folder for ${fy}: ${err instanceof Error ? err.message : String(err)}`,
    };
    loadStatus.set(fy, st);
    logger.error({ fy, detail: st.detail }, "order booking folder listing failed");
    return null;
  }
  if (!spreadsheetId) {
    const st: OrderLoadStatus = {
      fy,
      status: "no-file",
      detail:
        `${fy} Secondary Order Booking file not found in the Drive folder ` +
        `(no configured id and no spreadsheet titled with "${fy}", "${fyShort(fy)}" or "${fyStartYear(fy)}").`,
    };
    loadStatus.set(fy, st);
    logger.warn({ fy }, st.detail);
    return null;
  }
  const tab = mgmtSources().secondary_order_booking.tab;
  const bounds = fyBoundsSerial(fy);
  const perTm = new Map<string, TmOrderAgg>();
  const retailerFirst = new Map<string, number>();
  const segmentTotals = new Map<string, number>();
  let cols: ColMap | null = null;
  let totalAmount = 0;
  let totalSaleAmount = 0;
  let skippedOutOfFy = 0;
  // Multi-line orders can leave Date/Retailer/Order ID/Team Member blank on
  // continuation rows — forward-fill them down the block. Carried across
  // chunk boundaries (chunks arrive sequentially).
  const carry: {
    date: SheetCellValue;
    retailerId: string;
    orderId: string;
    teamMember: SheetCellValue;
    distributor: string;
    segment: string;
  } = { date: null, retailerId: "", orderId: "", teamMember: null, distributor: "", segment: "" };

  const cellStr = (v: SheetCellValue): string => String(v ?? "").trim();
  const blank = (v: SheetCellValue): boolean => v == null || cellStr(v) === "";

  let rowsRead = 0;
  try {
    ({ rowsRead } = await readTabRowsChunked(spreadsheetId, tab, (rows) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? [];
        if (!cols) {
          cols = detectColumns(r);
          continue;
        }
        // Forward-fill the order-block header fields.
        if (!blank(r[cols.date])) carry.date = r[cols.date];
        if (!blank(r[cols.teamMember])) carry.teamMember = r[cols.teamMember];
        if (cols.retailerId >= 0 && !blank(r[cols.retailerId])) {
          carry.retailerId = cellStr(r[cols.retailerId]);
        }
        if (cols.orderId >= 0 && !blank(r[cols.orderId])) {
          carry.orderId = cellStr(r[cols.orderId]);
        }
        if (cols.distributor >= 0 && !blank(r[cols.distributor])) {
          carry.distributor = cellStr(r[cols.distributor]);
        }
        if (!blank(r[cols.segment])) carry.segment = cellStr(r[cols.segment]);

        const tmRaw = carry.teamMember;
        if (tmRaw == null || tmRaw === "") continue;
        const dateSerial = parseOrderDate(carry.date);
        if (dateSerial == null) continue;
        // A fully blank row inherits everything and carries no amount — it
        // contributes nothing (blank Sub Total coerces to 0 below).
        const amountRaw = r[cols.subTotal];
        const amount = Number(amountRaw);
        const lineAmount =
          !blank(amountRaw) && Number.isFinite(amount) ? amount : 0;
        // Order Value (gross MRP) is per-line, never forward-filled; absent in
        // older files (orderValue < 0) so Sale Report stays 0 for those years.
        let lineSale = 0;
        if (cols.orderValue >= 0) {
          const saleRaw = r[cols.orderValue];
          const saleNum = Number(saleRaw);
          if (!blank(saleRaw) && Number.isFinite(saleNum)) lineSale = saleNum;
        }
        const retailerId = carry.retailerId;
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
            saleAmount: 0,
            saleMonthAmount: new Array(12).fill(0) as number[],
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
        agg.saleAmount += lineSale;
        agg.saleMonthAmount[monthIdx] += lineSale;
        totalSaleAmount += lineSale;
        if (carry.segment && lineAmount !== 0) {
          segmentTotals.set(
            carry.segment,
            (segmentTotals.get(carry.segment) ?? 0) + lineAmount,
          );
        }
        const orderId = carry.orderId;
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
        const distributor = carry.distributor;
        if (isDirectDealer(distributor)) {
          agg.directAmount += lineAmount;
          if (retailerId) agg.directRetailers.add(retailerId);
        } else if (distributor) {
          agg.distributors.add(distributor.toLowerCase());
        }
      }
    }));
  } catch (err) {
    const st = errorDetail(fy, spreadsheetId, err);
    loadStatus.set(fy, st);
    logger.error(
      { fy, spreadsheetId, httpStatus: st.httpStatus, detail: st.detail },
      "order booking file read failed",
    );
    return null;
  }
  if (!cols) {
    const st: OrderLoadStatus = {
      fy,
      status: "error",
      detail:
        `Header row not detected in tab "${tab}" of spreadsheet ${spreadsheetId} (${fy}); ` +
        `expected a row containing Date, a team-member column, Segment and Sub Total/Order Value.`,
      spreadsheetId,
      rowsRead,
    };
    loadStatus.set(fy, st);
    logger.error({ fy, spreadsheetId, rowsRead }, st.detail);
    return null;
  }
  const agg: OrderFileAgg = {
    fy,
    spreadsheetId,
    perTm,
    retailerFirst,
    segmentTotals,
    totalAmount,
    totalSaleAmount,
    rowsRead,
    loadedAt: Date.now(),
  };
  loadStatus.set(fy, {
    fy,
    status: "ok",
    detail: `Read ${rowsRead} rows from spreadsheet ${spreadsheetId}.`,
    rowsRead,
    spreadsheetId,
  });
  logger.info(
    {
      fy,
      spreadsheetId,
      rowsRead,
      teamMembers: perTm.size,
      retailers: retailerFirst.size,
      segments: segmentTotals.size,
      totalAmount: Math.round(totalAmount),
      totalSaleAmount: Math.round(totalSaleAmount),
      skippedOutOfFy,
    },
    "order booking file opened and aggregated",
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
  loadStatus.clear();
  discoveredCurrent = null;
}
