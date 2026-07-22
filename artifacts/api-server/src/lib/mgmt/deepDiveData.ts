// Sales Deep Dive — reads the 'Data' tab of the STATE HEAD DASHBOARD.
//
// The 'Data' tab contains one row per team member with all mandatory KPIs:
// targets, cost (CTC, T.A.), retailer counts, order booking, and sales.
// This is SOURCE A for the Sales Deep Dive page (Phase 1).
//
// Rules (non-negotiable):
//  - NET = Sub Total, never Order Total.
//  - Achievement recomputed (received / plan); never read from a sheet % cell.
//  - Dashboard is the authority for headline secondary OB and sales.
//  - Direct Dealer order is kept separate from retailer/party OB.
//  - Match by normSecKey (preserves parentheticals like (Off Roll)).
//  - Closed FYs: serve from DB snapshot when available (Phase 2+).
//    Phase 1 only covers the live year read from Sheets.
//  - Never console.log; use logger.

import { logger } from "../logger.js";
import {
  readAllTabRows,
  listSheetTabs,
  type SheetCellValue,
  type SheetTab,
} from "../registers/sheetsApi.js";

// ── Config ────────────────────────────────────────────────────────────────────

// Same spreadsheet as the ORDER BOOKING tab (stateDashboard.ts).
const SHEET_IDS: Record<string, string> = {
  "2026-27": "1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM",
  "2025-26": "1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY",
  "2024-25": "1MwNMVzWE3QBVOyJjKr3eFX-Sq1Ng0Q1sghWJbgbE_8g",
  "2023-24": "1ESjgk5FthsvYc_Bk9zuJVnJ1XtwKQxv0XG2onuspnhg",
};

// The tab holding per-member mandatory KPIs (header row 3).
const DATA_TAB_NAME = "Data";

// ── Name normalization ────────────────────────────────────────────────────────

// Secondary key: preserves parentheticals so "Ravi" and "Ravi (Faridabad)"
// remain distinct. Must match the normSecKey used in stateDashboard.ts.
export function normSecKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

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
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemberKpis = {
  stateHead: string;
  name: string;
  normKey: string;
  // Identity
  hq: string | null;
  designation: string | null;
  contact: string | null;
  // Targets
  primaryTarget: number | null;    // Annual primary sales target
  secondaryTarget: number | null;  // Business Plan (annual secondary target)
  monthlyTarget: number | null;    // Monthly secondary target
  // Performance (YTD from Data tab — NET = Sub Total)
  orderBooking: number | null;     // Retailer/party secondary OB (NET)
  directDealersOrder: number | null; // Direct dealer OB — kept separate
  sale: number | null;             // YTD sales received
  // Derived — recomputed, never read from a sheet % cell
  achievementPct: number | null;   // sale / secondaryTarget
  // Cost
  ctcMonthly: number | null;       // Monthly CTC salary
  ctcAnnual: number | null;        // Annual CTC
  taBillStCost: number | null;     // T.A. Bill + Station cost
  costRatio: number | null;        // (ctcMonthly + taBill) / sale × 100
  // Retailer metrics
  totalOldRetailers: number | null;
  visitedRetailers: number | null;
  nonVisitedRetailers: number | null;
  newPartyOrderBooking: number | null;
  businessPerRetailer: number | null;
  totalRetailers: number | null;
  directDealersCount: number | null;
  // Extra fields read from header (catch-all for any additional columns)
  extra: Record<string, number | string | null>;
};

export type MemberRef = {
  stateHead: string;
  name: string;
  normKey: string;
};

export type DeepDiveDataResult = {
  fy: string;
  stateHeads: string[];              // All distinct state heads in the Data tab
  members: MemberRef[];              // All members (or filtered by stateHead)
  kpis: MemberKpis | null;          // null when member not specified or not found
  rowsRead: number;
  error: string | null;
};

// ── Column map ────────────────────────────────────────────────────────────────

type ColMap = {
  stateHead: number;
  teamMember: number;
  hq: number;
  designation: number;
  contact: number;
  primaryTarget: number;
  secondaryTarget: number;
  monthlyTarget: number;
  orderBooking: number;
  directDealersOrder: number;
  sale: number;
  ctcMonthly: number;
  ctcAnnual: number;
  taBillStCost: number;
  costRatio: number;
  totalOldRetailers: number;
  visitedRetailers: number;
  nonVisitedRetailers: number;
  newPartyOrderBooking: number;
  businessPerRetailer: number;
  totalRetailers: number;
  directDealersCount: number;
  // All header → column index (for extra fields)
  allHeaders: Map<string, number>;
  rawHeaders: string[];
};

