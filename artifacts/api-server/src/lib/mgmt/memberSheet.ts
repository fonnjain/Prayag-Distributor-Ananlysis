// Member's own working sheet reader — source B for Sales Deep Dive Phase 2 + 3.
//
// Each field representative has a personal Google Sheets workbook.
// This module reads the 'Summary Report <FY>' tab, parses the retailer-level
// order booking, sale, visit count, and business plan for that member, then
// computes spread/concentration metrics.
//
// Column layout is HEADER-DETECTED at runtime (not hardcoded), because
// individual member sheets may have columns in different positions.
// The canonical column names (fallback indices below) follow the original spec:
//   C(2)  = Retailer name
//   D(3)  = District
//   E(4)  = City
//   F(5)  = Assigned distributor
//   G(6)  = Distance km
//   W(22) = Business Plan (per retailer)   [may be swapped with X in some sheets]
//   X(23) = Visits Required               [may be swapped with W in some sheets]
//   Z(25) = Order Booking (NET, Sub Total)
//   AA(26)= Sale received
//   AB(27)= Total Visits (YTD cumulative)
//   AD(29)= Achievement % — NEVER used; always recomputed.
//
// Tab selection (in priority order):
//   1. Tab whose name starts with "SUMMARY REPORT" AND contains the FY year
//      (e.g. "Summary Report 2026-27", "Summary Report 26-27")
//   2. Longest tab name starting with "SUMMARY REPORT" (fallback)
//
// Annual Business Plan:
//   Read from the member's '2026-2027' tab (cell that has the FY BP figure).
//
// Member→fileId map:
//   Statically imported from config/member_sheet_map.json.
//   Key = normSecKey(member name) — lowercase alphanumeric, parentheticals kept.
//
// Rules:
//   NET = Sub Total, never Order Total.
//   Achievement always recomputed (OB / businessPlan); never read from sheet %.
//   Google Drive strictly read-only.
//   Never console.log — use logger.
//   Config JSON statically imported (esbuild bundles it; no cwd-relative reads).

import memberSheetMapRaw from "../../../config/member_sheet_map.json" assert { type: "json" };
import { logger } from "../logger.js";
import { computeVisitPlan, type VisitPlan } from "./visitPlan.js";
import {
  readAllTabRows,
  listSheetTabs,
  type SheetCellValue,
} from "../registers/sheetsApi.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MEMBER_FILE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(memberSheetMapRaw as Record<string, string>).filter(
    ([k]) => k !== "_comment",
  ),
);

const SUMMARY_TAB_PREFIX = "SUMMARY REPORT";

// ── Default column indices (0-indexed) ────────────────────────────────────────
// Used as fallback when header detection cannot locate a column.

const DEFAULT_COL = {
  name:         2,   // C
  district:     3,   // D
  city:         4,   // E
  distributor:  5,   // F
  distanceKm:   6,   // G
  businessPlan: 22,  // W
  visitsReq:    23,  // X
  orderBooking: 25,  // Z
  sale:         26,  // AA
  totalVisit:   27,  // AB
  achPct:       29,  // AD (parsed but never used in computation)
} as const;

type ColMap = typeof DEFAULT_COL;

// ── Cell helpers ──────────────────────────────────────────────────────────────

function cellStr(v: SheetCellValue): string {
  return String(v ?? "").trim();
}

function cellNum(v: SheetCellValue): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,%\s₹]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normHeader(v: SheetCellValue): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type RetailerRow = {
  name: string;
  district: string | null;
  city: string | null;
  distributor: string | null;
  distanceKm: number | null;
  businessPlan: number | null;
  visitsRequired: number | null;
  orderBooking: number;
  sale: number;
  totalVisit: number | null;
  achievementPct: number | null;
  isActive: boolean;
};

export type RetailerSpread = {
  totalRetailers: number;
  activeRetailers: number;
  dormantRetailers: number;
  activePct: number;
  totalOrderBooking: number;
  totalSale: number;
  totalVisits: number | null;
  top5ObShare: number | null;
  top10ObShare: number | null;
  concentrationIndex: number | null;
  businessPerActiveRetailer: number | null;
  businessPerVisit: number | null;
  annualBusinessPlan: number | null;
};

