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

import { db, deepDiveSnapshots } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../logger.js";
import {
  readAllTabRows,
  readTabRowsViaExport,
  listSheetTabs,
  type SheetCellValue,
  type SheetTab,
} from "../registers/sheetsApi.js";
import {
  loadMemberSheet,
  type MemberSheetData,
} from "./memberSheet.js";
import { computeRoiCost, type RoiCost } from "./roiCost.js";
import { computeSkuSpread, type SkuSpread } from "./skuSpread.js";
import { computeWinBack, type WinBackItem } from "./winBack.js";
import { IdentityRegistry } from "./identityRegistry.js";
import { getCachedStateDashboard } from "./stateDashboard.js";

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

// Import from names.ts (single authoritative definition) and re-export so
// all callers keep their existing `import { normSecKey } from "...deepDiveData.js"`.
import { normSecKey } from "./names.js";
export { normSecKey };

// ── Cell helpers ──────────────────────────────────────────────────────────────

function cellStr(v: SheetCellValue): string {
  return String(v ?? "").trim();
}

function cellNum(v: SheetCellValue): number | null {
  if (v == null || v === "") return null;
  // When rows come from the CSV export path, numeric values arrive as strings.
  if (typeof v === "number") return v;
  const s = String(v).trim();
  // Percentage cells (e.g. "67.76%") — divide by 100 to restore the decimal.
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1).replace(/[,\s₹]/g, ""));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s.replace(/[,\s₹]/g, ""));
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
  // Targets — from State Head Dashboard Data tab
  //   G  = primaryTarget      : primary YTD target to date
  //   H  = secondaryTarget    : secondary YTD target to date ("Target" column)
  //   BE = monthlyTarget      : total monthly target (secondary + primary)
  //   BK = primaryTargetMonthly: primary monthly target (direct dealer)
  //   BM = totalTargetToDate  : total YTD target to date
  primaryTarget: number | null;          // G: primary target to date
  secondaryTarget: number | null;        // H: secondary target to date
  monthlyTarget: number | null;          // BE: total monthly target
  // Phase 7 targets
  primaryTargetMonthly: number | null;   // BK: primary (direct dealer) monthly target
  secondaryTargetMonthly: number | null; // Derived: monthlyTarget - primaryTargetMonthly
  totalTargetToDate: number | null;      // BM: total target to date
  elapsedMonths: number | null;          // BD when available (authoritative), else derived from BM÷BE
  elapsedMonthsFromSheet: number | null; // BD: read directly from the sheet; null when column absent
  isLeft: boolean;                       // BA "Active/ Left" column: true when member has left the team
  // Performance (YTD from Data tab — NET = Sub Total)
  orderBooking: number | null;           // Retailer/party secondary OB (NET)
  directDealersOrder: number | null;     // Direct dealer OB — kept separate
  sale: number | null;                   // YTD sales received
  // Derived achievement ratios — recomputed, never read from a sheet % cell
  achievementPct: number | null;         // = achievementSale (kept for backward compat)
  achievementSecondary: number | null;   // orderBooking / secondaryTarget
  achievementDirectDealer: number | null; // directDealersOrder / primaryTarget
  achievementTotal: number | null;       // (OB + DD) / totalTargetToDate
  achievementSale: number | null;        // sale / totalTargetToDate
  // Prior year quarterly actuals (BO–BR)
  lastYearQ1: number | null;
  lastYearQ2: number | null;
  lastYearQ3: number | null;
  lastYearQ4: number | null;
  // Cost
  ctcMonthly: number | null;             // Monthly CTC salary
  ctcAnnual: number | null;              // Annual CTC
  taBillStCost: number | null;           // T.A. Bill + Station cost
  costRatio: number | null;              // (ctcMonthly + taBill) / sale × 100
  workingDaysActual: number | null;      // AG: Actual working days this period (member-specific)
  // Retailer metrics
  totalOldRetailers: number | null;
  visitedRetailers: number | null;
  nonVisitedRetailers: number | null;
  newPartyOrderBooking: number | null;
  businessPerRetailer: number | null;
  totalRetailers: number | null;
  directDealersCount: number | null;
  // AF: Total all-type YTD visits (retailer + distributor + DD + leads) — dashboard col AF.
  // Distinct from visitedRetailers (unique retailers visited in a month) and from
  // the working-sheet retailer-visits-only figure (sheet.visits.done).
  totalVisitsYtd: number | null;
  // Extra fields read from header (catch-all for any additional columns)
  extra: Record<string, number | string | null>;
};

export type MemberRef = {
  stateHead: string;
  name: string;
  normKey: string;
  /** State derived from extra.STATE (preferred) or extra.WORKINGSTATE.  Used by
   *  distributorDeepDive.ts for per-state aggregation. */
  state: string;
  /** Pre-computed from Data tab — passed to distributorDeepDive for correlation. */
  achievementTotal: number | null;
  isLeft: boolean;
  /** Data-tab directDealersOrder — for DD OB reconciliation in distributorDeepDive. */
  directDealerOb: number;
};

// ── Team-summary types (SD1: Sandeep Dadheech onboarding) ────────────────────
// Computed whenever a state head is selected.  Headline includes all active
// members (zero-target contribute OB but no target denominator).  Like-for-like
// is restricted to active members who have a positive target.

export type StateBreakdownRow = {
  state: string;
  memberCount: number;
  membersWithTarget: number;
  targetTotal: number;
  obTotal: number;
  saleTotal: number;
  visitTotal: number;
  /** obTotal / targetTotal (all active members in state; null when targetTotal = 0) */
  headlinePct: number | null;
  /** obTotal(members-with-target) / targetTotal(members-with-target) */
  likeForLikePct: number | null;
  zeroTargetCount: number;
  zeroTargetOb: number;
};