function detectCols(headerRow: SheetCellValue[]): ColMap | null {
  const idx: Record<string, number> = {};
  const rawHeaders: string[] = [];

  headerRow.forEach((c, i) => {
    const raw = cellStr(c);
    rawHeaders.push(raw);
    const k = normHeader(c);
    if (k && !(k in idx)) idx[k] = i;
  });

  // FY-year-suffix strip: "Monthly CTC 2526" → also index as "MONTHLYCTTC".
  const FY_SUFFIX = /\d{4}$/;
  for (const [k, v] of Object.entries(idx)) {
    const stripped = k.replace(FY_SUFFIX, "");
    if (stripped && stripped !== k && !(stripped in idx)) {
      idx[stripped] = v;
    }
  }

  const find = (...keys: string[]): number => {
    for (const k of keys) if (k in idx) return idx[k];
    return -1;
  };

  const stateHead = find("STATEHEAD", "STATEHEADNAME", "STATE");
  const teamMember = find(
    "TEAMMEMBER", "TEAMMEMBERNAME", "MEMBERNAME", "NAME", "EMPLOYEENAME",
  );

  if (stateHead < 0 || teamMember < 0) return null;

  const allHeaders = new Map<string, number>();
  for (const [k, v] of Object.entries(idx)) allHeaders.set(k, v);

  return {
    stateHead,
    teamMember,
    hq:                 find("HQ", "HEADQUARTER", "HEADQUARTERS", "STATION"),
    designation:        find("DESIGNATION", "DESIGNATIONTYPE", "ROLE", "POSITION"),
    contact:            find("CONTACT", "CONTACTNUMBER", "MOBILE", "PHONE"),
    primaryTarget:      find("PRIMARYTARGET", "PRIMARYANNUALTARGET", "PRIMARYPLAN", "PRIMARYOBJECTIVE"),
    secondaryTarget:    find(
      "BUSINESSPLAN", "SECONDARYTARGET", "ANNUALBUSINESSPLAN",
      "ANNUALTARGET", "ANNUALPLAN", "TARGET",
    ),
    monthlyTarget:      find("MONTHLYTARGET", "MONTHLYSECONDARY", "MONTHLYPLAN"),
    orderBooking:       find(
      // STATE HEAD DASHBOARD 'Data' tab uses "Old Party Business Order Booking"
      // for the retailer/party NET secondary OB (Sub Total, not Order Total).
      "OLDPARTYBUSINESSORDERBOOKING", "OLDPARTYBUSINESS",
      "ORDERBOOKING", "ORDERBOOKED", "OB",
      "RETAILEROB", "PARTYOB", "NETOB",
    ),
    directDealersOrder: find(
      "DIRECTDEALERSORDER", "DIRECTDEALEROB", "DIRECTDEALERORDERBOOKING",
      "DEALERORDER", "DIRECTORDER",
    ),
    sale:               find(
      // The Data tab uses "Sale Report 26-27" / "Sale Report" for secondary YTD
      // sales received — prefer these over the plain "SALE" column which holds
      // a different aggregate unrelated to secondary performance.
      "SALEREPORT2627", "SALEREPORT2526", "SALEREPORT2425", "SALEREPORT",
      "SALESRECEIVED", "NETSALE", "YTDSALESRECEIVED",
      "SALESAMOUNT", "TOTALRECEIVED",
    ),
    ctcMonthly:         find("MONTHLYCTTC", "CTCMONTHLY", "MONTHLYCTC", "MONTHLYSALARY", "CTC"),
    ctcAnnual:          find("CTCANNUAL", "ANNUALCTC", "ANNUALSALARY"),
    taBillStCost:       find(
      "TABILLSTCOST", "TABILLCOST", "TACOST",
      "TABILSTCOST", "TABILL", "COSTBILL", "STATIONCOST",
    ),
    costRatio:          find("COSTRATIO", "COSTRATIO", "EXPENSEPCT", "COSTTOSALES"),
    totalOldRetailers:  find(
      "TOTALOLDRETAILERS", "OLDRETAILERS", "TOTALRETAILEROLD",
      "TOTALRETAILER", "RETAILERS",
    ),
    visitedRetailers:   find(
      // STATE HEAD DASHBOARD 'Data' tab uses "Visited In A Month".
      "VISITEDINAMONTH", "VISITED", "VISITEDRETAILERS", "VISITCOUNT", "VISITS",
    ),
    nonVisitedRetailers: find(
      "NONVISITED", "NOTVISITED", "UNVISITED", "NONVISITEDRETAILERS",
    ),
    newPartyOrderBooking: find(
      "NEWPARTYORDERBOOKING", "NEWPARTYOB", "NEWPARTYBOOKING",
      "NEWRETAILEROB", "NEWRETAILERORDERBOOKING",
    ),
    businessPerRetailer: find(
      "BUSINESSPERRETAILER", "SALEPERRETAILER", "PERRETAILER",
      "RETAILERAVG", "AVGBUSINESS",
    ),
    totalRetailers:     find("TOTALRETAILERS", "GRANDTOTALRETAILERS"),
    directDealersCount: find(
      "DIRECTDEALERS", "DIRECTDEALERCOUNT", "DEALERCOUNT", "DEALERS",
    ),
    allHeaders,
    rawHeaders,
  };
}

