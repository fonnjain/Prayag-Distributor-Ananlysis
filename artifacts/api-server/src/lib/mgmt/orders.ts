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
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { logger } from "../logger.js";
import {
  readTabRowsChunked,
  getGoogleAccessToken,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import {
  normName,
  normSecKey,
  parseOrderDate,
  mgmtMonthIndex,
  fyShort,
  fyStartYear,
} from "./names.js";
import { mgmtSources } from "./roster.js";

export type RetailerStat = { amount: number; orderIds: Set<string>; name: string };

export type TmOrderAgg = {
  displayName: string;
  amount: number;
  monthAmount: number[];
  // Sale Report measure = Σ net "Sub Total" — identical to `amount`. The report
  // keeps a separate field so the Sale and Order Booked columns stay wired, but
  // both are NET after discount now (the gross "Order Value" column is never
  // used, per the signed-off definition).
  saleAmount: number;
  saleMonthAmount: number[];
  monthOrderIds: Array<Set<string>>;
  orderIds: Set<string>;
  retailers: Map<string, RetailerStat>;
  // Raw segment label -> net Sub Total for THIS member (per-rep segment mix).
  // Additive: the management report/verify never read this; it drives the
  // Sales People deep-dive's By Segment and By Group (via the INDEX map) tables.
  perSegment: Map<string, number>;
  // retailerId -> segment -> amount. Populated at read time (both party and
  // segment appear on every order row). Drives the 3A/3B/3C per-state/party/
  // segment cross-dimensional report tables in the per-salesperson Reports tab.
  perPartyPerSegment: Map<string, Map<string, number>>;
  // retailerId -> state. Populated at read time if the source file carries a
  // State/Territory column; otherwise filled lazily via enrichOrderAggWithRosterState.
  partyState: Map<string, string>;
  // state -> retailerId -> cumulative amount (same source as partyState).
  perStatePerParty: Map<string, Map<string, number>>;
  // state -> 12-element fiscal-month amount array (same source).
  perStatePerMonth: Map<string, number[]>;
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
  // Σ net "Sub Total" across all counted rows = the Sale Report total.
  // Equal to totalAmount (both net); kept for the report's Sale columns.
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

// Uploaded-copy fallback. When the live Sheets read fails (403 not shared, 404,
// folder listing error) or the file does not exist in Drive yet, a manually
// placed xlsx copy of the same Secondary Order Booking workbook is parsed by
// the SAME content-based parser so the dashboard still populates instead of
// going blank. Location: ORDER_UPLOAD_DIR (or ./uploads under the process cwd)
// / secondary-order-booking-<fy>.xlsx.
function orderUploadDir(): string {
  return resolve(process.env.ORDER_UPLOAD_DIR ?? join(process.cwd(), "uploads"));
}
export function orderUploadPath(fy: string): string {
  return join(orderUploadDir(), `secondary-order-booking-${fy}.xlsx`);
}
function findUploadedOrderFile(fy: string): string | null {
  const p = orderUploadPath(fy);
  return existsSync(p) ? p : null;
}

// Coerce an exceljs cell into the same value shape the Sheets values.get path
// produces (string | number | boolean | null). Date cells become an Excel
// serial so parseOrderDate treats them exactly like a Sheets serial.
function xlsxCellValue(v: unknown): SheetCellValue {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
    return v;
  }
  if (v instanceof Date) {
    return Math.round(v.getTime() / 86_400_000) + 25_569;
  }
  const o = v as Record<string, unknown>;
  if ("result" in o) return xlsxCellValue(o.result);
  if ("text" in o) return xlsxCellValue(o.text);
  if (Array.isArray(o.richText)) {
    return (o.richText as Array<{ text?: string }>)
      .map((t) => t?.text ?? "")
      .join("");
  }
  return String(v);
}

// Streams an uploaded xlsx copy of the order workbook and feeds its rows to the
// same batch handler the live path uses. Rows are emitted 0-indexed to match
// the Sheets values.get shape.
async function readUploadedOrderXlsx(
  filePath: string,
  tab: string,
  onBatch: (rows: SheetCellValue[][]) => void,
): Promise<{ rowsRead: number }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  // xlsx truncates tab titles to 31 chars; match by startsWith, never equality.
  const needle = tab.slice(0, 31);
  const ws =
    wb.worksheets.find((w) => w.name === tab || w.name.startsWith(needle)) ??
    wb.worksheets[0];
  if (!ws) return { rowsRead: 0 };
  let rowsRead = 0;
  let batch: SheetCellValue[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
    batch.push(raw.map((c) => xlsxCellValue(c)));
    rowsRead++;
    if (batch.length >= 5_000) {
      onBatch(batch);
      batch = [];
    }
  });
  if (batch.length) onBatch(batch);
  return { rowsRead };
}