export type MemberSheetResult = {
  fileId: string;
  tabName: string;
  rows: RetailerRow[];
  spread: RetailerSpread;
  visitPlan: VisitPlan;
  rowsRead: number;
};

export type MemberSheetData =
  | ({ status: "ok" } & MemberSheetResult)
  | { status: "not-mapped"; error: string }
  | { status: "error"; error: string }
  | { status: "loading"; error: string };

// ── In-process cache ──────────────────────────────────────────────────────────

const TTL_MS = 15 * 60_000;
const _cache = new Map<string, { data: MemberSheetResult; loadedAt: number }>();
const _inFlight = new Map<string, Promise<MemberSheetResult | null>>();

export function invalidateMemberSheetCache(normKey?: string): void {
  if (normKey) _cache.delete(normKey);
  else _cache.clear();
}

// ── Tab finder ────────────────────────────────────────────────────────────────
// Prefers the tab whose name contains the FY year hint (most specific).
// Falls back to the longest tab name starting with the prefix.

async function findSummaryTab(
  fileId: string,
  fy: string,
): Promise<string | null> {
  let tabs: { title: string }[];
  try {
    tabs = await listSheetTabs(fileId);
  } catch (err) {
    logger.warn({ err, fileId }, "memberSheet: listSheetTabs failed");
    return null;
  }

  const p = SUMMARY_TAB_PREFIX;
  const matches = tabs.filter((t) => t.title.toUpperCase().startsWith(p));

  logger.info(
    { fileId, fy, allTabs: tabs.map((t) => t.title), summaryMatches: matches.map((t) => t.title) },
    "memberSheet: tab candidates",
  );

  if (matches.length === 0) return null;

  // Build FY year variants to prefer the FY-specific tab.
  // e.g. fy="2026-27" → ["2026-27","2026-2027","26-27","2026"]
  const fyVariants = [
    fy,
    fy.replace("-", "-20"),
    fy.replace(/^20/, ""),
    fy.slice(0, 4),
  ].map((s) => s.toUpperCase());

  const fyMatch = matches.find((t) => {
    const title = t.title.toUpperCase();
    return fyVariants.some((v) => title.includes(v));
  });

  if (fyMatch) {
    logger.info({ tab: fyMatch.title }, "memberSheet: FY-specific tab selected");
    return fyMatch.title;
  }

  // Fall back to the longest matching tab (more specific is better).
  const fallback = [...matches].sort((a, b) => b.title.length - a.title.length)[0];
  logger.info(
    { tab: fallback.title, reason: "no FY match; using longest" },
    "memberSheet: fallback tab selected",
  );
  return fallback.title;
}

// ── Header detection ──────────────────────────────────────────────────────────
// Scans the first scanLimit rows for a header row and builds a column map.
// A header row is identified by having a text-like value in the col-C area
// that contains RETAILER, PARTY, NAME, or similar.

const COL_SYNONYMS: Record<keyof ColMap, string[]> = {
  name:         ["RETAILER", "PARTYNAME", "RETAILERNAME", "NAME", "CUSTOMER", "PARTY"],
  district:     ["DISTRICT", "DISTRICTNAME"],
  city:         ["CITY", "TOWN"],
  distributor:  ["DISTRIBUTOR", "DISTRIBUTORNAME", "CHANNEL"],
  distanceKm:   ["DISTANCEKM", "DISTANCE", "KMS", "KM"],
  // These two are commonly swapped — detection resolves them dynamically.
  businessPlan: ["BUSINESSPLAN", "PLAN", "BP", "ANNUALBP", "ANNUALPLAN", "MONTHLYBUSINESSPLAN", "TARGETBUSINESS", "BUSINESSP"],
  visitsReq:    ["VISITSREQUIRED", "VISITREQ", "REQUIREDVISIT", "VISITREQUIRED", "VISITSREQD", "REQUIREDVISITS", "VISITREQUD"],
  orderBooking: ["ORDERBOOK", "ORDERBOOKING", "OB", "TOTALOB", "PARTYOB", "OLDPARTYOB", "ORDERB"],
  sale:         ["SALE", "SALES", "SALEREPORT", "SALERECEIVED", "RECEIVED", "TOTALSALE", "SALESRECEIVED"],
  totalVisit:   ["TOTALVISIT", "TOTALVISITS", "NOOFVISIT", "NOOFVISITS", "VISITCOUNT", "ACTUALVISIT"],
  achPct:       ["ACHIEVEMENT", "ACHPCT", "ACH", "ACHIEVEMENTPCT", "PERCACHIEVEMENT"],
};