// ── Tab finder ────────────────────────────────────────────────────────────────

async function findDataTab(sheetId: string): Promise<string | null> {
  try {
    const tabs: SheetTab[] = await listSheetTabs(sheetId);
    // Exact match first, then case-insensitive prefix.
    const exact = tabs.find(
      (t) => t.title.trim().toLowerCase() === DATA_TAB_NAME.toLowerCase(),
    );
    if (exact) return exact.title;
    const prefix = tabs.find((t) =>
      t.title.trim().toUpperCase().startsWith(DATA_TAB_NAME.toUpperCase()),
    );
    return prefix?.title ?? null;
  } catch (err) {
    logger.warn({ err, sheetId }, "deepDiveData: listSheetTabs failed");
    return null;
  }
}

// ── In-process cache ──────────────────────────────────────────────────────────

type CacheEntry = {
  allMembers: MemberKpis[];
  rawHeaders: string[];
  rowsRead: number;
  loadedAt: number;
};

const TTL_MS = 15 * 60_000; // 15 minutes (same as stateDashboard)
const _cache = new Map<string, CacheEntry>();
const _inFlight = new Map<string, Promise<CacheEntry | null>>();

function clearExpired(): void {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now - v.loadedAt > TTL_MS) _cache.delete(k);
  }
}

export function invalidateDeepDiveCache(fy?: string): void {
  if (fy) _cache.delete(fy);
  else _cache.clear();
}

// ── Core loader ───────────────────────────────────────────────────────────────

