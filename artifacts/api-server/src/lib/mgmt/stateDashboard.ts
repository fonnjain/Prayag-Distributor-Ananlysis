// STATE HEAD DASHBOARD — secondary order booking reader.
//
// AUTHORITATIVE source for per-person per-month secondary data:
//   Plan (target), Order Booked, Sales Received, Salary (Monthly CTC), Dealers
//
// Business model (CRITICAL — do not change):
//   Prayag sells ONCE to Distributors (PRIMARY).
//   Salesperson takes orders from retailers/dealers → gives to distributor
//   → enables the distributor to book a primary order.
//   Secondary ⊂ Primary. Never add them together.
//
// Achievement = Sales Received / Plan (RECOMPUTED — the sheet's own monthly
//   total row uses Order Booked / Plan, which is WRONG).
//
// Cadence: secondary is recorded MONTHLY at month-end.
//   A month is "open" if today < last calendar day of that month.
//   Open months with no data → notYetRecorded=true, never 0%.
//   YTD achievement uses CLOSED MONTHS ONLY.
//
// Anomaly rule: per-person per-month, if salesAmount > orderedAmount × 1.5
//   and orderedAmount > 0, it is physically impossible and must be flagged.
//   Show the recorded value (never alter the sheet), exclude from rankings.
//
// FY2026-27 verification anchors (secondary members only, closed months):
//   Company-wide Business Plan = ₹364.97 Cr (verified Jul 2026)
//   Q1 YTD Sales = ₹48.37 Cr, Q1 YTD Achievement = 63.1%
//   Per-member spot-check: Ravinder Puri April plan ₹18L, sales ₹16.74L → 93.0% ✓
//   (Note: ₹57.88 Cr / 69.4% figures in earlier drafts included primary-role members)
//
// Source sheets (read-only, identical structure):
//   FY2026-27: spreadsheet 1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM
//              tab "SECONDARY ORDER BOOKING REPORT 2026-27" (gid 0)
//   FY2025-26: spreadsheet 1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY
//              tab "ORDER BOOKING REPORT 2025-26" (gid 0)

import { desc, eq } from "drizzle-orm";
import { db, secondaryDashboardSnapshots } from "@workspace/db";
import { logger } from "../logger.js";
import {
  readTabRowsChunked,
  readAllTabRows,
  listSheetTabs,
  type SheetCellValue,
  type SheetTab,
} from "../registers/sheetsApi.js";
import { normName, fyStartYear } from "./names.js";

// Secondary-specific member key: lowercase alphanumeric, parenthetical content
// KEPT (not stripped).  This preserves location/status disambiguators so that
// "Ravi" and "Ravi (Faridabad)", or "Mahaveer Jain" and "Mahaveer Jain (Off
// Roll)", produce DISTINCT head_canon values and never overwrite each other on
// upsert.  normName() still used for isPrimaryRole matching (roster join).
function normSecKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── Sheet config ─────────────────────────────────────────────────────────────

const SHEET_IDS: Record<string, string> = {
  "2026-27": "1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM",
  "2025-26": "1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY",
  "2024-25": "1MwNMVzWE3QBVOyJjKr3eFX-Sq1Ng0Q1sghWJbgbE_8g",
  "2023-24": "1ESjgk5FthsvYc_Bk9zuJVnJ1XtwKQxv0XG2onuspnhg",
};

// Tab names differ slightly between years; match by prefix (case-insensitive).
// FY2026-27 uses a different prefix ("SECONDARY ORDER BOOKING REPORT") from all
// earlier years ("ORDER BOOKING REPORT"). Each workbook contains only one matching
// tab so the prefix is unambiguous within its workbook.
const TAB_PREFIXES: Record<string, string> = {
  "2026-27": "SECONDARY ORDER BOOKING REPORT",
  "2025-26": "ORDER BOOKING REPORT",
  "2024-25": "ORDER BOOKING REPORT",
  "2023-24": "ORDER BOOKING REPORT",
};

// Additional tabs (FY26-27 only). Gracefully absent for other years.
const PRIMARY_MEMBERS_TAB_PREFIX = "PRIMARY TEAM MEMBERS";
const LOW_PERFORMERS_TAB_PREFIX = "LOW PERFORMERS";
const SUMMARY_TAB_PREFIX = "SUMMARY SHEET";

// ── Month helpers ─────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER",
  "OCTOBER","NOVEMBER","DECEMBER","JANUARY","FEBRUARY","MARCH",
] as const;

// Calendar date for last day of fiscal month monthIdx (0=Apr..11=Mar) of `fy`.
function monthLastDay(monthIdx: number, fy: string): Date {
  const startYear = fyStartYear(fy);
  // Apr(0)..Dec(8) = calendar month 3..11 of startYear
  // Jan(9)..Mar(11) = calendar month 0..2 of startYear+1
  const calMonth = (monthIdx + 3) % 12; // 0=Jan..11=Dec
  const calYear = monthIdx <= 8 ? startYear : startYear + 1;
  // new Date(y, m+1, 0) = last day of month m in year y (UTC)
  return new Date(Date.UTC(calYear, calMonth + 1, 0));
}

export function isMonthClosed(monthIdx: number, fy: string, nowMs = Date.now()): boolean {
  return nowMs > monthLastDay(monthIdx, fy).getTime();
}

// ── Types ────────────────────────────────────────────────────────────────────