// Columns that are identity-like (C-G area); skip for synonym scan to avoid mismatches.
const IDENTITY_COLS = new Set<keyof ColMap>(["name", "district", "city", "distributor", "distanceKm"]);

function detectColumns(
  rows: SheetCellValue[][],
  scanLimit = 15,
): { colMap: ColMap; headerRowIndex: number } | null {
  for (let i = 0; i < Math.min(rows.length, scanLimit); i++) {
    const row = rows[i] ?? [];
    // Probe col 2-4 (C-E) for header-like text.
    const probeNorm = normHeader(row[2] ?? row[3] ?? "");
    const isHeaderRow =
      probeNorm.length >= 2 &&
      !/^\d+$/.test(probeNorm) &&
      (
        probeNorm.includes("RETAILER") ||
        probeNorm.includes("PARTY") ||
        probeNorm.includes("NAME") ||
        probeNorm === "SL" ||
        probeNorm === "SR" ||
        probeNorm === "SNO" ||
        probeNorm === "SRNO"
      );

    if (!isHeaderRow) continue;

    const colMap: Record<string, number> = { ...DEFAULT_COL };
    const assigned = new Set<string>();

    for (let c = 0; c < row.length; c++) {
      const h = normHeader(row[c]);
      if (!h) continue;
      for (const [field, synonyms] of Object.entries(COL_SYNONYMS)) {
        if (assigned.has(field)) continue;
        if (synonyms.some((s) => h === s || h.startsWith(s + "S") || h === s + "S")) continue; // skip broad prefix
        if (synonyms.includes(h)) {
          colMap[field] = c;
          assigned.add(field);
        }
      }
    }

    // Second pass: prefix matching for fields not yet assigned (non-identity only).
    for (let c = 0; c < row.length; c++) {
      const h = normHeader(row[c]);
      if (!h) continue;
      for (const [field, synonyms] of Object.entries(COL_SYNONYMS)) {
        if (assigned.has(field)) continue;
        if (IDENTITY_COLS.has(field as keyof ColMap)) continue;
        if (synonyms.some((s) => h.startsWith(s))) {
          colMap[field] = c;
          assigned.add(field);
        }
      }
    }

    logger.info(
      {
        headerRowIndex: i,
        headerRow: row.slice(0, 35).map(String),
        detectedCols: Object.fromEntries(
          Object.entries(colMap).map(([k, v]) => [k, `${v}(${String(row[v as number] ?? "?").slice(0, 20)})`])
        ),
        assignedFields: [...assigned],
        fallbackFields: Object.keys(DEFAULT_COL).filter((k) => !assigned.has(k)),
      },
      "memberSheet: column detection result",
    );

    return { colMap: colMap as ColMap, headerRowIndex: i };
  }

  logger.warn({ scanLimit }, "memberSheet: header row not found; using fixed column positions");
  return null;
}

// ── Annual BP reader (from '2026-2027' tab) ───────────────────────────────────