export type TeamSummary = {
  totalMembers: number;
  activeMembers: number;
  leftMembers: number;
  zeroTargetActiveCount: number;
  zeroTargetActiveOb: number;
  zeroTargetActiveNames: string[];
  totalTarget: number;
  /** old-party OB + new-party OB + direct-dealer OB — matches Data-tab "Sub Total" concept */
  totalOB: number;
  totalSale: number;
  totalVisits: number;
  totalRetailers: number;
  /** subset of totalOB from the direct-dealer channel — shown as a breakdown tile */
  directDealerOB: number;
  /** totalOB(all-active) / totalTarget — includes zero-target members' OB */
  headlineAchievementPct: number | null;
  /** totalOB(with-target) / totalTarget(with-target) — excludes zero-target members entirely */
  likeForLikeAchievementPct: number | null;
  byState: StateBreakdownRow[];
};

export type DeepDiveDataResult = {
  fy: string;
  stateHeads: string[];              // All distinct state heads in the Data tab
  members: MemberRef[];              // All members (or filtered by stateHead)
  kpis: MemberKpis | null;          // null when member not specified or not found
  teamSummary: TeamSummary | null;   // Aggregate over all members under the selected state head
  retailerDetail: MemberSheetData | null; // Phase 2: retailer-level detail from member's own sheet
  roiCost: RoiCost | null;          // Phase 4: revenue-to-cost analysis (needs kpis + spread)
  skuSpread: SkuSpread | null;      // Phase 5: segment/SKU spread from secondary_register_line
  winBack: WinBackItem[] | null;    // Phase 6: dormant retailers from past-FY register vs current sheet
  rowsRead: number;
  /** Unix ms timestamp when the Data tab was last read from Google Sheets (or loaded from DB snapshot). */
  dataReadAt: number;
  error: string | null;
  fromDbSnapshot?: boolean;         // Phase 6: true when Data-tab content served from DB (no Sheets read)
  /** True when the live Sheets read failed transiently and the last saved DB
   *  snapshot was served instead — figures may be slightly out of date. */
  stale?: boolean;
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
  totalVisitsYtd: number;        // AF: Total all-type YTD visits (retailer + distributor + DD + leads)
  // Phase 7: new target / comparison columns
  primaryTargetMonthly: number;  // BK: Monthly Direct Dealer Primary Target
  totalTargetToDate: number;     // BM: Total target to date
  workingDaysAg: number;         // AG: Working days in month
  lastYearQ1: number;            // BO: Prior year Q1 actual
  lastYearQ2: number;            // BP: Prior year Q2 actual
  lastYearQ3: number;            // BQ: Prior year Q3 actual
  lastYearQ4: number;            // BR: Prior year Q4 actual
  // BA/BD: member status and authoritative elapsed months
  activeLeftBd: number;          // BA: "Active/ Left" status column
  elapsedMonthsBd: number;       // BD (= BA+3): elapsed months — headed with a month name but holds a pro-rata NUMBER
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

  const colMap: ColMap = {
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
    monthlyTarget:      find(
      "MONTHLYTARGET", "TARGETMONTHLY",    // "Monthly Target" OR "Target monthly" (BE header varies)
      "MONTHLYSECONDARY", "MONTHLYPLAN",
    ),
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
    // AF: Total visits YTD across all visit types (retailer + distributor + DD + leads).
    // Lives in the State Head Dashboard Data tab as "Total Visits".
    totalVisitsYtd:     find("TOTALVISITS", "YTDVISITS", "TOTALVISITSYTD"),
    directDealersCount: find(
      "DIRECTDEALERS", "DIRECTDEALERCOUNT", "DEALERCOUNT", "DEALERS",
    ),
    // Phase 7: new target / comparison columns
    primaryTargetMonthly: find(
      "MONTHLYDIRECTDEALERPRIMARYTARGET", "DIRECTDEALERMONTHLYTARGET",
      "PRIMARYMONTHLYTARGET", "MONTHLYPRIMARYTARGET", "MONTHLYDIRECTDEALER",
      "MDDPRIMARYTARGET", "PRIMARYTARGETMONTHLY",
    ),
    totalTargetToDate: find(
      "TOTALTARGET", "TOTALTARGETTODATE", "TOTALTAR",
      "GRANDTARGET", "COMBINEDTARGET",
    ),
    workingDaysAg: find(
      "WORKINGDAYS", "WORKDAYS", "WORKDAY", "NOOFWORKINGDAYS",
      "WORKINGDAYSCOUNT",
    ),
    lastYearQ1: find(
      "Q1LASTYEAR", "Q1LY", "Q1PREVYEAR", "LASTYRQ1", "PREVIOUSQ1",
      "LYQUARTER1", "Q1PREVIOUSYEAR",
    ),
    lastYearQ2: find(
      "Q2LASTYEAR", "Q2LY", "Q2PREVYEAR", "LASTYRQ2", "PREVIOUSQ2",
      "LYQUARTER2", "Q2PREVIOUSYEAR",
    ),
    lastYearQ3: find(
      "Q3LASTYEAR", "Q3LY", "Q3PREVYEAR", "LASTYRQ3", "PREVIOUSQ3",
      "LYQUARTER3", "Q3PREVIOUSYEAR",
    ),
    lastYearQ4: find(
      "Q4LASTYEAR", "Q4LY", "Q4PREVYEAR", "LASTYRQ4", "PREVIOUSQ4",
      "LYQUARTER4", "Q4PREVIOUSYEAR",
    ),
    // Initialized to -1; overridden below after the BA ("Active/ Left") header is located.
    activeLeftBd:    -1,
    elapsedMonthsBd: -1,
    allHeaders,
    rawHeaders,
  };

  // BA: "Active/ Left" — detectable by header.
  // BD: headed with a month name ("Jun") but holds a pro-rata NUMBER (3.00 full tenure,
  // fractional for partial tenure). Locate positionally as BA+3 because the header is
  // ambiguous. Must be computed before the return so it is included in the literal.
  const detectedActiveLeft = find("ACTIVELEFT", "ACTIVEORLEFT", "LEFTACTIVE", "ACTIVE/LEFT", "ACTIVESTATUS");
  colMap.activeLeftBd = detectedActiveLeft;
  colMap.elapsedMonthsBd = detectedActiveLeft >= 0 ? detectedActiveLeft + 3 : -1;
  return colMap;
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

// ── FY helpers (mirrors stateDashboard.ts) ────────────────────────────────────

function fyStartYear(fy: string): number {
  return parseInt(fy.split("-")[0], 10);
}

function currentFy(): string {
  const now = new Date();
  const yr = now.getUTCFullYear();
  const mo = now.getUTCMonth(); // 0=Jan
  const fyStart = mo >= 3 ? yr : yr - 1;
  return `${fyStart}-${String(fyStart + 1).slice(-2)}`;
}

function isClosedFy(fy: string): boolean {
  return fyStartYear(fy) < fyStartYear(currentFy());
}

/** "2026-27" → "2025-26"; null if fy is malformed. */
export function priorFyOf(fy: string): string | null {
  const startY = fyStartYear(fy);
  if (isNaN(startY)) return null;
  const py = startY - 1;
  return `${py}-${String(startY).slice(2)}`;
}

// ── Prior-year quarter resolution ─────────────────────────────────────────────
//
// Prior-year quarterly OB for one member. Primary source: the Data tab's
// explicit last-year columns (lastYearQ1–Q4, e.g. "Q1 Last Year"). Some FYs
// (FY2026-27) label them plainly "Q1".."Q4" instead — those are not matched by
// the named-column detector and land in kpis.extra. Plain Q1–Q4 is ambiguous
// (could be the current FY's own quarters), so the fallback is only trusted
// when the four quarters cross-foot against the prior-FY TOTALORDER column
// (e.g. TOTALORDER2526 for prior FY 2025-26) within 1%.
export function resolvePriorYearQuarters(
  kpis: Pick<MemberKpis, "lastYearQ1" | "lastYearQ2" | "lastYearQ3" | "lastYearQ4"> & {
    extra?: Record<string, unknown>;
  },
  fyPrior: string | null,
): (number | null)[] | null {
  const explicit = [kpis.lastYearQ1, kpis.lastYearQ2, kpis.lastYearQ3, kpis.lastYearQ4];
  if (explicit.some((q) => q != null)) return explicit;
  if (!fyPrior) return null;

  const ex = kpis.extra ?? {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const qs = [num(ex["Q1"]), num(ex["Q2"]), num(ex["Q3"]), num(ex["Q4"])];
  if (qs.every((q) => q == null)) return null;

  // "2025-26" → "2526"
  const [a, b] = fyPrior.split("-");
  const suffix = a && b ? `${a.slice(2)}${b}` : null;
  const total = suffix ? num(ex[`TOTALORDER${suffix}`]) : null;
  if (total == null || total <= 0) return null;
  const sum = qs.reduce<number>((s, q) => s + (q ?? 0), 0);
  if (Math.abs(sum - total) > 0.01 * total) return null;
  return qs;
}

/** Populate lastYearQ1–Q4 in place from the plain Q1–Q4 fallback when the
 *  explicit columns are absent. Idempotent (explicit values win). */
function applyPriorYearQuarterFallback(member: MemberKpis, fy: string): void {
  const explicit = [member.lastYearQ1, member.lastYearQ2, member.lastYearQ3, member.lastYearQ4];
  if (explicit.some((q) => q != null)) return;
  const qs = resolvePriorYearQuarters(member, priorFyOf(fy));
  if (!qs) return;
  member.lastYearQ1 = qs[0];
  member.lastYearQ2 = qs[1];
  member.lastYearQ3 = qs[2];
  member.lastYearQ4 = qs[3];
}

// ── DB snapshot: persist and restore the Data-tab parse result ────────────────
//
// Closed FYs are served from the DB snapshot on cold start — Sheets is never
// re-read once a snapshot exists.  Live FY snapshots are also persisted for
// resilience but are NOT used to bypass Sheets on restart (TTL still applies).

type SnapData = {
  allMembers: MemberKpis[];
  rawHeaders: string[];
  rowsRead: number;
};

async function saveDeepDiveSnapshot(fy: string, entry: CacheEntry): Promise<void> {
  try {
    const data: SnapData = {
      allMembers: entry.allMembers,
      rawHeaders: entry.rawHeaders,
      rowsRead: entry.rowsRead,
    };
    await db.insert(deepDiveSnapshots).values({ fy, data });
    logger.info({ fy }, "deepDiveData: DB snapshot saved");
  } catch (err) {
    logger.warn({ err, fy }, "deepDiveData: DB snapshot save failed (non-fatal)");
  }
}

async function loadDeepDiveFromDb(fy: string): Promise<CacheEntry | null> {
  try {
    const rows = await db
      .select()
      .from(deepDiveSnapshots)
      .where(eq(deepDiveSnapshots.fy, fy))
      .orderBy(desc(deepDiveSnapshots.savedAt))
      .limit(1);
    if (rows.length === 0) return null;
    const snap = rows[0].data as SnapData;
    // Snapshots persisted before the plain Q1–Q4 fallback existed carry null
    // lastYearQ1–Q4 with the raw quarters still in extra — resolve on load.
    for (const m of snap.allMembers) applyPriorYearQuarterFallback(m, fy);
    return {
      allMembers: snap.allMembers,
      rawHeaders: snap.rawHeaders,
      rowsRead: snap.rowsRead,
      loadedAt: Date.now(),
    };
  } catch (err) {
    logger.warn({ err, fy }, "deepDiveData: DB snapshot load failed, falling back to Sheets");
    return null;
  }
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

  // ── Fresh sale values from the SOBR tab ──────────────────────────────────
  // Data tab column AY is populated by:
  //   =ArrayFormula(iferror(VLOOKUP($C$4:$C, 'SECONDARY ORDER BOOKING REPORT...'!C:O, 13, 0)))
  //
  // ArrayFormula SPILL CELLS use a server-side computed cache.  When the state
  // head updates a member's ytdSalesReceived in the SOBR tab, the ArrayFormula
  // spill cells in the Data tab go stale — both values.get AND the Drive CSV
  // export return the cached (old) value.  Only opening the file in a browser
  // triggers a full recompute.
  //
  // Fix: read SOBR!C:O directly (col C = member name, col O = ytdSalesReceived).
  // These cells are either plain numbers or within-tab SUM formulas — always
  // fresh via the Sheets API.  We reproduce the VLOOKUP ourselves so kpis.sale
  // always reflects the current SOBR state regardless of the spill cache.
  //
  // SOBR col indices (0-based from col A):  C = 2, O = 14
  const sobrSaleMap = new Map<string, number>();
  try {
    const SOBR_PREFIX = "SECONDARY ORDER BOOKING REPORT";
    const allTabs = await listSheetTabs(sheetId);
    const sobrTabName = allTabs.find((t) =>
      t.title.trim().toUpperCase().startsWith(SOBR_PREFIX),
    )?.title ?? null;
    if (sobrTabName) {
      const sobrRows = await readAllTabRows(sheetId, sobrTabName);
      for (const sobrRow of sobrRows) {
        const name = String(sobrRow[2] ?? "").trim();         // col C = member name
        const saleVal = typeof sobrRow[14] === "number"
          ? sobrRow[14]
          : (sobrRow[14] != null && sobrRow[14] !== ""
              ? Number(String(sobrRow[14]).replace(/[,\s₹]/g, ""))
              : NaN);
        if (name && Number.isFinite(saleVal)) {
          sobrSaleMap.set(name.toLowerCase(), saleVal);
        }
      }
      logger.info(
        { fy, sobrTabName, entries: sobrSaleMap.size },
        "deepDiveData: SOBR sale map built",
      );
    } else {
      logger.warn({ fy, sheetId }, "deepDiveData: SOBR tab not found — sale values from Data tab only");
    }
  } catch (err) {
    logger.warn({ err, fy }, "deepDiveData: SOBR sale read failed — sale values from Data tab only");
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
        logger.info(
          {
            fy,
            headerRow: i,
            saleColIdx: detected.sale,
            saleColHeader: detected.rawHeaders[detected.sale] ?? "(none)",
            orderBookingColIdx: detected.orderBooking,
            orderBookingColHeader: detected.rawHeaders[detected.orderBooking] ?? "(none)",
            totalCols: detected.rawHeaders.length,
          },
          "deepDiveData: column detection result",
        );
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
    // Phase 7
    cols.primaryTargetMonthly, cols.totalTargetToDate, cols.workingDaysAg,
    cols.lastYearQ1, cols.lastYearQ2, cols.lastYearQ3, cols.lastYearQ4,
    // BA/BD
    cols.activeLeftBd, cols.elapsedMonthsBd,
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

    // Prefer the fresh SOBR value (avoids stale ArrayFormula spill cache).
    const dataSale = cols.sale >= 0 ? cellNum(row[cols.sale]) : null;
    const sobrSale = sobrSaleMap.get(rawName.trim().toLowerCase()) ?? null;
    const sale = sobrSale ?? dataSale;
    if (sobrSale !== null && dataSale !== null && sobrSale !== dataSale) {
      logger.debug(
        { name: rawName, sobrSale, dataSale },
        "deepDiveData: sale patched from SOBR (Data tab spill was stale)",
      );
    }
    const secondaryTarget =
      cols.secondaryTarget >= 0 ? cellNum(row[cols.secondaryTarget]) : null;
    const primaryTarget =
      cols.primaryTarget >= 0 ? cellNum(row[cols.primaryTarget]) : null;
    const orderBooking =
      cols.orderBooking >= 0 ? cellNum(row[cols.orderBooking]) : null;
    const newPartyOrderBooking =
      cols.newPartyOrderBooking >= 0 ? cellNum(row[cols.newPartyOrderBooking]) : null;
    const directDealersOrder =
      cols.directDealersOrder >= 0 ? cellNum(row[cols.directDealersOrder]) : null;
    const monthlyTarget =
      cols.monthlyTarget >= 0 ? cellNum(row[cols.monthlyTarget]) : null;
    const primaryTargetMonthly =
      cols.primaryTargetMonthly >= 0 ? cellNum(row[cols.primaryTargetMonthly]) : null;
    const totalTargetToDate =
      cols.totalTargetToDate >= 0 ? cellNum(row[cols.totalTargetToDate]) : null;

    // Derived secondary monthly target.
    const secondaryTargetMonthly =
      monthlyTarget !== null && primaryTargetMonthly !== null
        ? monthlyTarget - primaryTargetMonthly
        : null;

    // BA: member status — "Active" or "LEFT".
    const isLeft = cols.activeLeftBd >= 0
      ? cellStr(row[cols.activeLeftBd]).toUpperCase().includes("LEFT")
      : false;

    // BD: elapsed months written in the sheet (headed with a month name but holds a
    // pro-rata NUMBER: 3.00 for full tenure, fractional for partial tenure e.g. 0.47).
    // This is the authoritative value — the targets are already built on it.
    const elapsedMonthsFromSheet =
      cols.elapsedMonthsBd >= 0 ? cellNum(row[cols.elapsedMonthsBd]) : null;

    // Derived elapsed months: BM / BE — kept for self-check and as fallback when BD absent.
    const elapsedMonthsDerived =
      totalTargetToDate !== null && monthlyTarget !== null && monthlyTarget > 0
        ? Math.round(totalTargetToDate / monthlyTarget)
        : null;

    // Authoritative elapsed months: BD (sheet) first, then derived.
    const elapsedMonths = elapsedMonthsFromSheet ?? elapsedMonthsDerived;

    // Self-check identity constraints using the derived (integer) value so the
    // check remains valid regardless of what BD holds (BD may be fractional).
    if (elapsedMonthsDerived !== null && elapsedMonthsDerived > 0) {
      if (totalTargetToDate !== null && monthlyTarget !== null) {
        const expectBm = monthlyTarget * elapsedMonthsDerived;
        if (Math.abs(totalTargetToDate - expectBm) > 100) {
          logger.warn(
            { name: rawName, expectBm, totalTargetToDate, elapsedMonthsDerived },
            "deepDiveData: identity check BE×elapsed≠BM",
          );
        }
      }
      if (primaryTarget !== null && primaryTargetMonthly !== null) {
        const expectG = primaryTargetMonthly * elapsedMonthsDerived;
        if (Math.abs(primaryTarget - expectG) > 100) {
          logger.warn(
            { name: rawName, expectG, primaryTarget, elapsedMonthsDerived },
            "deepDiveData: identity check BK×elapsed≠G",
          );
        }
      }
      if (secondaryTarget !== null && secondaryTargetMonthly !== null) {
        const expectH = secondaryTargetMonthly * elapsedMonthsDerived;
        if (Math.abs(secondaryTarget - expectH) > 100) {
          logger.warn(
            { name: rawName, expectH, secondaryTarget, elapsedMonthsDerived },
            "deepDiveData: identity check (BE-BK)×elapsed≠H",
          );
        }
      }
    }

    // Recompute 4 achievement ratios — never read from a sheet % cell.
    const achievementSecondary =
      orderBooking !== null && secondaryTarget !== null && secondaryTarget > 0
        ? (orderBooking / secondaryTarget) * 100
        : null;
    const achievementDirectDealer =
      directDealersOrder !== null && primaryTarget !== null && primaryTarget > 0
        ? (directDealersOrder / primaryTarget) * 100
        : null;
    // achievementTotal = (old-party OB + new-party OB + DD OB) / total target.
    // Consistent with aiPayload.ts totalOBPct and the dashboard TARGETACHIEVEMENT column.
    // (Earlier formula used old-party + DD but omitted new-party, understating for members
    // who carry new-party bookings.)
    const achievementTotal =
      (orderBooking !== null || newPartyOrderBooking !== null || directDealersOrder !== null) &&
      totalTargetToDate !== null && totalTargetToDate > 0
        ? ((orderBooking ?? 0) + (newPartyOrderBooking ?? 0) + (directDealersOrder ?? 0)) / totalTargetToDate * 100
        : null;

    // ── Assertion: recomputed achievement must match dashboard column AO ─────────
    // TARGETACHIEVEMENT is stored as a 0–1 ratio in the Data tab (normHeader strips
    // spaces → "TARGETACHIEVEMENT").  Tolerance 0.05 pp covers float serialisation.
    // A mismatch means either the formula is wrong or a new OB channel was added to
    // the dashboard without being reflected here.
    {
      const dashboardRatio = typeof extra["TARGETACHIEVEMENT"] === "number"
        ? (extra["TARGETACHIEVEMENT"] as number) : null;
      if (achievementTotal !== null && dashboardRatio !== null) {
        const dashboardPct = dashboardRatio * 100;
        if (Math.abs(achievementTotal - dashboardPct) > 0.05) {
          logger.warn(
            {
              name: rawName,
              stateHead: currentStateHead,
              computed: +achievementTotal.toFixed(4),
              dashboard: +dashboardPct.toFixed(4),
              deltaPp: +(achievementTotal - dashboardPct).toFixed(4),
              orderBooking,
              newPartyOrderBooking,
              directDealersOrder,
              totalTargetToDate,
            },
            "deepDiveData: achievementTotal mismatch vs dashboard TARGETACHIEVEMENT (AO)",
          );
        }
      }
    }

    const achievementSale =
      sale !== null && totalTargetToDate !== null && totalTargetToDate > 0
        ? (sale / totalTargetToDate) * 100
        : null;
    // Backward-compat: achievementPct = achievementSale (replaces the old
    // blended sale/secondaryTarget ratio that mislabelled populations).
    const achievementPct = achievementSale;

    members.push({
      stateHead: currentStateHead,
      name: rawName,
      normKey,
      hq:                  cols.hq >= 0 ? cellStr(row[cols.hq]) || null : null,
      designation:         cols.designation >= 0 ? cellStr(row[cols.designation]) || null : null,
      contact:             cols.contact >= 0 ? cellStr(row[cols.contact]) || null : null,
      primaryTarget,
      secondaryTarget,
      monthlyTarget,
      primaryTargetMonthly,
      secondaryTargetMonthly,
      totalTargetToDate,
      elapsedMonths,
      elapsedMonthsFromSheet,
      isLeft,
      orderBooking,
      directDealersOrder,
      sale,
      achievementPct,
      achievementSecondary,
      achievementDirectDealer,
      achievementTotal,
      achievementSale,
      lastYearQ1: cols.lastYearQ1 >= 0 ? cellNum(row[cols.lastYearQ1]) : null,
      lastYearQ2: cols.lastYearQ2 >= 0 ? cellNum(row[cols.lastYearQ2]) : null,
      lastYearQ3: cols.lastYearQ3 >= 0 ? cellNum(row[cols.lastYearQ3]) : null,
      lastYearQ4: cols.lastYearQ4 >= 0 ? cellNum(row[cols.lastYearQ4]) : null,
      ctcMonthly:          cols.ctcMonthly >= 0 ? cellNum(row[cols.ctcMonthly]) : null,
      ctcAnnual:           cols.ctcAnnual >= 0 ? cellNum(row[cols.ctcAnnual]) : null,
      taBillStCost:        cols.taBillStCost >= 0 ? cellNum(row[cols.taBillStCost]) : null,
      costRatio:           cols.costRatio >= 0 ? cellNum(row[cols.costRatio]) : null,
      workingDaysActual:   cols.workingDaysAg >= 0 ? cellNum(row[cols.workingDaysAg]) : null,
      totalOldRetailers:   cols.totalOldRetailers >= 0 ? cellNum(row[cols.totalOldRetailers]) : null,
      visitedRetailers:    cols.visitedRetailers >= 0 ? cellNum(row[cols.visitedRetailers]) : null,
      nonVisitedRetailers: cols.nonVisitedRetailers >= 0 ? cellNum(row[cols.nonVisitedRetailers]) : null,
      newPartyOrderBooking,
      businessPerRetailer:  cols.businessPerRetailer >= 0 ? cellNum(row[cols.businessPerRetailer]) : null,
      totalRetailers:       cols.totalRetailers >= 0 ? cellNum(row[cols.totalRetailers]) : null,
      directDealersCount:   cols.directDealersCount >= 0 ? cellNum(row[cols.directDealersCount]) : null,
      totalVisitsYtd:       cols.totalVisitsYtd >= 0 ? cellNum(row[cols.totalVisitsYtd]) : null,
      extra,
    });
    applyPriorYearQuarterFallback(members[members.length - 1], fy);
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

// _fromDbSnap tracks whether the most recently loaded CacheEntry for a FY
// was served from the DB snapshot (true) or from a live Sheets read (false).
const _fromDbSnap = new Map<string, boolean>();

// Stale-snapshot fallback: when the live Sheets read fails transiently
// (quota / cold start), the last saved DB snapshot is served with a `stale`
// flag instead of a hard error.  Held outside `_cache` with a short expiry so
// the next request after the window retries the live read.
const STALE_SERVE_MS = 60_000;
const _staleFallback = new Map<string, { entry: CacheEntry; until: number }>();
// True when the most recent load for a FY was served from the stale fallback.
const _servedStale = new Map<string, boolean>();

// _registry: one IdentityRegistry per FY, built lazily when allMembers is first
// populated. Detects name collisions at load time and enables ambiguous-input
// rejection in all member-lookup routes.
const _registry = new Map<string, IdentityRegistry>();

/** Synchronous access — returns null if this FY has not been loaded yet. */
export function getRegistry(fy: string): IdentityRegistry | null {
  return _registry.get(fy) ?? null;
}

/**
 * Async access — triggers a data load if the FY is not yet cached, then
 * returns the registry.  Adds no Sheets-read overhead once the FY is warm
 * (both loadAllMembers and this call hit the in-process Map).
 */
export async function loadRegistry(fy: string): Promise<IdentityRegistry | null> {
  await loadAllMembers(fy);
  return _registry.get(fy) ?? null;
}

/** Lightweight target snapshot per member from the Data tab — for the target
 *  engine's zero-target detection.  Adds no Sheets overhead when FY is warm. */
export type MemberTargetSnapshot = {
  name: string;
  normKey: string;
  stateHead: string;
  isLeft: boolean;
  totalTargetToDate: number | null;
  monthlyTarget: number | null;
  /** Secondary OB + direct-dealer OB (YTD) — allocation weight for rollups. */
  obTotal: number;
  sale: number;
  /** T2 additions — person-level secondary engine needs these. */
  state: string;
  workingDaysActual: number | null;
  elapsedMonths: number | null;
  /** Declared retailer count (BH "Grand Total Retailers"). */
  totalRetailers: number | null;
};

export async function loadMemberTargetSnapshots(
  fy: string,
): Promise<MemberTargetSnapshot[] | null> {
  const entry = await loadAllMembers(fy);
  if (!entry) return null;
  return entry.allMembers.map((m) => ({
    name: m.name,
    normKey: m.normKey,
    stateHead: m.stateHead,
    isLeft: m.isLeft,
    totalTargetToDate: m.totalTargetToDate,
    monthlyTarget: m.monthlyTarget,
    obTotal: (m.orderBooking ?? 0) + (m.directDealersOrder ?? 0),
    sale: m.sale ?? 0,
    state: extractStateName(m),
    workingDaysActual: m.workingDaysActual,
    elapsedMonths: m.elapsedMonths,
    totalRetailers: m.totalRetailers,
  }));
}

async function loadAllMembers(fy: string): Promise<CacheEntry | null> {
  clearExpired();
  const hit = _cache.get(fy);
  if (hit) return hit;

  const pending = _inFlight.get(fy);
  if (pending) return pending;

  const p: Promise<CacheEntry | null> = (async () => {
    // Phase 6: for closed FYs try the DB snapshot before hitting Sheets.
    // A snapshot exists after the first successful Sheets load for that FY.
    if (isClosedFy(fy)) {
      const snap = await loadDeepDiveFromDb(fy);
      if (snap) {
        logger.info({ fy }, "deepDiveData: loaded from DB snapshot — no Sheets read");
        _fromDbSnap.set(fy, true);
        _cache.set(fy, snap);
        _registry.set(fy, new IdentityRegistry(snap.allMembers, fy));
        return snap;
      }
    }
    // Live Sheets read (first-ever load, or live FY).
    const entry = await loadAllMembersUncached(fy);
    if (entry) {
      _fromDbSnap.set(fy, false);
      _servedStale.set(fy, false);
      _staleFallback.delete(fy);
      _cache.set(fy, entry);
      _registry.set(fy, new IdentityRegistry(entry.allMembers, fy));
      // Phase 6: fire-and-forget DB persist for future cold starts.
      void saveDeepDiveSnapshot(fy, entry);
      return entry;
    }

    // Live read failed (typically transient: Sheets quota / cold start).
    // Serve the last saved DB snapshot with a stale flag instead of erroring.
    // The fallback expires after STALE_SERVE_MS so a later request retries
    // the live read (in-flight dedupe prevents stampedes meanwhile).
    const cachedStale = _staleFallback.get(fy);
    if (cachedStale && Date.now() < cachedStale.until) {
      _servedStale.set(fy, true);
      return cachedStale.entry;
    }
    const snap = await loadDeepDiveFromDb(fy);
    if (snap) {
      logger.warn(
        { fy },
        "deepDiveData: live Sheets read failed — serving stale DB snapshot",
      );
      _staleFallback.set(fy, { entry: snap, until: Date.now() + STALE_SERVE_MS });
      _servedStale.set(fy, true);
      _fromDbSnap.set(fy, true);
      // Registry from the snapshot so member resolution keeps working.
      _registry.set(fy, new IdentityRegistry(snap.allMembers, fy));
      return snap;
    }

    // No snapshot at all (first-ever load) — retry the live read once after a
    // short pause before giving up with the hard error.
    await new Promise((r) => setTimeout(r, 1_500));
    const retry = await loadAllMembersUncached(fy);
    if (retry) {
      _fromDbSnap.set(fy, false);
      _servedStale.set(fy, false);
      _cache.set(fy, retry);
      _registry.set(fy, new IdentityRegistry(retry.allMembers, fy));
      void saveDeepDiveSnapshot(fy, retry);
    }
    return retry;
  })().finally(() => _inFlight.delete(fy));

  _inFlight.set(fy, p);
  return p;
}

// ── Team summary helpers ───────────────────────────────────────────────────────

/** Derive the display state name from the member's extra fields or HQ. */
function extractStateName(m: MemberKpis): string {
  // Prefer the properly-cased STATE column (e.g. "West Bengal") from the Data tab.
  // Fall back to WORKINGSTATE (often all-caps "WEST BENGAL") then HQ city.
  const raw =
    (m.extra["STATE"] as string | null) ??
    (m.extra["WORKINGSTATE"] as string | null);
  if (!raw) return m.hq ?? "Unknown";
  // Title-case if value is all-uppercase (e.g. "WEST BENGAL" → "West Bengal").
  if (raw === raw.toUpperCase() && /[A-Z]/.test(raw)) {
    return raw
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  return raw;
}

function buildTeamSummary(filtered: MemberKpis[]): TeamSummary {
  const active = filtered.filter((m) => !m.isLeft);
  const left   = filtered.filter((m) => m.isLeft);

  const sumN = (arr: MemberKpis[], fn: (m: MemberKpis) => number | null): number =>
    arr.reduce((s, m) => s + (fn(m) ?? 0), 0);

  const isZeroTarget = (m: MemberKpis): boolean => (m.totalTargetToDate ?? 0) <= 0;

  // "Total OB" for team display = old-party OB + new-party OB + direct-dealer OB.
  // This matches the per-member achievementTotal formula and the Data-tab "Sub Total".
  // directDealerOB is also reported as a breakdown field (subset of totalOB).
  const memberOB = (m: MemberKpis): number =>
    (m.orderBooking ?? 0) + (m.newPartyOrderBooking ?? 0) + (m.directDealersOrder ?? 0);

  const zeroTargetActive = active.filter(isZeroTarget);
  const withTargetActive = active.filter((m) => !isZeroTarget(m));

  const totalTarget    = sumN(active, (m) => m.totalTargetToDate);
  const totalOB        = sumN(active, memberOB);
  const directDealerOB = sumN(active, (m) => m.directDealersOrder);
  const totalSale      = sumN(active, (m) => m.sale);
  const totalVisits    = sumN(active, (m) => m.totalVisitsYtd);
  const totalRetailers = sumN(active, (m) => m.totalRetailers);

  const headlineAchievementPct =
    totalTarget > 0 ? (totalOB / totalTarget) * 100 : null;

  const likeForLikeOB     = sumN(withTargetActive, memberOB);
  const likeForLikeTarget = sumN(withTargetActive, (m) => m.totalTargetToDate);
  const likeForLikeAchievementPct =
    likeForLikeTarget > 0 ? (likeForLikeOB / likeForLikeTarget) * 100 : null;

  // Per-state aggregation (active members only).
  const stateMap = new Map<string, MemberKpis[]>();
  for (const m of active) {
    const state = extractStateName(m);
    const bucket = stateMap.get(state);
    if (bucket) bucket.push(m);
    else stateMap.set(state, [m]);
  }

  const byState: StateBreakdownRow[] = [];
  for (const [state, mems] of stateMap) {
    const withTarget  = mems.filter((m) => !isZeroTarget(m));
    const stateTarget = sumN(mems, (m) => m.totalTargetToDate);
    const stateOB     = sumN(mems, memberOB);
    const zeroMems    = mems.filter(isZeroTarget);
    const likeOB      = sumN(withTarget, memberOB);
    const likeTarget  = sumN(withTarget, (m) => m.totalTargetToDate);

    byState.push({
      state,
      memberCount:       mems.length,
      membersWithTarget: withTarget.length,
      targetTotal:       stateTarget,
      obTotal:           stateOB,
      saleTotal:         sumN(mems, (m) => m.sale),
      visitTotal:        sumN(mems, (m) => m.totalVisitsYtd),
      headlinePct:       stateTarget > 0 ? (stateOB / stateTarget) * 100 : null,
      likeForLikePct:    likeTarget  > 0 ? (likeOB  / likeTarget)  * 100 : null,
      zeroTargetCount:   zeroMems.length,
      zeroTargetOb:      sumN(zeroMems, memberOB),
    });
  }
  // Descending by OB so the largest states appear first.
  byState.sort((a, b) => b.obTotal - a.obTotal);

  return {
    totalMembers:             filtered.length,
    activeMembers:            active.length,
    leftMembers:              left.length,
    zeroTargetActiveCount:    zeroTargetActive.length,
    zeroTargetActiveOb:       sumN(zeroTargetActive, memberOB),
    zeroTargetActiveNames:    zeroTargetActive.map((m) => m.name),
    totalTarget,
    totalOB,
    totalSale,
    totalVisits,
    totalRetailers,
    directDealerOB,
    headlineAchievementPct,
    likeForLikeAchievementPct,
    byState,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadDeepDiveData(
  fy: string,
  selectedStateHead?: string,
  selectedMemberKey?: string,
  opts: { skipExtras?: boolean } = {},
): Promise<DeepDiveDataResult> {
  const { skipExtras = false } = opts;
  const entry = await loadAllMembers(fy);

  if (!entry) {
    // Phases 5 and 6 are DB-only — compute them even when the Data tab fails.
    const [skuSpread, winBackResult] = await Promise.all([
      selectedMemberKey ? computeSkuSpread(selectedMemberKey, fy) : Promise.resolve(null),
      selectedMemberKey ? computeWinBack(selectedMemberKey, []) : Promise.resolve(null),
    ]);
    return {
      fy,
      stateHeads: [],
      members: [],
      kpis: null,
      teamSummary: null,
      retailerDetail: null,
      roiCost: null,
      skuSpread,
      winBack: winBackResult ? winBackResult.items : null,
      rowsRead: 0,
      dataReadAt: 0,
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
    state: extractStateName(m),
    achievementTotal: m.achievementTotal ?? null,
    isLeft: m.isLeft,
    directDealerOb: m.directDealersOrder ?? 0,
  }));

  // Team summary — computed whenever a state head is chosen (regardless of
  // whether a specific member is also selected).
  const teamSummary: TeamSummary | null =
    selectedStateHead && filtered.length > 0
      ? buildTeamSummary(filtered)
      : null;

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

  // Phase 2: load retailer-level detail from the member's own working sheet.
  // We race the Sheets read against a short timeout so Phase 1 KPIs always
  // respond quickly. On a cache miss, the background read continues; a
  // re-selection of the same member will serve the cached result instantly.
  const MEMBER_SHEET_TIMEOUT_MS = 8_000;
  let retailerDetail: MemberSheetData | null = null;
  if (selectedMemberKey && kpis) {
    const loadPromise = loadMemberSheet(selectedMemberKey, kpis.name, fy);
    const timeoutPromise = new Promise<MemberSheetData>((resolve) =>
      setTimeout(
        () =>
          resolve({
            status: "loading",
            error:
              "Retailer data is loading in the background. Re-select this member in 30–60 seconds to see the retailer detail.",
          }),
        MEMBER_SHEET_TIMEOUT_MS,
      ),
    );
    retailerDetail = await Promise.race([loadPromise, timeoutPromise]);
  }

  // Phase 4: compute ROI on cost when kpis + retailer spread are both available.
  const roiCost =
    kpis && retailerDetail?.status === "ok"
      ? computeRoiCost(
          kpis.ctcMonthly,
          kpis.taBillStCost,
          fy,
          retailerDetail.spread,
        )
      : null;

  // Current working-sheet customer names (for win-back comparison).
  const currentCustomers: string[] =
    retailerDetail?.status === "ok" && retailerDetail.rows
      ? retailerDetail.rows.map((r) => r.name)
      : [];

  // Phases 5 + 6: run in parallel — both DB-only, no additional Sheets reads.
  // Skip when the caller does not need them (e.g. warnings engine).
  const [skuSpread, winBackResult] = selectedMemberKey && !skipExtras
    ? await Promise.all([
        computeSkuSpread(selectedMemberKey, fy),
        computeWinBack(selectedMemberKey, currentCustomers),
      ])
    : [null, null];

  const fromDbSnapshot = _fromDbSnap.get(fy) ?? false;
  const stale = _servedStale.get(fy) ?? false;

  return {
    fy,
    stateHeads,
    members,
    kpis,
    teamSummary,
    retailerDetail,
    roiCost,
    skuSpread,
    winBack: winBackResult ? winBackResult.items : null,
    rowsRead: entry.rowsRead,
    dataReadAt: entry.loadedAt,
    error: null,
    fromDbSnapshot,
    stale,
  };
}