export type SecMonthData = {
  planAmount: number | null;
  planCount: number | null;
  orderedAmount: number | null;
  orderedCount: number | null;
  salesAmount: number | null;
  salesCount: number | null;
  // RECOMPUTED: salesAmount / planAmount. Null when plan = 0 or month open.
  achievement: number | null;
  // True when the month has not closed yet (secondary not yet recorded).
  notYetRecorded: boolean;
  // True when salesAmount > orderedAmount * 1.5 AND orderedAmount > 0.
  // Physically impossible — data-entry error. Exclude from rankings.
  isAnomaly: boolean;
};

export type SecMember = {
  stateHead: string;
  name: string;
  // normKey: normSecKey of the raw name — unique per person in the DB (head_canon).
  // Keeps parenthetical disambiguators so "Ravi" and "Ravi (Faridabad)" remain distinct.
  normKey: string;
  // joinKey: normName of the raw name — strips parentheticals, used to join
  // against the roster (which uses normName throughout).
  joinKey: string;
  hq: string;
  contactNumber: string;
  salary: number | null;       // Monthly CTC
  monthlyTarget: number | null;
  totalDealers: number | null;
  businessPlan: number | null; // Annual target
  // YTD aggregates (closed months only) — per-member display.
  // ytdSalesReceived: null only when the member has no plan AND no sales (truly inactive).
  // Real sales are always included regardless of whether a plan exists.
  ytdOrderBooked: number | null;
  ytdSalesReceived: number | null;
  ytdPlan: number | null;
  // RECOMPUTED: ytdSalesReceived / ytdPlan
  ytdAchievement: number | null;
  // ALL-months totals (every month, open or closed, including anomalous) — used for
  // company/state-head headline totals so they tie exactly to the sheet's own TOTAL row.
  allMonthsOrderBooked: number;
  allMonthsSalesReceived: number;
  months: SecMonthData[];      // 12 elements, index 0=Apr..11=Mar
  isPrimaryRole: boolean;      // In "Primary Team Members" tab (currently advisory only)
  isLeft: boolean;             // In "LEFT TEAM MEMBERS" section (count in totals, never low-perf)
};

export type SecDashboard = {
  fy: string;
  sheetId: string;
  tabName: string;
  members: SecMember[];
  primaryRoleKeys: Set<string>;
  primaryRoleNames: string[];   // raw display names from the PRIMARY TEAM MEMBERS tab
  // Company totals — ALL members, ALL months (open+closed, anomalous included).
  // These must tie exactly to the sheet's own TOTAL row.
  totalPlan: number;
  totalOrderBooked: number;
  totalSalesReceived: number;
  totalDealers: number;
  ytdAchievement: number | null;
  // Month indices (0=Apr..11=Mar) where the V4 arrears guard fired:
  // calendar-closed months where secondary data was not yet entered by state heads.
  // Absent in snapshots saved before the guard was introduced.
  arrearsMonths?: number[];
  // Raw values read from the sheet's own TOTAL row (for reconciliation).
  // Null when the TOTAL row could not be located.
  sheetTotals: { orderBooked: number | null; salesReceived: number | null } | null;
  anomalies: Array<{
    name: string;
    stateHead: string;
    monthIdx: number;
    monthLabel: string;
    salesAmount: number;
    orderedAmount: number;
    ratio: number;
  }>;
  rowsRead: number;
  loadedAt: number;
};

// ── In-process cache ─────────────────────────────────────────────────────────

const TTL_MS = 15 * 60_000;
const _cache = new Map<string, SecDashboard>();
const _inFlight = new Map<string, Promise<SecDashboard | null>>();

// Returns the fiscal year that contains today, e.g. "2026-27" in July 2026.
// Apr(3)..Mar(2) straddles two calendar years; the FY starts in April.
function currentFy(): string {
  const now = new Date();
  const yr = now.getUTCFullYear();
  const mo = now.getUTCMonth(); // 0=Jan
  const fyStart = mo >= 3 ? yr : yr - 1;
  return `${fyStart}-${String(fyStart + 1).slice(-2)}`;
}

// A FY is closed once its end date (31 Mar of fyStart+1) has passed, which is
// equivalent to its start year being less than the current FY's start year.
function isClosedFy(fy: string): boolean {
  return fyStartYear(fy) < fyStartYear(currentFy());
}

// ── DB snapshot serialisation ─────────────────────────────────────────────────
// SecDashboard.primaryRoleKeys is a Set<string>.  Sets are not JSON-serialisable
// so the DB snapshot uses a plain string[] in their place.

type SecDashboardJson = Omit<SecDashboard, "primaryRoleKeys"> & {
  primaryRoleKeys: string[];
};

// Fire-and-forget: write a snapshot after every successful Sheets load so
// cold-restart loads for closed FYs can read from DB instead of Sheets.
async function saveStateDashboardSnapshot(dash: SecDashboard): Promise<void> {
  try {
    const data: SecDashboardJson = { ...dash, primaryRoleKeys: [...dash.primaryRoleKeys] };
    await db.insert(secondaryDashboardSnapshots).values({ fy: dash.fy, data });
  } catch (err) {
    logger.warn({ err, fy: dash.fy }, "stateDashboard: DB snapshot save failed");
  }
}

// Returns the most recent DB snapshot for a FY, or null when none exists.
async function loadStateDashboardFromDb(fy: string): Promise<SecDashboard | null> {
  try {
    const rows = await db
      .select()
      .from(secondaryDashboardSnapshots)
      .where(eq(secondaryDashboardSnapshots.fy, fy))
      .orderBy(desc(secondaryDashboardSnapshots.savedAt))
      .limit(1);
    if (rows.length === 0) return null;
    const snap = rows[0].data as SecDashboardJson;
    return { ...snap, primaryRoleKeys: new Set(snap.primaryRoleKeys) };
  } catch (err) {
    logger.warn({ err, fy }, "stateDashboard: DB snapshot load failed, falling back to Sheets");
    return null;
  }
}