async function loadAllMembersUncached(fy: string): Promise<CacheEntry | null> {
  const sheetId = SHEET_IDS[fy];
  if (!sheetId) {
    logger.warn({ fy }, "deepDiveData: no sheet configured for this FY");
    return null;
  }

  const tabName = await findDataTab(sheetId);
  if (!tabName) {
    logger.warn({ fy, sheetId }, "deepDiveData: 'Data' tab not found");
    return null;
  }

  let allRows: SheetCellValue[][];
  try {
    allRows = await readAllTabRows(sheetId, tabName);
  } catch (err) {
    logger.warn({ err, fy, sheetId, tabName }, "deepDiveData: failed to read Data tab");
    return null;
  }

  // Log first 5 rows (up to 12 columns each) to diagnose tab structure.
  const diagRows = allRows.slice(0, 5).map((r) =>
    (r ?? []).slice(0, 20).map((c) => cellStr(c)).filter(Boolean).join(" | "),
  );
  logger.info({ fy, tab: tabName, rows: allRows.length, diagRows }, "deepDiveData: raw rows read");

  // Find the header row: scan for a row containing STATEHEAD (or synonym)
  // and TEAMMEMBER (or synonym). Scan up to 50 rows in case of merged header
  // or section rows above the table.
  let headerIdx = -1;
  let cols: ColMap | null = null;

  // All recognised state-head header tokens (normHeader form).
  const STATE_HEAD_TOKENS = new Set([
    "STATEHEAD", "STATEHEADNAME", "STATEHEAD2627", "STATEHEAD2526",
    "STATEHEADS", "HEADNAME", "HEADOFSTATE",
  ]);
  // All recognised team-member header tokens.
  const TEAM_MEMBER_TOKENS = new Set([
    "TEAMMEMBER", "TEAMMEMBERNAME", "MEMBERNAME", "TMNAME", "EMPLOYEE",
    "EMPLOYEENAME", "NAME", "SALESREP", "SALESREPRESENTATIVE",
  ]);

  for (let i = 0; i < Math.min(allRows.length, 50); i++) {
    const row = allRows[i] ?? [];
    const normHeaders = row.map((c) => normHeader(c));
    const hasStateHead = normHeaders.some((h) => STATE_HEAD_TOKENS.has(h));
    const hasTeamMember = normHeaders.some((h) => TEAM_MEMBER_TOKENS.has(h));
    if (hasStateHead && hasTeamMember) {
      const detected = detectCols(row);
      if (detected) {
        headerIdx = i;
        cols = detected;
        break;
      }
    }
  }

  if (headerIdx < 0 || !cols) {
    // Log all distinct normalised headers from the first 50 rows for debugging.
    const allHeaders = new Set<string>();
    for (let i = 0; i < Math.min(allRows.length, 50); i++) {
      for (const c of allRows[i] ?? []) {
        const h = normHeader(c);
        if (h && h.length > 1) allHeaders.add(h);
      }
    }
    logger.warn(
      { fy, tab: tabName, distinctHeaders: [...allHeaders].slice(0, 60) },
      "deepDiveData: header row not detected in first 50 rows",
    );
    return null;
  }

  // Data rows start immediately after the header row.
  // The spec says "Header is row 3; each member is one row." — so data starts at row 4.
  const dataStart = headerIdx + 1;

  const members: MemberKpis[] = [];
  let currentStateHead = "";

  // Identify extra columns (anything not in the named column set).
  const namedCols = new Set<number>([
    cols.stateHead, cols.teamMember, cols.hq, cols.designation, cols.contact,
    cols.primaryTarget, cols.secondaryTarget, cols.monthlyTarget,
    cols.orderBooking, cols.directDealersOrder, cols.sale,
    cols.ctcMonthly, cols.ctcAnnual, cols.taBillStCost, cols.costRatio,
    cols.totalOldRetailers, cols.visitedRetailers, cols.nonVisitedRetailers,
    cols.newPartyOrderBooking, cols.businessPerRetailer,
    cols.totalRetailers, cols.directDealersCount,
  ].filter((n) => n >= 0));

  for (let i = dataStart; i < allRows.length; i++) {
    const row = allRows[i] ?? [];

    // Fill-down state head (column is vertically merged in the sheet).
    const rawHead = cellStr(row[cols.stateHead]);
    if (rawHead) currentStateHead = rawHead;

    const rawName = cellStr(row[cols.teamMember]);
    if (!rawName) continue;

    // Skip section headers / total rows.
    const upper = rawName.toUpperCase();
    if (
      upper === "TOTAL" ||
      upper === "GRAND TOTAL" ||
      upper.startsWith("TOTAL ") ||
      upper.includes("TEAM MEMBER") ||
      upper.includes("STATEHEAD") ||
      /^\d+$/.test(rawName)   // row index
    ) continue;

    const normKey = normSecKey(rawName);
    if (!normKey) continue;

    // Collect extra fields (all header-detected columns not in namedCols).
    const extra: Record<string, number | string | null> = {};
    for (const [hdr, ci] of cols.allHeaders) {
      if (namedCols.has(ci)) continue;
      const v = row[ci];
      if (v == null || v === "") continue;
      const n = cellNum(v);
      extra[hdr] = n !== null ? n : cellStr(v) || null;
    }

    const sale = cols.sale >= 0 ? cellNum(row[cols.sale]) : null;
    const secondaryTarget =
      cols.secondaryTarget >= 0 ? cellNum(row[cols.secondaryTarget]) : null;

    // Recompute achievement — never read from a sheet % cell.
    const achievementPct =
      sale !== null && secondaryTarget !== null && secondaryTarget > 0
        ? (sale / secondaryTarget) * 100
        : null;

    members.push({
      stateHead: currentStateHead,
      name: rawName,
      normKey,
      hq:                  cols.hq >= 0 ? cellStr(row[cols.hq]) || null : null,
      designation:         cols.designation >= 0 ? cellStr(row[cols.designation]) || null : null,
      contact:             cols.contact >= 0 ? cellStr(row[cols.contact]) || null : null,
      primaryTarget:       cols.primaryTarget >= 0 ? cellNum(row[cols.primaryTarget]) : null,
      secondaryTarget,
      monthlyTarget:       cols.monthlyTarget >= 0 ? cellNum(row[cols.monthlyTarget]) : null,
      orderBooking:        cols.orderBooking >= 0 ? cellNum(row[cols.orderBooking]) : null,
      directDealersOrder:  cols.directDealersOrder >= 0 ? cellNum(row[cols.directDealersOrder]) : null,
      sale,
      achievementPct,
      ctcMonthly:          cols.ctcMonthly >= 0 ? cellNum(row[cols.ctcMonthly]) : null,
      ctcAnnual:           cols.ctcAnnual >= 0 ? cellNum(row[cols.ctcAnnual]) : null,
      taBillStCost:        cols.taBillStCost >= 0 ? cellNum(row[cols.taBillStCost]) : null,
      costRatio:           cols.costRatio >= 0 ? cellNum(row[cols.costRatio]) : null,
      totalOldRetailers:   cols.totalOldRetailers >= 0 ? cellNum(row[cols.totalOldRetailers]) : null,
      visitedRetailers:    cols.visitedRetailers >= 0 ? cellNum(row[cols.visitedRetailers]) : null,
      nonVisitedRetailers: cols.nonVisitedRetailers >= 0 ? cellNum(row[cols.nonVisitedRetailers]) : null,
      newPartyOrderBooking: cols.newPartyOrderBooking >= 0 ? cellNum(row[cols.newPartyOrderBooking]) : null,
      businessPerRetailer:  cols.businessPerRetailer >= 0 ? cellNum(row[cols.businessPerRetailer]) : null,
      totalRetailers:       cols.totalRetailers >= 0 ? cellNum(row[cols.totalRetailers]) : null,
      directDealersCount:   cols.directDealersCount >= 0 ? cellNum(row[cols.directDealersCount]) : null,
      extra,
    });
  }

  logger.info(
    { fy, tab: tabName, members: members.length, headerRow: headerIdx },
    "deepDiveData: parsed",
  );

  return {
    allMembers: members,
    rawHeaders: cols.rawHeaders,
    rowsRead: allRows.length,
    loadedAt: Date.now(),
  };
}