async function readAnnualBp(
  fileId: string,
  fyLabel: string,
): Promise<number | null> {
  try {
    const tabs = await listSheetTabs(fileId);
    const hit = tabs.find(
      (t) =>
        t.title.replace(/-/g, "").replace(/\s/g, "") ===
        fyLabel.replace(/-/g, "").replace(/\s/g, ""),
    );
    if (!hit) return null;
    const rows = await readAllTabRows(fileId, hit.title);
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      for (const cell of rows[i] ?? []) {
        const n = cellNum(cell);
        if (n !== null && n >= 5_000_000 && n <= 200_000_000) {
          return n;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Core loader ───────────────────────────────────────────────────────────────

async function loadMemberSheetUncached(
  memberKey: string,
  memberName: string,
  fy: string,
): Promise<MemberSheetResult | null> {
  const fileId = MEMBER_FILE_MAP[memberKey];
  if (!fileId) return null;

  const tabName = await findSummaryTab(fileId, fy);
  if (!tabName) {
    logger.warn({ memberKey, fileId, fy }, "memberSheet: summary tab not found");
    return null;
  }

  let allRows: SheetCellValue[][];
  try {
    allRows = await readAllTabRows(fileId, tabName);
  } catch (err) {
    logger.warn({ err, memberKey, fileId, tabName }, "memberSheet: read failed");
    return null;
  }

  logger.info(
    { memberKey, fileId, tabName, rows: allRows.length },
    "memberSheet: raw rows read",
  );

  // Detect columns — for data-start inference and logging only.
  // DEFAULT_COL positions are always used for data extraction because the
  // header has multiple "Order Booking" columns (one per FY) and we must
  // pick the 2026-27 one at its fixed position (W-AD).
  const detected = detectColumns(allRows);
  const COL: ColMap = DEFAULT_COL;
  // Data starts two rows after the header (header + one blank/separator row).
  const dataStart = detected ? detected.headerRowIndex + 2 : 6;

  // Tokens in the name column that mean "skip this row".
  const SKIP_TOKENS = new Set([
    "RETAILERNAME", "RETAILER", "NAME",
    "SRLNO", "SL", "SR", "NO", "SNO", "SRNO",
  ]);
  // Tokens in the name column that mean "stop reading — end of section".
  const STOP_TOKENS = new Set(["TOTAL", "GRANDTOTAL", "SUBTOTAL"]);

  const rows: RetailerRow[] = [];
  let blankRun = 0;

  for (let i = dataStart; i < allRows.length; i++) {
    const row = allRows[i] ?? [];
    const rawName = cellStr(row[COL.name]);

    if (!rawName) {
      blankRun++;
      // 3+ consecutive blank name-column cells → section boundary; stop.
      if (blankRun >= 3) break;
      continue;
    }
    blankRun = 0;

    const nameNorm = normHeader(rawName);

    // End-of-section markers: TOTAL / GRAND TOTAL row → stop.
    if (STOP_TOKENS.has(nameNorm) || nameNorm.startsWith("GRANDTOTAL") || nameNorm.startsWith("TOTAL")) break;
    // Header / metadata tokens → skip but keep reading.
    if (SKIP_TOKENS.has(nameNorm)) continue;
    // Serial-number-only cells → skip.
    if (/^\d+$/.test(rawName.trim())) continue;

    const ob   = cellNum(row[COL.orderBooking]) ?? 0;
    const sale = cellNum(row[COL.sale]) ?? 0;
    const plan = cellNum(row[COL.businessPlan]);

    const achPct =
      plan !== null && plan > 0 ? (ob / plan) * 100 : null;

    rows.push({
      name:           rawName,
      district:       cellStr(row[COL.district]) || null,
      city:           cellStr(row[COL.city]) || null,
      distributor:    cellStr(row[COL.distributor]) || null,
      distanceKm:     cellNum(row[COL.distanceKm]),
      businessPlan:   plan,
      visitsRequired: cellNum(row[COL.visitsReq]),
      orderBooking:   ob,
      sale,
      totalVisit:     cellNum(row[COL.totalVisit]),
      achievementPct: achPct,
      isActive:       ob > 0 || sale > 0,
    });
  }

  logger.info(
    { memberKey, tabName, retailers: rows.length, dataStart },
    "memberSheet: retailers parsed",
  );

  const spread = computeSpread(rows, fileId, fy, memberName);

  const fyTabLabel = fy === "2026-27" ? "2026-2027" : `20${fy.replace("-", "-20")}`;
  const annualBp = await readAnnualBp(fileId, fyTabLabel);
  spread.annualBusinessPlan = annualBp ?? spread.annualBusinessPlan;

  const visitPlan = computeVisitPlan(rows, fy);

  return {
    fileId,
    tabName,
    rows,
    spread,
    visitPlan,
    rowsRead: allRows.length,
  };
}

function computeSpread(
  rows: RetailerRow[],
  fileId: string,
  fy: string,
  memberName: string,
): RetailerSpread {
  const active  = rows.filter((r) => r.isActive);
  const dormant = rows.filter((r) => !r.isActive);

  const totalOB   = rows.reduce((s, r) => s + r.orderBooking, 0);
  const totalSale = rows.reduce((s, r) => s + r.sale, 0);

  const visitRows  = rows.filter((r) => r.totalVisit !== null);
  const totalVisits =
    visitRows.length > 0
      ? visitRows.reduce((s, r) => s + (r.totalVisit ?? 0), 0)
      : null;

  const sorted   = [...active].sort((a, b) => b.orderBooking - a.orderBooking);
  const top5Ob   = sorted.slice(0, 5).reduce((s, r) => s + r.orderBooking, 0);
  const top10Ob  = sorted.slice(0, 10).reduce((s, r) => s + r.orderBooking, 0);

  const top5Share  = totalOB > 0 ? (top5Ob / totalOB) * 100 : null;
  const top10Share = totalOB > 0 ? (top10Ob / totalOB) * 100 : null;

  const hhi =
    totalOB > 0
      ? active.reduce((s, r) => {
          const share = r.orderBooking / totalOB;
          return s + share * share * 10000;
        }, 0)
      : null;

  const businessPerActive =
    active.length > 0 && totalOB > 0 ? totalOB / active.length : null;
  const businessPerVisit =
    totalVisits !== null && totalVisits > 0 ? totalOB / totalVisits : null;

  const colWSum = rows.reduce((s, r) => s + (r.businessPlan ?? 0), 0);

  logger.info(
    {
      fileId, fy, memberName,
      retailers: rows.length,
      active: active.length,
      dormant: dormant.length,
      totalOB, totalSale, totalVisits,
      top5Share, top10Share, hhi,
      businessPerActive, businessPerVisit,
    },
    "memberSheet: spread — verify against acceptance criteria",
  );

  return {
    totalRetailers:             rows.length,
    activeRetailers:            active.length,
    dormantRetailers:           dormant.length,
    activePct:                  rows.length > 0 ? (active.length / rows.length) * 100 : 0,
    totalOrderBooking:          totalOB,
    totalSale,
    totalVisits,
    top5ObShare:                top5Share,
    top10ObShare:               top10Share,
    concentrationIndex:         hhi,
    businessPerActiveRetailer:  businessPerActive,
    businessPerVisit,
    annualBusinessPlan:         colWSum > 0 ? colWSum : null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getMemberFileId(normKey: string): string | undefined {
  return MEMBER_FILE_MAP[normKey];
}

export async function loadMemberSheet(
  memberKey: string,
  memberName: string,
  fy: string,
): Promise<MemberSheetData> {
  if (!MEMBER_FILE_MAP[memberKey]) {
    return {
      status: "not-mapped",
      error: `No working sheet is mapped for this member yet. Add '${memberKey}' → fileId in config/member_sheet_map.json to enable retailer-level detail.`,
    };
  }

  const cacheKey = `${memberKey}|${fy}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) {
    return { status: "ok", ...hit.data };
  }

  const pending = _inFlight.get(cacheKey);
  if (pending) {
    const result = await pending;
    return result
      ? { status: "ok", ...result }
      : { status: "error", error: "Sheet read failed." };
  }

  const p = loadMemberSheetUncached(memberKey, memberName, fy).then((result) => {
    if (result) _cache.set(cacheKey, { data: result, loadedAt: Date.now() });
    return result;
  }).finally(() => _inFlight.delete(cacheKey));

  _inFlight.set(cacheKey, p);

  try {
    const result = await p;
    if (!result) {
      return { status: "error", error: "Could not read the member's working sheet." };
    }
    return { status: "ok", ...result };
  } catch (err) {
    logger.warn({ err, memberKey, fy }, "memberSheet: load threw");
    return {
      status: "error",
      error: `Sheet read error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