export function invalidateStateDashboardCache(fy?: string): void {
  if (fy) {
    _cache.delete(fy);
  } else {
    _cache.clear();
  }
}

// Returns the cached dashboard synchronously if it is warm; otherwise null.
// Use this in endpoints that should NOT block waiting for a Sheets fetch —
// they get the pre-fill for free once the cache is warm (warmed by the first
// dashboard load) and degrade gracefully on a cold cache.
export function getCachedStateDashboard(fy: string): SecDashboard | null {
  const hit = _cache.get(fy);
  if (!hit) return null;
  // Closed FYs are held for the process lifetime — they never expire.
  if (isClosedFy(fy)) return hit;
  return Date.now() - hit.loadedAt < TTL_MS ? hit : null;
}

// Never throws. Returns null when the sheet is unreachable or the FY is
// not configured. Callers degrade gracefully when null is returned.
//
// Load priority:
//  1. In-process cache (permanent for closed FYs, TTL_MS for the current FY)
//  2. DB snapshot    (closed FYs only — avoids re-reading Sheets after restart)
//  3. Live Sheets    (always for the current FY; fallback for closed FYs that
//                     have no DB snapshot yet, i.e. first warm-up)
// When nowMs is provided the cache is bypassed completely (testing / simulation
// only — do not pass nowMs in production code paths).
export async function loadStateDashboard(fy: string, nowMs?: number): Promise<SecDashboard | null> {
  if (nowMs !== undefined) {
    // Simulated date: skip cache and fly directly to the uncached loader so the
    // arrears guard runs with the injected clock. skipPersist=true ensures the
    // simulation result never contaminates the live in-process cache or DB.
    return loadStateDashboardUncached(fy, nowMs, true);
  }
  const hit = _cache.get(fy);
  if (hit && (isClosedFy(fy) || Date.now() - hit.loadedAt < TTL_MS)) return hit;
  const pending = _inFlight.get(fy);
  if (pending) return pending;
  const p: Promise<SecDashboard | null> = (async () => {
    if (isClosedFy(fy)) {
      // Cold cache for a closed FY: try the DB snapshot before hitting Sheets.
      // A DB snapshot exists after the first successful Sheets load for that FY.
      const snap = await loadStateDashboardFromDb(fy);
      if (snap) {
        _cache.set(fy, snap);
        return snap;
      }
    }
    return loadStateDashboardUncached(fy);
  })().finally(() => _inFlight.delete(fy));
  _inFlight.set(fy, p);
  return p;
}

// ── Cell helpers ─────────────────────────────────────────────────────────────

function cellStr(v: SheetCellValue): string {
  return String(v ?? "").trim();
}

function cellNum(v: SheetCellValue): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normHeader(v: SheetCellValue): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── Tab discovery ─────────────────────────────────────────────────────────────

async function findTab(
  sheetId: string,
  prefix: string,
): Promise<string | null> {
  try {
    const tabs: SheetTab[] = await listSheetTabs(sheetId);
    const p = prefix.toUpperCase();
    const hit = tabs.find((t) => t.title.toUpperCase().startsWith(p));
    return hit?.title ?? null;
  } catch {
    return null;
  }
}

// ── Header parsing ────────────────────────────────────────────────────────────

// Column layout after the anchor row is found.
type ColMap = {
  stateHead: number;
  teamMember: number;
  hq: number;
  contactNumber: number;
  doj: number;
  weekOff: number;
  marketHours: number;
  ctc: number;
  monthlyTarget: number;
  totalDealers: number;
  businessPlan: number;
  orderBooked: number;    // annual YTD total (we recompute from months)
  finalAch: number;       // annual achievement % (NEVER USE — recomputed)
  sales: number;          // annual YTD sales total (we recompute)
  // Starting column for month blocks (= sales column + 1 or detected from row)
  monthStart: number;
};

function detectCols(anchorRow: SheetCellValue[]): ColMap | null {
  const idx: Record<string, number> = {};
  anchorRow.forEach((c, i) => {
    const k = normHeader(c);
    if (k && !(k in idx)) idx[k] = i;
  });

  // Second pass: also register stripped versions of FY-year-suffixed headers.
  // E.g. "Monthly CTC 25-26" normalises to "MONTHLYCTC2526"; strip the 4-digit
  // year suffix so "MONTHLYCTC" also matches that column.
  // Handles patterns like 2526, 2627, 2728, 2829 (FY transitions).
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

  const stateHead = find("STATEHEAD", "STATE");
  const teamMember = find("TEAMMEMBER", "TEAMMEMBERNAME", "NAME");
  if (stateHead < 0 || teamMember < 0) return null;

  const hq = find("HQ", "HEADQUARTER", "HEADQUARTERS");
  const contactNumber = find("CONTACTNUMBER", "CONTACT", "MOBILE");
  const doj = find("DOJ", "DATEOFJOINING");
  const weekOff = find("WEEKOFF");
  const marketHours = find("MARKETHOURS");
  const ctc = find("MONTHLYCTC", "CTC");
  const monthlyTarget = find("MONTHLYTARGET");
  const totalDealers = find("TOTALDEALER", "TOTALDEALERS", "DEALER", "DEALERS");
  const businessPlan = find("BUSINESSPLAN", "ANNUALTARGET", "ANNUALBUSINESS");
  const orderBooked = find("ORDERBOOKED");
  const finalAch = find("FINALACHIEVEMENT", "ACHIEVEMENT");
  const sales = find("SALES");

  // Month blocks start at the column after "Sales" (or after the last detected fixed col).
  const fixedLast = Math.max(stateHead, teamMember, hq, contactNumber, doj, weekOff,
    marketHours, ctc, monthlyTarget, totalDealers, businessPlan, orderBooked, finalAch, sales);
  const monthStart = fixedLast >= 0 ? fixedLast + 1 : -1;

  return {
    stateHead, teamMember, hq, contactNumber, doj, weekOff, marketHours,
    ctc, monthlyTarget, totalDealers, businessPlan, orderBooked, finalAch, sales,
    monthStart,
  };
}