async function loadAllMembers(fy: string): Promise<CacheEntry | null> {
  clearExpired();
  const hit = _cache.get(fy);
  if (hit) return hit;

  const pending = _inFlight.get(fy);
  if (pending) return pending;

  const p = loadAllMembersUncached(fy).then((entry) => {
    if (entry) _cache.set(fy, entry);
    return entry;
  }).finally(() => _inFlight.delete(fy));

  _inFlight.set(fy, p);
  return p;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadDeepDiveData(
  fy: string,
  selectedStateHead?: string,
  selectedMemberKey?: string,
): Promise<DeepDiveDataResult> {
  const entry = await loadAllMembers(fy);

  if (!entry) {
    return {
      fy,
      stateHeads: [],
      members: [],
      kpis: null,
      rowsRead: 0,
      error: `Could not load the 'Data' tab for FY ${fy}. The sheet may not be connected or the tab name may differ.`,
    };
  }

  // Distinct state heads in order of first appearance.
  const headsSet = new Set<string>();
  for (const m of entry.allMembers) {
    if (m.stateHead) headsSet.add(m.stateHead);
  }
  const stateHeads = [...headsSet];

  // Members under the selected state head (or all members if no head selected).
  const filtered = selectedStateHead
    ? entry.allMembers.filter((m) => m.stateHead === selectedStateHead)
    : entry.allMembers;

  const members: MemberRef[] = filtered.map((m) => ({
    stateHead: m.stateHead,
    name: m.name,
    normKey: m.normKey,
  }));

  // Find the selected member by normSecKey.
  let kpis: MemberKpis | null = null;
  if (selectedMemberKey) {
    kpis = filtered.find((m) => m.normKey === selectedMemberKey) ?? null;
    if (!kpis) {
      // Fallback: search the full list (head filter may be wrong).
      kpis = entry.allMembers.find((m) => m.normKey === selectedMemberKey) ?? null;
    }
    if (kpis) {
      // Log the parsed row for proof (per rule 12: never trust a self-report of success).
      logger.info(
        { fy, member: kpis.name, stateHead: kpis.stateHead, kpis },
        "deepDiveData: member row parsed — verify against acceptance criteria",
      );
    }
  }

  return {
    fy,
    stateHeads,
    members,
    kpis,
    rowsRead: entry.rowsRead,
    error: null,
  };
}