// Header names drift across years (Team member vs Team Member Name, ID vs
// Retailer Id) — detect columns by content, not position.
type ColMap = {
  date: number;
  retailerId: number;
  retailerName: number;
  orderId: number;
  subTotal: number;
  distributor: number;
  teamMember: number;
  segment: number;
  // -1 when the file has no State/Territory column (populate from roster instead).
  state: number;
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
  // A separate display-name column when the file carries both an id and a name
  // (newer files). If the only retailer column is the one already chosen as the
  // id, there is no distinct name (-1) and the deep-dive falls back to the id.
  let retailerName = find("retailername", "party", "partyname", "customer", "customername", "retailer");
  if (retailerName === retailerId) retailerName = -1;
  const orderId = find("orderid", "orderno");
  // "Sub Total" (net after discount) is the reconciling measure for BOTH the
  // Order Booked and Sale Report columns; it matches the workbook's own header
  // total. Fall back to "Order Value" only if Sub Total is absent (older files).
  const subTotal = find("subtotal", "ordervalue");
  const distributor = find("distributor", "distributorname");
  const teamMember = find("teammembername", "teammember");
  const segment = find("segment");
  // Optional: State/Territory column allows state-based cross-dimensional reports.
  // When absent (-1), callers derive state from the roster spine.
  const state = find("state", "statename", "territory", "stateterritory");
  // Require a retailer/id column too, so a stray banner row that happens to
  // carry date/team/segment/value labels cannot be mistaken for the header.
  if (date < 0 || teamMember < 0 || subTotal < 0 || segment < 0 || retailerId < 0)
    return null;
  return { date, retailerId, retailerName, orderId, subTotal, distributor, teamMember, segment, state };
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
  let spreadsheetId: string | null = null;
  // A folder-listing failure is a live-source failure: defer it so an uploaded
  // copy can still populate the dashboard, and surface the real reason only if
  // no upload exists.
  let resolveError: unknown = null;
  try {
    spreadsheetId = await resolveOrderFileId(fy);
  } catch (err) {
    resolveError = err;
  }
  const tab = mgmtSources().secondary_order_booking.tab;
  const perTm = new Map<string, TmOrderAgg>();
  const retailerFirst = new Map<string, number>();
  const segmentTotals = new Map<string, number>();
  let cols: ColMap | null = null;
  let totalAmount = 0;
  let totalSaleAmount = 0;
  let dateParseFailures = 0;
  let earliestDate: number | null = null;
  let latestDate: number | null = null;
  // Multi-line orders can leave Date/Retailer/Order ID/Team Member blank on
  // continuation rows — forward-fill them down the block. Carried across
  // chunk boundaries (chunks arrive sequentially).
  const carry: {
    date: SheetCellValue;
    retailerId: string;
    retailerName: string;
    orderId: string;
    teamMember: SheetCellValue;
    distributor: string;
    segment: string;
    state: string;
  } = { date: null, retailerId: "", retailerName: "", orderId: "", teamMember: null, distributor: "", segment: "", state: "" };

  const cellStr = (v: SheetCellValue): string => String(v ?? "").trim();
  const blank = (v: SheetCellValue): boolean => v == null || cellStr(v) === "";

  // Fresh accumulators can be discarded and rebuilt if the live read fails
  // partway and we fall back to the uploaded copy.
  const resetAccumulators = (): void => {
    perTm.clear();
    retailerFirst.clear();
    segmentTotals.clear();
    cols = null;
    totalAmount = 0;
    totalSaleAmount = 0;
    dateParseFailures = 0;
    earliestDate = null;
    latestDate = null;
    carry.date = null;
    carry.retailerId = "";
    carry.retailerName = "";
    carry.orderId = "";
    carry.teamMember = null;
    carry.distributor = "";
    carry.segment = "";
    carry.state = "";
  };

  const handleBatch = (rows: SheetCellValue[][]): void => {
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
        if (cols.retailerName >= 0 && !blank(r[cols.retailerName])) {
          carry.retailerName = cellStr(r[cols.retailerName]);
        }
        if (cols.orderId >= 0 && !blank(r[cols.orderId])) {
          carry.orderId = cellStr(r[cols.orderId]);
        }
        if (cols.distributor >= 0 && !blank(r[cols.distributor])) {
          carry.distributor = cellStr(r[cols.distributor]);
        }
        if (!blank(r[cols.segment])) carry.segment = cellStr(r[cols.segment]);
        if (cols.state >= 0 && !blank(r[cols.state])) carry.state = cellStr(r[cols.state]);

        const tmRaw = carry.teamMember;
        if (tmRaw == null || tmRaw === "") continue;
        const dateSerial = parseOrderDate(carry.date);
        if (dateSerial == null) { dateParseFailures++; continue; }
        if (earliestDate == null || dateSerial < earliestDate) earliestDate = dateSerial;
        if (latestDate == null || dateSerial > latestDate) latestDate = dateSerial;
        // A fully blank row inherits everything and carries no amount — it
        // contributes nothing (blank Sub Total coerces to 0 below).
        const amountRaw = r[cols.subTotal];
        const amount = Number(amountRaw);
        const lineAmount =
          !blank(amountRaw) && Number.isFinite(amount) ? amount : 0;
        // Sale Report and Order Booked are both the NET Sub Total now.
        const lineSale = lineAmount;
        const retailerId = carry.retailerId;
        if (retailerId) {
          const prev = retailerFirst.get(retailerId);
          if (prev === undefined || dateSerial < prev) {
            retailerFirst.set(retailerId, dateSerial);
          }
        }
        // Count the whole file the way the company does: every dated row is
        // bucketed by calendar month (Apr->0 .. Mar->11), never dropped for
        // being out of the fiscal year, so the annual total reconciles to the
        // workbook's own grand total and the signed-off per-head figures.
        const monthIdx = mgmtMonthIndex(dateSerial);
        const key = normSecKey(String(tmRaw));
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
            perSegment: new Map<string, number>(),
            perPartyPerSegment: new Map<string, Map<string, number>>(),
            partyState: new Map<string, string>(),
            perStatePerParty: new Map<string, Map<string, number>>(),
            perStatePerMonth: new Map<string, number[]>(),
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
          agg.perSegment.set(
            carry.segment,
            (agg.perSegment.get(carry.segment) ?? 0) + lineAmount,
          );
          // perPartyPerSegment: always populated (party + segment both available).
          if (retailerId) {
            let pps = agg.perPartyPerSegment.get(retailerId);
            if (!pps) { pps = new Map(); agg.perPartyPerSegment.set(retailerId, pps); }
            pps.set(carry.segment, (pps.get(carry.segment) ?? 0) + lineAmount);
          }
        }
        const orderId = carry.orderId;
        if (orderId) {
          agg.orderIds.add(orderId);
          agg.monthOrderIds[monthIdx].add(orderId);
        }
        if (retailerId) {
          let rs = agg.retailers.get(retailerId);
          if (!rs) {
            rs = { amount: 0, orderIds: new Set<string>(), name: carry.retailerName || retailerId };
            agg.retailers.set(retailerId, rs);
          } else if (!rs.name && carry.retailerName) {
            rs.name = carry.retailerName;
          }
          rs.amount += lineAmount;
          if (orderId) rs.orderIds.add(orderId);
          // State-based maps: populated when the file carries a State column.
          // When absent, buildSalesReports derives state from the roster spine instead.
          if (carry.state && lineAmount !== 0) {
            if (!agg.partyState.has(retailerId)) {
              agg.partyState.set(retailerId, carry.state);
            }
            const st = agg.partyState.get(retailerId) ?? carry.state;
            let spp = agg.perStatePerParty.get(st);
            if (!spp) { spp = new Map(); agg.perStatePerParty.set(st, spp); }
            spp.set(retailerId, (spp.get(retailerId) ?? 0) + lineAmount);
            let spm = agg.perStatePerMonth.get(st);
            if (!spm) { spm = new Array(12).fill(0) as number[]; agg.perStatePerMonth.set(st, spm); }
            spm[monthIdx] += lineAmount;
          }
        }
        const distributor = carry.distributor;
        if (isDirectDealer(distributor)) {
          agg.directAmount += lineAmount;
          if (retailerId) agg.directRetailers.add(retailerId);
        } else if (distributor) {
          agg.distributors.add(distributor.toLowerCase());
        }
      }
  };

  let rowsRead = 0;
  // sourceId records what was actually read: the Drive spreadsheet id, or
  // "uploaded:<file>" when the fallback copy was used.
  let sourceId: string = spreadsheetId ?? "";
  const upload = findUploadedOrderFile(fy);
  const LIVE_MISSING = "__no_live_file__";
  try {
    if (resolveError) throw resolveError;
    if (!spreadsheetId) throw new Error(LIVE_MISSING);
    ({ rowsRead } = await readTabRowsChunked(spreadsheetId, tab, handleBatch));
  } catch (err) {
    const liveMissing = err instanceof Error && err.message === LIVE_MISSING;
    if (!upload) {
      if (liveMissing) {
        const st: OrderLoadStatus = {
          fy,
          status: "no-file",
          detail:
            `${fy} Secondary Order Booking file not found in the Drive folder ` +
            `(no configured id and no spreadsheet titled with "${fy}", "${fyShort(fy)}" or "${fyStartYear(fy)}"), ` +
            `and no uploaded copy was found at ${orderUploadPath(fy)}.`,
        };
        loadStatus.set(fy, st);
        logger.warn({ fy }, st.detail);
        return null;
      }
      if (resolveError) {
        const st: OrderLoadStatus = {
          fy,
          status: "error",
          httpStatus: googleStatus(err),
          detail:
            `Could not list the order-booking Drive folder for ${fy} ` +
            `(${err instanceof Error ? err.message : String(err)}), ` +
            `and no uploaded copy was found at ${orderUploadPath(fy)}.`,
        };
        loadStatus.set(fy, st);
        logger.error({ fy, detail: st.detail }, "order booking folder listing failed");
        return null;
      }
      const st = errorDetail(fy, spreadsheetId ?? "(none)", err);
      loadStatus.set(fy, st);
      logger.error(
        { fy, spreadsheetId, httpStatus: st.httpStatus, detail: st.detail },
        "order booking file read failed",
      );
      return null;
    }
    // Live read unavailable but an uploaded copy exists: rebuild from it with
    // the SAME content-based parser so the dashboard still populates.
    resetAccumulators();
    try {
      ({ rowsRead } = await readUploadedOrderXlsx(upload, tab, handleBatch));
      sourceId = `uploaded:${basename(upload)}`;
      logger.warn(
        {
          fy,
          upload,
          reason: liveMissing
            ? "no-live-file"
            : err instanceof Error
              ? err.message
              : String(err),
        },
        "order booking live read unavailable; used uploaded copy",
      );
    } catch (uErr) {
      const st: OrderLoadStatus = {
        fy,
        status: "error",
        detail:
          `Live read for ${fy} was unavailable and the uploaded copy at ${upload} ` +
          `could not be read: ${uErr instanceof Error ? uErr.message : String(uErr)}`,
      };
      loadStatus.set(fy, st);
      logger.error({ fy, upload }, st.detail);
      return null;
    }
  }
  if (!cols) {
    const st: OrderLoadStatus = {
      fy,
      status: "error",
      detail:
        `Header row not detected in tab "${tab}" of source ${sourceId} (${fy}); ` +
        `expected a row containing Date, a team-member column, Segment and Sub Total/Order Value.`,
      spreadsheetId: sourceId,
      rowsRead,
    };
    loadStatus.set(fy, st);
    logger.error({ fy, sourceId, rowsRead }, st.detail);
    return null;
  }
  const agg: OrderFileAgg = {
    fy,
    spreadsheetId: sourceId,
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
    detail: `Read ${rowsRead} rows from source ${sourceId}.`,
    rowsRead,
    spreadsheetId: sourceId,
  });
  logger.info(
    {
      fy,
      sourceId,
      rowsRead,
      teamMembers: perTm.size,
      retailers: retailerFirst.size,
      segments: segmentTotals.size,
      totalAmount: Math.round(totalAmount),
      totalSaleAmount: Math.round(totalSaleAmount),
      dateParseFailures,
      earliestDate,
      latestDate,
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