// Convert an Excel/Sheets serial date number to { year, month } (month 0=Jan).
// Excel epoch: Jan 0 1900. Offset 25569 aligns it to the Unix epoch (Jan 1 1970).
// The Lotus 1-2-3 leap-year bug means Excel treats 1900 as a leap year, which
// shifts serials ≥ 60 (Mar 1 1900 onwards) by +1; JS Date handles the rest.
function excelSerialToYearMonth(serial: number): { year: number; month: number } | null {
  if (!Number.isFinite(serial) || serial < 40000 || serial > 55000) return null;
  const ms = (serial - 25569) * 86400_000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() }; // month 0=Jan
}

// Map a calendar { year, month } to the FY month index (0=Apr .. 11=Mar)
// for the given FY string, e.g. "2026-27".
function calToFyMonthIdx(year: number, month: number, fy: string): number | null {
  const fyStart = fyStartYear(fy); // e.g. 2026
  // Apr(3)..Dec(11) of fyStart → FY month 0..8
  if (year === fyStart && month >= 3) return month - 3;
  // Jan(0)..Mar(2) of fyStart+1 → FY month 9..11
  if (year === fyStart + 1 && month <= 2) return month + 9;
  return null;
}

// Build month-block positions from the anchor row or subsequent rows.
// Returns array of 12 start-column indices (Apr=0..Mar=11), or null.
function detectMonthBlocks(
  anchorRow: SheetCellValue[],
  monthStart: number,
  fy?: string,
): number[] | null {
  const blockStarts: (number | undefined)[] = new Array(12);

  // Strategy 1: text month names ("April", "May", …).
  // Merged cells appear as the name in the leftmost column, blank in the others.
  const monthIdx: Record<string, number> = {};
  MONTH_NAMES.forEach((m, i) => { monthIdx[m] = i; });

  for (let c = monthStart; c < anchorRow.length; c++) {
    const k = normHeader(anchorRow[c]);
    if (k && k in monthIdx && blockStarts[monthIdx[k]] == null) {
      blockStarts[monthIdx[k]] = c;
    }
  }

  const nameHits = blockStarts.filter((v) => v != null).length;

  // Strategy 2: Excel/Sheets date serial numbers.
  // The STATE HEAD DASHBOARD stores month-start dates (e.g. 46113 = April 1 2026)
  // instead of text labels. Detect any numeric cell that resolves to a month-start
  // date within the configured FY.
  if (nameHits < 6 && fy) {
    for (let c = monthStart; c < anchorRow.length; c++) {
      const v = anchorRow[c];
      if (typeof v !== "number") continue;
      const ym = excelSerialToYearMonth(v);
      if (!ym) continue;
      const mi = calToFyMonthIdx(ym.year, ym.month, fy);
      if (mi != null && blockStarts[mi] == null) {
        blockStarts[mi] = c;
      }
    }
  }

  // Strategy 3: positional fallback — assume 7-wide blocks from monthStart.
  // Only fills gaps left after strategies 1 and 2.
  const totalHits = blockStarts.filter((v) => v != null).length;
  if (totalHits < 12) {
    // Infer block size from detected positions (should be 7).
    let blockSize = 7;
    for (let m = 1; m < 12; m++) {
      if (blockStarts[m] != null && blockStarts[m - 1] != null) {
        blockSize = (blockStarts[m] as number) - (blockStarts[m - 1] as number);
        break;
      }
    }
    for (let m = 0; m < 12; m++) {
      if (blockStarts[m] == null) {
        // Extrapolate from the nearest known anchor.
        const anchor = blockStarts.findIndex((v) => v != null);
        if (anchor >= 0) {
          blockStarts[m] = (blockStarts[anchor] as number) + (m - anchor) * blockSize;
        } else {
          blockStarts[m] = monthStart + m * blockSize;
        }
      }
    }
  }

  const result = blockStarts as number[];
  return result.length >= 12 ? result : null;
}

// ── Primary-role member list ──────────────────────────────────────────────────

async function loadPrimaryRoleKeys(
  sheetId: string,
): Promise<{ keys: Set<string>; names: string[] }> {
  const keys = new Set<string>();
  const names: string[] = [];
  const tab = await findTab(sheetId, PRIMARY_MEMBERS_TAB_PREFIX);
  if (!tab) return { keys, names };
  try {
    const rows = await readAllTabRows(sheetId, tab);
    for (const row of rows) {
      const name = cellStr(row?.[1] ?? row?.[0]);
      if (!name) continue;
      const trimmed = name.trim();
      // Skip row numbers, blank cells, and obvious header rows.
      if (!trimmed || trimmed.length < 3) continue;
      if (/^\d+$/.test(trimmed)) continue;  // pure number → row index
      const upper = trimmed.toUpperCase();
      if (
        upper.startsWith("S.") ||      // S.No. column headers
        upper.startsWith("SR.") ||
        upper.includes("MEMBER") ||
        upper.includes("REPORTING") ||
        upper.includes("STATE HEAD") ||
        upper.includes("TEAM HEAD") ||
        upper.includes("S.NO") ||
        upper.includes("SR.NO")
      ) continue;
      const k = normName(trimmed);
      if (k && !keys.has(k)) {          // deduplicate by normKey
        keys.add(k);
        names.push(trimmed);
      }
    }
  } catch (err) {
    logger.warn({ err, sheetId, tab }, "stateDashboard: primary role tab read failed");
  }
  return { keys, names };
}

