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
import {
  computeVisitPlan,
  type VisitPlan,
  type HistoricalFyCapacity,
} from "./visitPlan.js";
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

// Per-month actuals from the member's own FY tab (e.g. '2026-2027').
// Plan = monthly plan figure; orderBooking / sale = actuals for that month.
export type MonthActual = {
  month: string;             // "Apr" | "May" | ... | "Mar"
  plan: number | null;
  orderBooking: number | null;
  sale: number | null;
};

export type MemberSheetResult = {
  fileId: string;
  tabName: string;
  rows: RetailerRow[];
  spread: RetailerSpread;
  visitPlan: VisitPlan;
  months: MonthActual[];     // Per-month actuals from the FY tab (may be empty)
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

// ── Historical FY capacity (Phase 3-C) ────────────────────────────────────────
// Reads prior-FY "Summary Report <FY>" tabs with full header detection so that
// the totalVisit and visitsRequired columns are always matched by name, never
// by hardcoded column letter. Two sheets can carry these columns at different
// positions across FYs; header detection resolves them independently each time.

// Parse a fiscal year string (e.g. "2024-25", "2025-2026") from a tab title.
function parseFyFromTabTitle(title: string): string | null {
  // Long form: "2024-25" or "2024-2025"
  const m = title.match(/(20\d{2})[- ](20)?(\d{2})/);
  if (m) return `${m[1]}-${m[3]}`;
  // Short form: "24-25"
  const m2 = title.match(/(\d{2})-(\d{2})/);
  if (m2) return `20${m2[1]}-${m2[2]}`;
  return null;
}

// Read one prior-FY summary tab and return visit totals derived via
// header-detected column positions (not DEFAULT_COL fallback).
//
// DETECTION RULES (historical tabs only):
//   1. Find the header row by probing cols 2-3 for a text identity value.
//   2. REQ synonyms are checked BEFORE VISIT synonyms in every pass so that
//      headers like "NO OF VISITS REQD" go to reqCol, not visitCol.
//   3. Extended REQ synonyms cover "NOOFVISITSREQ*" patterns that the main
//      detectColumns prefix scan would accidentally assign to totalVisit.
//   4. If either visitCol or reqCol cannot be resolved, return null (we never
//      fall back to DEFAULT_COL positions, which are wrong for historical tabs).
async function readHistoricalFySummary(
  fileId: string,
  tabTitle: string,
  fy: string,
): Promise<HistoricalFyCapacity | null> {
  let allRows: SheetCellValue[][];
  try {
    allRows = await readAllTabRows(fileId, tabTitle);
  } catch (err) {
    logger.warn({ err, fileId, tabTitle }, "memberSheet: historical tab read failed");
    return null;
  }

  // ── Inline column detection ──────────────────────────────────────────────
  // REQ must be listed before VISIT in every scan pass so columns titled
  // "NO. OF VISITS REQD" are NOT consumed by the NOOFVISIT VISIT prefix.
  const VISIT_SYNS: string[] = [
    "TOTALVISIT","TOTALVISITS","NOOFVISIT","NOOFVISITS",
    "VISITCOUNT","ACTUALVISIT","ACTUALVISITS",
  ];
  const REQ_SYNS: string[] = [
    "VISITSREQUIRED","VISITREQ","REQUIREDVISIT","VISITREQUIRED",
    "VISITSREQD","REQUIREDVISITS","VISITREQUD",
    // Extended: "NO OF VISITS REQD" → "NOOFVISITSREQD", "NO OF VISIT REQ" → "NOOFVISITREQ"
    "NOOFVISITSREQ","NOOFVISITSREQD","NOOFVISITREQ","NOOFVISITREQD",
  ];
  const NAME_EXACT: Set<string> = new Set([
    "RETAILER","PARTYNAME","RETAILERNAME","NAME","CUSTOMER","PARTY",
  ]);

  let headerRowIndex = -1;
  let nameCol: number = DEFAULT_COL.name; // identity col — stable across FYs
  let visitCol: number | null = null;
  let reqCol:   number | null = null;
  let hRow: SheetCellValue[] = [];

  for (let i = 0; i < Math.min(allRows.length, 15); i++) {
    const row = allRows[i] ?? [];
    const probe = normHeader(row[2] ?? row[3] ?? "");
    const isHeader =
      probe.length >= 2 &&
      !/^\d+$/.test(probe) &&
      (probe.includes("RETAILER") || probe.includes("PARTY") ||
       probe.includes("NAME") || probe === "SL" ||
       probe === "SR" || probe === "SNO" || probe === "SRNO");
    if (!isHeader) continue;

    headerRowIndex = i;
    hRow = row;

    // Pass 1 — exact match; REQ before VISIT to prevent greedy capture.
    for (let c = 0; c < row.length; c++) {
      const h = normHeader(row[c]);
      if (!h) continue;
      if (NAME_EXACT.has(h) && nameCol === DEFAULT_COL.name) nameCol = c;
      if (reqCol   === null && REQ_SYNS.includes(h))   reqCol   = c;
      if (visitCol === null && VISIT_SYNS.includes(h)) visitCol = c;
    }

    // Pass 2 — prefix match (only for unresolved columns).
    if (visitCol === null || reqCol === null) {
      for (let c = 0; c < row.length; c++) {
        const h = normHeader(row[c]);
        if (!h) continue;
        // Check REQ first so "NOOFVISITSREQD" → reqCol, not visitCol.
        if (reqCol === null && REQ_SYNS.some(s => h.startsWith(s))) {
          reqCol = c;
          continue; // prevent same column from also matching VISIT
        }
        if (visitCol === null && VISIT_SYNS.some(s => h.startsWith(s))) {
          visitCol = c;
        }
      }
    }
    break;
  }

  // Log the header row so column mapping can be audited in the server log.
  const headerSample = hRow.slice(0, 32).map((v, i) => `[${i}]${normHeader(v)}`).join(" ");

  if (headerRowIndex < 0) {
    logger.warn({ tabTitle, fy }, "memberSheet: no header row in historical tab");
    return null;
  }
  if (visitCol === null || reqCol === null) {
    logger.warn(
      { tabTitle, fy, visitCol, reqCol, headerSample },
      "memberSheet: totalVisit or visitsReq column not detected in historical tab — skipping",
    );
    return null;
  }

  logger.info(
    { tabTitle, fy, visitCol, reqCol, nameCol, headerSample },
    "memberSheet: historical tab columns resolved",
  );

  // ── Row scan ──────────────────────────────────────────────────────────────
  // Use +1 (not +2) so that historical tabs without a sub-header row do not
  // lose their first data row. SKIP_TOKENS + blank guard filter sub-headers.
  const dataStart = headerRowIndex + 1;
  const STOP_TOKENS = new Set(["TOTAL", "GRANDTOTAL", "SUBTOTAL"]);
  const SKIP_TOKENS = new Set([
    "RETAILERNAME","RETAILER","NAME",
    "SRLNO","SL","SR","NO","SNO","SRNO",
  ]);

  let totalRetailers      = 0;
  let totalVisitsDone     = 0;
  let totalVisitsRequired = 0;
  let blankRun            = 0;

  for (let i = dataStart; i < allRows.length; i++) {
    const row     = allRows[i] ?? [];
    const rawName = cellStr(row[nameCol]);

    if (!rawName) {
      blankRun++;
      if (blankRun >= 3) break;
      continue;
    }
    blankRun = 0;

    const nameNorm = normHeader(rawName);
    if (
      STOP_TOKENS.has(nameNorm) ||
      nameNorm.startsWith("GRANDTOTAL") ||
      nameNorm.startsWith("TOTAL")
    ) break;
    if (SKIP_TOKENS.has(nameNorm)) continue;
    if (/^\d+$/.test(rawName.trim())) continue;

    totalRetailers++;
    totalVisitsDone     += cellNum(row[visitCol]) ?? 0;
    totalVisitsRequired += cellNum(row[reqCol])   ?? 0;
  }

  const coveragePct =
    totalVisitsRequired > 0
      ? (totalVisitsDone / totalVisitsRequired) * 100
      : 0;

  logger.info(
    {
      tabTitle, fy,
      totalRetailers, totalVisitsRequired, totalVisitsDone,
      coveragePct: Math.round(coveragePct * 10) / 10,
      visitCol, reqCol,
    },
    "memberSheet: historical FY capacity",
  );

  return { fy, totalRetailers, totalVisitsRequired, totalVisitsDone, coveragePct };
}

// Find and read all prior-FY summary tabs (using a single listSheetTabs call).
async function loadHistoricalCapacity(
  fileId: string,
  tabs: { title: string }[],
  currentFy: string,
): Promise<HistoricalFyCapacity[]> {
  const priorTabs = tabs.filter((t) => {
    if (!t.title.toUpperCase().startsWith(SUMMARY_TAB_PREFIX)) return false;
    const fy = parseFyFromTabTitle(t.title);
    return fy !== null && fy !== currentFy;
  });

  const results = await Promise.all(
    priorTabs.map((t) => {
      const fy = parseFyFromTabTitle(t.title)!;
      return readHistoricalFySummary(fileId, t.title, fy);
    }),
  );

  return results.filter((r): r is HistoricalFyCapacity => r !== null);
}

// ── Tab finder ────────────────────────────────────────────────────────────────
// Prefers the tab whose name contains the FY year hint (most specific).
// Falls back to the longest tab name starting with the prefix.
// Returns both the selected tab title and the full tab list so the caller
// can reuse it for historical capacity reads without a second listSheetTabs call.

type TabInventory = {
  selectedTab: string | null;
  allTabs: { title: string }[];
};

async function findSummaryTabWithInventory(
  fileId: string,
  fy: string,
): Promise<TabInventory> {
  let allTabs: { title: string }[];
  try {
    allTabs = await listSheetTabs(fileId);
  } catch (err) {
    logger.warn({ err, fileId }, "memberSheet: listSheetTabs failed");
    return { selectedTab: null, allTabs: [] };
  }

  const p = SUMMARY_TAB_PREFIX;
  const matches = allTabs.filter((t) => t.title.toUpperCase().startsWith(p));

  logger.info(
    { fileId, fy, allTabs: allTabs.map((t) => t.title), summaryMatches: matches.map((t) => t.title) },
    "memberSheet: tab candidates",
  );

  if (matches.length === 0) return { selectedTab: null, allTabs };

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
    return { selectedTab: fyMatch.title, allTabs };
  }

  // Fall back to the longest matching tab (more specific is better).
  const fallback = [...matches].sort((a, b) => b.title.length - a.title.length)[0]!;
  logger.info(
    { tab: fallback.title, reason: "no FY match; using longest" },
    "memberSheet: fallback tab selected",
  );
  return { selectedTab: fallback.title, allTabs };
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

// ── FY monthly tab reader (replaces readAnnualBp) ────────────────────────────
//
// Reads the member's own FY tab (e.g. '2026-2027') and returns:
//   - annualBp   : first large number found (5M–200M range)
//   - months     : per-month Plan / Order Booking / Sale Received rows
//
// The tab typically has a header row containing PLAN / ORDER / SALE keywords,
// followed by month rows (Apr, May, …, Mar).  When header detection fails,
// a positional scan is used for the numbers after each month-name cell.

const FY_MONTHS_UPPER = ["APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC","JAN","FEB","MAR"] as const;
const FY_MONTH_LABELS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"] as const;

async function readFyMonthlyTab(
  fileId: string,
  fyLabel: string,
  allTabs: { title: string }[],
): Promise<{ annualBp: number | null; months: MonthActual[] }> {
  const empty = { annualBp: null, months: [] as MonthActual[] };
  try {
    const normalFy = fyLabel.replace(/-/g, "").replace(/\s/g, "");
    const hit = allTabs.find(
      (t) => t.title.replace(/-/g, "").replace(/\s/g, "") === normalFy,
    );
    if (!hit) return empty;

    const rows = await readAllTabRows(fileId, hit.title);

    // ── Header detection (first 20 rows) ──────────────────────────────────
    let headerIdx = -1;
    let planCol = -1, obCol = -1, saleCol = -1, monthCol = -1;

    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const row = rows[i] ?? [];
      const nh = row.map((c) => normHeader(c));

      const hasObLike   = nh.some((h) => h.startsWith("ORDER") || h === "OB");
      const hasSaleLike = nh.some((h) => h.startsWith("SALE"));

      if (hasObLike || hasSaleLike) {
        headerIdx = i;
        for (let c = 0; c < row.length; c++) {
          const h = nh[c];
          if (!h) continue;
          if (monthCol < 0 && (h === "MONTH" || h === "MONTHS")) monthCol = c;
          if (planCol  < 0 && (h === "PLAN" || h === "TARGET" || h === "BUSINESSPLAN" || h === "MONTHLYPLAN")) planCol = c;
          if (obCol    < 0 && (h.startsWith("ORDER") || h === "OB")) obCol = c;
          if (saleCol  < 0 && h.startsWith("SALE")) saleCol = c;
        }
        break;
      }
    }

    // ── Row scan ──────────────────────────────────────────────────────────
    const months: MonthActual[] = [];
    let annualBp: number | null = null;
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i] ?? [];

      // Detect month name in first 5 columns.
      let mIdx = -1, mCol = -1;
      for (let c = 0; c < Math.min(row.length, 5); c++) {
        const h = normHeader(row[c]).slice(0, 3);
        const idx = FY_MONTHS_UPPER.indexOf(h as (typeof FY_MONTHS_UPPER)[number]);
        if (idx >= 0) { mIdx = idx; mCol = c; break; }
      }

      if (mIdx >= 0) {
        let plan: number | null = null;
        let ob: number | null   = null;
        let sale: number | null = null;

        if (planCol >= 0 && obCol >= 0 && saleCol >= 0) {
          // Use header-detected positions.
          plan = cellNum(row[planCol]);
          ob   = cellNum(row[obCol]);
          sale = cellNum(row[saleCol]);
        } else {
          // Positional: first three numeric values after the month name cell.
          // Only accept values > 1 000 to filter out counts / percentages.
          const nums: number[] = [];
          for (let c = mCol + 1; c < row.length && nums.length < 3; c++) {
            const n = cellNum(row[c]);
            if (n !== null && n > 1000) nums.push(n);
          }
          if (nums.length >= 1) plan = nums[0];
          if (nums.length >= 2) ob   = nums[1];
          if (nums.length >= 3) sale = nums[2];
        }

        // Skip rows where all detected values are null or implausibly small (< 1 000).
        // These are most likely false-positive matches (count/percentage cells near a month name).
        const allNull  = plan === null && ob === null && sale === null;
        const allSmall = !allNull && [plan, ob, sale].every((n) => n === null || n < 1000);
        if (allNull || allSmall) continue;

        months.push({ month: FY_MONTH_LABELS[mIdx], plan, orderBooking: ob, sale });
      } else if (annualBp === null && i < 20) {
        // Scan non-month rows in the first 20 for a plausible annual BP.
        // Skip TOTAL / GRAND TOTAL rows — they may not foot (direct-dealer OB
        // counted twice, etc.) and would silently overstate the plan.
        const firstLabel = normHeader(row.find((c) => (cellStr(c) || "").trim() !== "") ?? "");
        if (firstLabel.startsWith("TOTAL") || firstLabel.startsWith("GRANDTOTAL")) continue;
        for (const cell of row.slice(0, 15)) {
          const n = cellNum(cell);
          if (n !== null && n >= 5_000_000 && n <= 200_000_000) {
            annualBp = n; break;
          }
        }
      }
    }

    logger.info(
      { fileId, fyLabel, headerIdx, monthCount: months.length, planCol, obCol, saleCol },
      "memberSheet: FY monthly tab parsed",
    );

    return { annualBp, months };
  } catch (err) {
    logger.warn({ err, fileId, fyLabel }, "memberSheet: FY monthly tab read failed");
    return empty;
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

  logger.info({ memberKey, memberName, fy, fileId }, "memberSheet: resolved fileId for member");

  const { selectedTab: tabName, allTabs } = await findSummaryTabWithInventory(fileId, fy);
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

  // Read FY monthly tab and historical capacity in parallel to minimise latency.
  // readFyMonthlyTab reuses allTabs (already fetched) so it does not make a
  // second listSheetTabs call.
  const fyTabLabel = fy === "2026-27" ? "2026-2027" : `20${fy.replace("-", "-20")}`;
  const [fyMonthData, historicalCapacity] = await Promise.all([
    readFyMonthlyTab(fileId, fyTabLabel, allTabs),
    loadHistoricalCapacity(fileId, allTabs, fy),
  ]);
  // Phase 2-C: the col-W sum (retailer rows, Summary Report tab) is authoritative.
  // Only fall back to the FY-tab scan when the Summary Report had no plan column
  // (colWSum = 0 → spread.annualBusinessPlan = null).  Never let the FY tab's
  // TOTAL row — which may not foot — overwrite a good per-row sum.
  if (spread.annualBusinessPlan === null) {
    spread.annualBusinessPlan = fyMonthData.annualBp ?? null;
  }

  const visitPlan = computeVisitPlan(rows, fy, historicalCapacity);

  return {
    fileId,
    tabName,
    rows,
    spread,
    visitPlan,
    months: fyMonthData.months,
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