// ── Main loader ───────────────────────────────────────────────────────────────

async function loadStateDashboardUncached(fy: string, nowMs = Date.now(), skipPersist = false): Promise<SecDashboard | null> {
  const sheetId = SHEET_IDS[fy];
  if (!sheetId) {
    logger.warn({ fy }, "stateDashboard: no sheet configured for this FY");
    return null;
  }

  const tabPrefix = TAB_PREFIXES[fy] ?? "SECONDARY ORDER BOOKING REPORT";
  const tabName = await findTab(sheetId, tabPrefix);
  if (!tabName) {
    logger.warn({ fy, sheetId, tabPrefix }, "stateDashboard: secondary tab not found");
    return null;
  }

  // Load primary-role keys/names and the secondary data concurrently.
  const [primaryRoleResult, allRows] = await Promise.all([
    loadPrimaryRoleKeys(sheetId).catch((): { keys: Set<string>; names: string[] } => ({ keys: new Set(), names: [] })),
    (async () => {
      const rows: SheetCellValue[][] = [];
      await readTabRowsChunked(sheetId, tabName, (batch) => rows.push(...batch));
      return rows;
    })(),
  ]);

  const { keys: primaryRoleKeys, names: primaryRoleNames } = primaryRoleResult;

  logger.info({ fy, tab: tabName, rows: allRows.length }, "stateDashboard: raw rows read");

  // ── Find anchor row ────────────────────────────────────────────────────────
  let anchorIdx = -1;
  let cols: ColMap | null = null;
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const hasStateHead = row.some((c) => normHeader(c) === "STATEHEAD");
    const hasTeamMember = row.some(
      (c) => normHeader(c) === "TEAMMEMBER" || normHeader(c) === "TEAMMEMBERNAME",
    );
    if (hasStateHead && hasTeamMember) {
      const detected = detectCols(row);
      if (detected) {
        anchorIdx = i;
        cols = detected;
        break;
      }
    }
  }

  if (anchorIdx < 0 || !cols) {
    logger.warn({ fy, tab: tabName }, "stateDashboard: header row not detected");
    return null;
  }

  // Detect month block start columns from the anchor row (or fall back to positional).
  const monthStarts = detectMonthBlocks(allRows[anchorIdx], cols.monthStart, fy);
  if (!monthStarts) {
    logger.warn({ fy, tab: tabName }, "stateDashboard: month block positions not detected");
    return null;
  }

  // Data rows begin after the 3-row merged header (anchor + 2 sub-header rows).
  const dataStart = anchorIdx + 3;

  // ── Parse data rows ────────────────────────────────────────────────────────
  const members: SecMember[] = [];
  const anomalies: SecDashboard["anomalies"] = [];
  let currentStateHead = "";

  for (let i = dataStart; i < allRows.length; i++) {
    const row = allRows[i] ?? [];

    // Fill-down State Head (the column is vertically merged in the sheet).
    const rawHead = cellStr(row[cols.stateHead]);
    if (rawHead) currentStateHead = rawHead;

    const rawName = cellStr(row[cols.teamMember]);
    if (!rawName || rawName === currentStateHead) continue; // sub-total / blank row

    // normSecKey: keeps parenthetical disambiguators → distinct head_canon per person.
    // normName: strips parentheticals → used only for the roster-join isPrimaryRole check.
    const normKey = normSecKey(rawName);
    if (!normKey) continue;

    // LEFT TEAM MEMBERS section: track but never flag as low-performer.
    const isLeft = currentStateHead.toUpperCase().includes("LEFT");

    const isPrimaryRole = primaryRoleKeys.has(normName(rawName));

    const salary = cellNum(row[cols.ctc]);
    const totalDealers = cellNum(row[cols.totalDealers]);
    const businessPlan = cellNum(row[cols.businessPlan]);
    const monthlyTarget = cellNum(row[cols.monthlyTarget]);
    const hq = cellStr(row[cols.hq]);
    const contactNumber = cellStr(row[cols.contactNumber]);

    const months: SecMonthData[] = [];
    let ytdPlan = 0;
    let ytdOrdered = 0;
    let ytdSales = 0;
    let ytdHasData = false;
    let hasAnomalyMonth = false;
    // All-months accumulators: every month regardless of closed/anomaly status.
    // Used for company-level headline totals that must tie to the sheet's TOTAL row.
    let allMonthsOrdered = 0;
    let allMonthsSales = 0;

    for (let m = 0; m < 12; m++) {
      const base = monthStarts[m];
      const planAmount = cellNum(row[base]);
      const planCount = cellNum(row[base + 1]);
      const orderedAmount = cellNum(row[base + 2]);
      const orderedCount = cellNum(row[base + 3]);
      // row[base + 4] = % Achievement (SKIP — we recompute)
      const salesAmount = cellNum(row[base + 5]);
      const salesCount = cellNum(row[base + 6]);

      const closed = isMonthClosed(m, fy, nowMs);
      // A month is "not yet recorded" when it has not yet ended on the calendar.
      // Secondary data is entered at month-end, so ANY open month — even one where
      // the sheet has written an explicit zero — must show "in progress", never 0%.
      // The sheet pre-fills plan and sometimes writes zeros for future months; both
      // are meaningless until the month closes.  Use the calendar only.
      // NOTE: the V4 arrears guard below may override notYetRecorded=false for
      // calendar-closed months where state heads have not yet entered data.
      const notYetRecorded = !closed;

      // Anomaly: sales > 3× orders AND orders > 0.
      // The 1.5–3× band is genuine secondary delivery lag; above 3× warrants review.
      const isAnomaly =
        !isLeft &&
        salesAmount != null &&
        orderedAmount != null &&
        orderedAmount > 0 &&
        salesAmount > orderedAmount * 3.0;

      if (isAnomaly) {
        hasAnomalyMonth = true;
        anomalies.push({
          name: rawName,
          stateHead: currentStateHead,
          monthIdx: m,
          monthLabel: MONTH_NAMES[m],
          salesAmount: salesAmount!,
          orderedAmount: orderedAmount!,
          ratio: salesAmount! / orderedAmount!,
        });
      }

      // YTD (per-member display): closed months only. Anomalous months are
      // INCLUDED — received amount is real money; anomaly flag suppresses
      // rankings only, not gross totals.
      if (closed) {
        if (planAmount != null) { ytdPlan += planAmount; ytdHasData = true; }
        if (orderedAmount != null) ytdOrdered += orderedAmount;
        if (salesAmount != null) ytdSales += salesAmount;
      }

      // All-months: include every month unconditionally.
      if (orderedAmount != null) allMonthsOrdered += orderedAmount;
      if (salesAmount != null) allMonthsSales += salesAmount;

      // Per-month achievement = sales / plan (RECOMPUTED).
      let achievement: number | null = null;
      if (!notYetRecorded && planAmount != null && planAmount > 0 && salesAmount != null) {
        achievement = salesAmount / planAmount;
      }

      months.push({
        planAmount,
        planCount,
        orderedAmount,
        orderedCount,
        salesAmount,
        salesCount,
        achievement,
        notYetRecorded,
        isAnomaly,
      });
    }

    const ytdAchievement =
      ytdHasData && ytdPlan > 0 ? ytdSales / ytdPlan : null;

    members.push({
      stateHead: currentStateHead,
      name: rawName,
      normKey,
      joinKey: normName(rawName),
      hq,
      contactNumber,
      salary,
      monthlyTarget,
      totalDealers,
      businessPlan,
      ytdOrderBooked: ytdHasData ? ytdOrdered : null,
      // Expose sales whenever there are real sales (even if no plan), or 0 when
      // there is a plan but no sales yet.  Null = truly inactive (no plan, no sales).
      ytdSalesReceived: ytdSales > 0 ? ytdSales : (ytdHasData ? 0 : null),
      ytdPlan: ytdHasData ? ytdPlan : null,
      ytdAchievement,
      allMonthsOrderBooked: allMonthsOrdered,
      allMonthsSalesReceived: allMonthsSales,
      months,
      isPrimaryRole,
      isLeft,
    });
  }

  // ── V4 Arrears Guard ─────────────────────────────────────────────────────────
  // Detect closed months where state heads have not yet entered secondary data.
  //
  // Pattern: the calendar says a month is closed (nowMs > last day) but salesAmount
  // is zero/null across almost all members who have a non-zero plan.  This happens
  // when state heads record data in arrears — typically 1–3 days after month-end.
  //
  // Without this guard, those zero sales get banked into YTD the moment the clock
  // flips past the last day of the month, collapsing achievement incorrectly until
  // the state heads enter their figures.
  //
  // On trigger:
  //   • notYetRecorded is set to true for the arrears month across every member.
  //   • Per-month achievement is suppressed (null).
  //   • Per-member YTD aggregates are recomputed, excluding the arrears month.
  //   • The company-level ytdPlanSum / ytdSalesSum (computed in the loop below)
  //     read m.ytdPlan / m.ytdSalesReceived, so they auto-correct.
  //
  // Threshold: < 15% of plan-holding non-LEFT members have non-zero salesAmount.
  // Floor: require at least 3 plan-holding members to avoid firing on sparse data.
  const ARREARS_MIN_PLAN_MEMBERS = 3;
  const ARREARS_THRESHOLD = 0.15;

  const arrearsMonths = new Set<number>();
  for (let am = 0; am < 12; am++) {
    if (!isMonthClosed(am, fy, nowMs)) continue;

    const planHolders = members.filter(
      (mb) => !mb.isLeft && (mb.months[am]?.planAmount ?? 0) > 0,
    );
    if (planHolders.length < ARREARS_MIN_PLAN_MEMBERS) continue;

    const withSales = planHolders.filter(
      (mb) => (mb.months[am]?.salesAmount ?? 0) > 0,
    );
    const recordedFraction = withSales.length / planHolders.length;

    if (recordedFraction < ARREARS_THRESHOLD) {
      arrearsMonths.add(am);
      logger.warn(
        {
          fy,
          monthIdx: am,
          monthName: MONTH_NAMES[am],
          planHolders: planHolders.length,
          withSales: withSales.length,
          recordedFraction: recordedFraction.toFixed(3),
        },
        "stateDashboard: V4 arrears guard — closed month not yet recorded by state heads",
      );
    }
  }

  if (arrearsMonths.size > 0) {
    for (const mb of members) {
      // Re-flag arrears months as notYetRecorded and suppress per-month achievement.
      for (const am of arrearsMonths) {
        const md = mb.months[am];
        if (md) {
          md.notYetRecorded = true;
          md.achievement = null;
        }
      }
      // Recompute per-member YTD aggregates, excluding arrears months.
      let ytdPlan2 = 0;
      let ytdOrdered2 = 0;
      let ytdSales2 = 0;
      let ytdHasData2 = false;
      for (let am2 = 0; am2 < 12; am2++) {
        const md2 = mb.months[am2];
        if (!md2 || md2.notYetRecorded) continue;
        if (!isMonthClosed(am2, fy, nowMs)) continue;
        if (md2.planAmount != null) { ytdPlan2 += md2.planAmount; ytdHasData2 = true; }
        if (md2.orderedAmount != null) ytdOrdered2 += md2.orderedAmount;
        if (md2.salesAmount != null) ytdSales2 += md2.salesAmount;
      }
      mb.ytdOrderBooked = ytdHasData2 ? ytdOrdered2 : null;
      mb.ytdSalesReceived = ytdSales2 > 0 ? ytdSales2 : (ytdHasData2 ? 0 : null);
      mb.ytdPlan = ytdHasData2 ? ytdPlan2 : null;
      mb.ytdAchievement = ytdHasData2 && ytdPlan2 > 0 ? ytdSales2 / ytdPlan2 : null;
    }
  }

  // ── TOTAL row detection (reconciliation) ─────────────────────────────────────
  // Scan backwards from the end of the sheet to find the grand-total row.
  // The TOTAL row is identified by the string "TOTAL" appearing in ANY cell in
  // the first 20 columns (the sheet may place the label in a column other than
  // the canonical stateHead or teamMember columns).  We read its annual
  // orderBooked and sales columns — the sheet's own computed grand totals —
  // and compare them against our member-level reconstruction.
  let sheetTotalOB: number | null = null;
  let sheetTotalSales: number | null = null;

  // Log detected column positions once per cache fill (useful for diagnosing
  // structural changes in the sheet without triggering a full data dump).
  logger.info(
    {
      fy,
      anchorIdx,
      dataStart,
      colsBusinessPlan: cols.businessPlan,
      colsOrderBooked: cols.orderBooked,
      colsSales: cols.sales,
      colsMonthStart: cols.monthStart,
    },
    "stateDashboard: detected columns",
  );

  // Helper: does a Sheets cell contain a formula error (e.g. "#REF!", "#VALUE!").
  const isFormulaError = (v: SheetCellValue): boolean =>
    typeof v === "string" && v.trimStart().startsWith("#");

  // Pass 1: scan pre-header rows (indices 0 to anchorIdx-1).
  // The SOBR places the grand-total row at row 3 (0-based index 2), ABOVE the
  // column-header row (anchorIdx).  The monthly block columns are blank in the
  // TOTAL row — only the annual YTD columns (cols.orderBooked, cols.sales) carry
  // values.  This is therefore an ANNUAL-ONLY cross-check; it cannot validate
  // monthly or quarterly period selections.
  let totalRowFoundAtIdx: number | null = null;  // rowIdx of the detected TOTAL row, null if not found
  let totalRowHasFormulaErrors = false;

  for (let i = 0; i < anchorIdx; i++) {
    const row = allRows[i] ?? [];
    const isTotalRow = row
      .slice(0, 20)
      .some((c) => typeof c === "string" && c.toUpperCase().includes("TOTAL"));
    if (!isTotalRow) continue;
    totalRowFoundAtIdx = i;
    if (cols.orderBooked >= 0) {
      const rawOB = row[cols.orderBooked];
      if (isFormulaError(rawOB)) {
        totalRowHasFormulaErrors = true;
      } else {
        const v = cellNum(rawOB);
        if (v != null && v > 0) sheetTotalOB = v;
      }
    }
    if (cols.sales >= 0) {
      const rawSales = row[cols.sales];
      if (isFormulaError(rawSales)) {
        totalRowHasFormulaErrors = true;
      } else {
        const v = cellNum(rawSales);
        if (v != null && v > 0) sheetTotalSales = v;
      }
    }
    logger.info(
      {
        fy,
        rowIdx: i,
        rawCells: row.slice(0, 20).map((c) => (c == null || c === "" ? null : String(c).slice(0, 14))),
        readOB: sheetTotalOB,
        readSales: sheetTotalSales,
        source: "pre-header",
        formulaErrors: totalRowHasFormulaErrors,
      },
      "stateDashboard: TOTAL row candidate",
    );
    if (sheetTotalOB != null || sheetTotalSales != null) break;
  }

  // Pass 2: backwards scan from the end — fallback for sheets that place the
  // TOTAL row after the last member row rather than above the header.
  if (totalRowFoundAtIdx == null) {
    for (let i = allRows.length - 1; i >= dataStart; i--) {
      const row = allRows[i] ?? [];
      const isTotalRow = row
        .slice(0, 20)
        .some((c) => typeof c === "string" && c.toUpperCase().includes("TOTAL"));
      if (!isTotalRow) continue;
      totalRowFoundAtIdx = i;
      if (cols.orderBooked >= 0) {
        const rawOB = row[cols.orderBooked];
        if (isFormulaError(rawOB)) {
          totalRowHasFormulaErrors = true;
        } else {
          const v = cellNum(rawOB);
          if (v != null && v > 0) sheetTotalOB = v;
        }
      }
      if (cols.sales >= 0) {
        const rawSales = row[cols.sales];
        if (isFormulaError(rawSales)) {
          totalRowHasFormulaErrors = true;
        } else {
          const v = cellNum(rawSales);
          if (v != null && v > 0) sheetTotalSales = v;
        }
      }
      logger.info(
        {
          fy,
          rowIdx: i,
          rawCells: row.slice(0, 20).map((c) => (c == null || c === "" ? null : String(c).slice(0, 14))),
          readOB: sheetTotalOB,
          readSales: sheetTotalSales,
          source: "post-data",
          formulaErrors: totalRowHasFormulaErrors,
        },
        "stateDashboard: TOTAL row candidate",
      );
      if (sheetTotalOB != null || sheetTotalSales != null) break;
    }
  }

  if (totalRowFoundAtIdx == null) {
    logger.warn(
      { fy, anchorIdx, dataStart, totalRows: allRows.length },
      "stateDashboard: TOTAL row not found in pre-header or post-data scan",
    );
  } else if (sheetTotalOB == null && sheetTotalSales == null) {
    // Row was found but OB/Sales cells were null or formula errors.
    logger.warn(
      {
        fy,
        totalRowIdx: totalRowFoundAtIdx,
        colsOrderBooked: cols.orderBooked,
        colsSales: cols.sales,
        formulaErrors: totalRowHasFormulaErrors,
      },
      totalRowHasFormulaErrors
        ? "stateDashboard: TOTAL row found but OB/Sales cells have formula errors — cross-check blocked; repair sheet formulas at that row"
        : "stateDashboard: TOTAL row found but OB/Sales cells are blank or zero",
    );
  }

  // ── Company-level totals ─────────────────────────────────────────────────────
  // RULE: include EVERY member and EVERY month — no isPrimaryRole exclusion, no
  // anomaly exclusion, no closed-only filter.  These totals must tie exactly to
  // the sheet's own TOTAL row.  Achievement is recomputed from the sums (never
  // copied from the sheet's achievement column).
  let totalPlan = 0;
  let totalOrderBooked = 0;
  let totalSalesReceived = 0;
  let totalDealers = 0;
  let ytdPlanSum = 0;
  let ytdSalesSum = 0;

  for (const m of members) {
    if (m.totalDealers != null) totalDealers += m.totalDealers;
    if (m.businessPlan != null) totalPlan += m.businessPlan;
    // allMonths* covers every month (open+closed, anomalous included).
    totalOrderBooked += m.allMonthsOrderBooked;
    totalSalesReceived += m.allMonthsSalesReceived;
    // YTD achievement: numerator and denominator are symmetric — both sides
    // cover ALL members (active + left).  Left-section members' actual sales
    // while active count in the numerator; their plan (businessPlan fallback
    // when ytdPlan is blank) counts in the denominator.  This gives the true
    // company-wide achievement rate against the full plan as set at FY start.
    // ytdSalesReceived is null only for truly inactive members (no plan, no
    // sales at all) — those contribute 0 to both sides, which is correct.
    const planForDenom = m.ytdPlan ?? m.businessPlan;
    if (planForDenom != null) ytdPlanSum += planForDenom;
    ytdSalesSum += m.ytdSalesReceived ?? 0;
  }

  const ytdAchievement = ytdPlanSum > 0 ? ytdSalesSum / ytdPlanSum : null;

  // Reconciliation: warn when our member-level reconstruction diverges from
  // the sheet's TOTAL row.  A gap > ₹1 000 is a sign that rows are being missed.
  if (sheetTotalOB != null && Math.abs(sheetTotalOB - totalOrderBooked) > 1000) {
    logger.warn(
      {
        fy,
        sheetOB: Math.round(sheetTotalOB),
        computedOB: Math.round(totalOrderBooked),
        gapOB: Math.round(sheetTotalOB - totalOrderBooked),
      },
      "stateDashboard: computed OB does not tie to sheet TOTAL row",
    );
  }
  if (sheetTotalSales != null && Math.abs(sheetTotalSales - totalSalesReceived) > 1000) {
    logger.warn(
      {
        fy,
        sheetSales: Math.round(sheetTotalSales),
        computedSales: Math.round(totalSalesReceived),
        gapSales: Math.round(sheetTotalSales - totalSalesReceived),
      },
      "stateDashboard: computed Sales does not tie to sheet TOTAL row",
    );
  }

  logger.info(
    {
      fy,
      tab: tabName,
      members: members.length,
      primaryRole: [...primaryRoleKeys].length,
      anomalies: anomalies.length,
      totalPlan: Math.round(totalPlan),
      totalOrderBooked: Math.round(totalOrderBooked),
      totalSalesReceived: Math.round(totalSalesReceived),
      sheetTotalOB: sheetTotalOB != null ? Math.round(sheetTotalOB) : null,
      sheetTotalSales: sheetTotalSales != null ? Math.round(sheetTotalSales) : null,
      ytdAchievementPct: ytdAchievement != null ? `${(ytdAchievement * 100).toFixed(1)}%` : null,
    },
    "stateDashboard: loaded",
  );

  const sheetTotals =
    sheetTotalOB != null || sheetTotalSales != null
      ? { orderBooked: sheetTotalOB, salesReceived: sheetTotalSales }
      : null;

  const result: SecDashboard = {
    fy,
    sheetId,
    tabName,
    members,
    primaryRoleKeys,
    primaryRoleNames,
    totalPlan,
    totalOrderBooked,
    totalSalesReceived,
    totalDealers,
    ytdAchievement,
    arrearsMonths: arrearsMonths.size > 0 ? [...arrearsMonths].sort((a, b) => a - b) : undefined,
    sheetTotals,
    anomalies,
    rowsRead: allRows.length,
    loadedAt: Date.now(),
  };

  if (!skipPersist) {
    _cache.set(fy, result);
    // Persist to DB so cold-restart loads for closed FYs never need Sheets.
    // Fire-and-forget: a DB write failure must never block the response.
    saveStateDashboardSnapshot(result).catch(() => {/* already logged */});
  }
  return result;
}
