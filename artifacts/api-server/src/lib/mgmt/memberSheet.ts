// Member's own working sheet reader — source B for Sales Deep Dive Phase 2.
//
// Each field representative has a personal Google Sheets workbook.
// This module reads the 'Summary Report 2026-27' tab, parses the retailer-level
// order booking, sale, visit count, and business plan for that member, then
// computes spread/concentration metrics.
//
// Column layout (0-indexed, col A = 0):
//   C(2)  = Retailer name
//   D(3)  = District
//   E(4)  = City
//   F(5)  = Assigned distributor
//   G(6)  = Distance km
//   W(22) = Business Plan (per retailer)
//   X(23) = Visits Required
//   Z(25) = Order Booking (NET, Sub Total)
//   AA(26)= Sale received
//   AB(27)= Total Visits (YTD cumulative)
//   AD(29)= Achievement % — parsed but NEVER used for computation; recomputed.
//
// Tab layout:
//   Row 5 (1-indexed) = header row → 0-indexed row 4
//   Row 4 (1-indexed) = TOTAL row  → 0-indexed row 3  (read but not used — we re-sum)
//   Row 7 (1-indexed) = first retailer data row → 0-indexed row 6
//
// Annual Business Plan:
//   Read from the member's '2026-2027' tab (cell that has the FY BP figure).
//   The Summary Report col-W sum can differ from this figure; always prefer the
//   '2026-2027' tab value where available.
//
// Member→fileId map:
//   Statically imported from config/member_sheet_map.json.
//   Key = normSecKey(member name) — lowercase alphanumeric, parentheticals kept.
//   Add new members to that file; no code change needed.
//
// Rules (same as Phase 1):
//   NET = Sub Total, never Order Total.
//   Achievement always recomputed (OB / businessPlan); never read from sheet %.
//   Google Drive strictly read-only.
//   Never console.log — use logger.
//   Config JSON statically imported (esbuild bundles it; no cwd-relative reads).

import memberSheetMapRaw from "../../config/member_sheet_map.json" assert { type: "json" };
import { logger } from "../logger.js";
import {
  readAllTabRows,
  listSheetTabs,
  type SheetCellValue,
} from "../registers/sheetsApi.js";

// ── Config ────────────────────────────────────────────────────────────────────

// Drop the _comment key before use.
const MEMBER_FILE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(memberSheetMapRaw as Record<string, string>).filter(
    ([k]) => k !== "_comment",
  ),
);

// Tab name patterns for the summary report (startsWith match).
const SUMMARY_TAB_PREFIX = "SUMMARY REPORT";

// ── Column indices (0-indexed) ────────────────────────────────────────────────
// Fixed by the sheet's design — not header-detected because the header row can
// contain merged cells that confuse positional lookup.  If the tab is ever
// restructured, update these constants.

const COL = {
  name:         2,   // C — Retailer name
  district:     3,   // D — District
  city:         4,   // E — City
  distributor:  5,   // F — Assigned distributor
  distanceKm:   6,   // G — Distance km
  businessPlan: 22,  // W — Business Plan (per retailer, annual)
  visitsReq:    23,  // X — Visits Required
  orderBooking: 25,  // Z — Order Booking (NET)
  sale:         26,  // AA — Sale received
  totalVisit:   27,  // AB — Total Visits (YTD)
  achPct:       29,  // AD — Achievement % — NEVER use in computation
} as const;

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
  orderBooking: number;           // 0 when cell is blank
  sale: number;                   // 0 when cell is blank
  totalVisit: number | null;
  // RECOMPUTED — never read from the AD column
  achievementPct: number | null;
  isActive: boolean;              // OB > 0 OR Sale > 0
};

export type RetailerSpread = {
  // Counts
  totalRetailers: number;
  activeRetailers: number;        // OB > 0 OR sale > 0
  dormantRetailers: number;       // OB == 0 AND sale == 0
  activePct: number;              // activeRetailers / totalRetailers × 100
  // Totals (re-summed; never read from the sheet's TOTAL row)
  totalOrderBooking: number;
  totalSale: number;
  totalVisits: number | null;     // null when AB column has no data
  // Spread / concentration
  top5ObShare: number | null;     // top-5 retailers' OB / total OB × 100
  top10ObShare: number | null;
  concentrationIndex: number | null; // HHI: sum of (share)^2 × 10000; 0–10000
  // Per-unit metrics
  businessPerActiveRetailer: number | null; // totalOB / activeRetailers
  businessPerVisit: number | null;          // totalOB / totalVisits
  // Annual Business Plan (from the '2026-2027' tab, preferred over col-W sum)
  annualBusinessPlan: number | null;
};

export type MemberSheetResult = {
  fileId: string;
  tabName: string;
  rows: RetailerRow[];
  spread: RetailerSpread;
  rowsRead: number;
};

export type MemberSheetData =
  | ({ status: "ok" } & MemberSheetResult)
  | { status: "not-mapped"; error: string }
  | { status: "error"; error: string };

// ── In-process cache ──────────────────────────────────────────────────────────

const TTL_MS = 15 * 60_000;
const _cache = new Map<string, { data: MemberSheetResult; loadedAt: number }>();
const _inFlight = new Map<string, Promise<MemberSheetResult | null>>();

export function invalidateMemberSheetCache(normKey?: string): void {
  if (normKey) _cache.delete(normKey);
  else _cache.clear();
}

// ── Tab finder ────────────────────────────────────────────────────────────────

async function findTab(
  fileId: string,
  prefix: string,
): Promise<string | null> {
  try {
    const tabs = await listSheetTabs(fileId);
    const p = prefix.toUpperCase();
    const hit = tabs.find((t) => t.title.toUpperCase().startsWith(p));
    return hit?.title ?? null;
  } catch (err) {
    logger.warn({ err, fileId, prefix }, "memberSheet: listSheetTabs failed");
    return null;
  }
}

// ── Annual BP reader (from '2026-2027' tab) ───────────────────────────────────
// Reads the '2026-2027' tab and looks for the largest single numeric value
// that plausibly represents an annual business plan (1 Cr – 20 Cr range).
// If the tab or value is absent, falls back to the col-W sum from the summary.

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
    // Scan first 20 rows for a value in the annual-BP range (50L – 20 Cr).
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

  // Find the summary report tab (startsWith).
  const tabName = await findTab(fileId, SUMMARY_TAB_PREFIX);
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

  // Retailer data starts at row index 6 (row 7, 1-indexed).
  const DATA_START = 6;

  // Scan for the actual data start: skip header, any TOTAL row, and blank rows.
  // We look for rows where column C (name) is non-empty and not a header token.
  const SKIP_TOKENS = new Set([
    "RETAILERNAME", "RETAILER", "NAME", "TOTAL", "GRANDTOTAL",
    "SRLNO", "SL", "SR", "NO",
  ]);

  const rows: RetailerRow[] = [];

  for (let i = DATA_START; i < allRows.length; i++) {
    const row = allRows[i] ?? [];
    const rawName = cellStr(row[COL.name]);
    if (!rawName) continue;

    const nameNorm = normHeader(rawName);
    if (SKIP_TOKENS.has(nameNorm) || nameNorm.startsWith("TOTAL")) continue;
    // Skip serial numbers (all-digit names).
    if (/^\d+$/.test(rawName)) continue;

    const ob   = cellNum(row[COL.orderBooking]) ?? 0;
    const sale = cellNum(row[COL.sale]) ?? 0;
    const plan = cellNum(row[COL.businessPlan]);

    // Achievement recomputed — never read from AD.
    const achPct =
      plan !== null && plan > 0 ? (ob / plan) * 100 : null;

    rows.push({
      name:         rawName,
      district:     cellStr(row[COL.district]) || null,
      city:         cellStr(row[COL.city]) || null,
      distributor:  cellStr(row[COL.distributor]) || null,
      distanceKm:   cellNum(row[COL.distanceKm]),
      businessPlan: plan,
      visitsRequired: cellNum(row[COL.visitsReq]),
      orderBooking: ob,
      sale,
      totalVisit:   cellNum(row[COL.totalVisit]),
      achievementPct: achPct,
      isActive:     ob > 0 || sale > 0,
    });
  }

  logger.info(
    { memberKey, tabName, retailers: rows.length },
    "memberSheet: retailers parsed",
  );

  // ── Compute spread metrics ─────────────────────────────────────────────────
  const spread = computeSpread(rows, fileId, fy, memberName);

  // Try to fetch the annual BP from the '2026-2027' tab concurrently.
  const fyTabLabel = fy === "2026-27" ? "2026-2027" : `20${fy.replace("-", "-20")}`;
  const annualBp = await readAnnualBp(fileId, fyTabLabel);
  spread.annualBusinessPlan = annualBp ?? spread.annualBusinessPlan;

  return {
    fileId,
    tabName,
    rows,
    spread,
    rowsRead: allRows.length,
  };
}

function computeSpread(
  rows: RetailerRow[],
  fileId: string,
  fy: string,
  memberName: string,
): RetailerSpread {
  const active   = rows.filter((r) => r.isActive);
  const dormant  = rows.filter((r) => !r.isActive);

  const totalOB   = rows.reduce((s, r) => s + r.orderBooking, 0);
  const totalSale = rows.reduce((s, r) => s + r.sale, 0);

  // Total visits — null when every retailer has null AB.
  const visitRows = rows.filter((r) => r.totalVisit !== null);
  const totalVisits =
    visitRows.length > 0
      ? visitRows.reduce((s, r) => s + (r.totalVisit ?? 0), 0)
      : null;

  // Top-N OB concentration (sort active retailers by OB desc).
  const sorted = [...active].sort((a, b) => b.orderBooking - a.orderBooking);
  const top5Ob  = sorted.slice(0, 5).reduce((s, r) => s + r.orderBooking, 0);
  const top10Ob = sorted.slice(0, 10).reduce((s, r) => s + r.orderBooking, 0);

  const top5Share  = totalOB > 0 ? (top5Ob / totalOB) * 100 : null;
  const top10Share = totalOB > 0 ? (top10Ob / totalOB) * 100 : null;

  // HHI concentration index: sum of squared shares × 10000.
  // 10000 = monopoly (one retailer takes all OB), ~0 = perfectly dispersed.
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

  // Annual BP: col-W sum as initial value; may be overridden later from the FY tab.
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
    totalRetailers: rows.length,
    activeRetailers: active.length,
    dormantRetailers: dormant.length,
    activePct: rows.length > 0 ? (active.length / rows.length) * 100 : 0,
    totalOrderBooking: totalOB,
    totalSale,
    totalVisits,
    top5ObShare: top5Share,
    top10ObShare: top10Share,
    concentrationIndex: hhi,
    businessPerActiveRetailer: businessPerActive,
    businessPerVisit,
    annualBusinessPlan: colWSum > 0 ? colWSum : null,
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

  // Cache lookup.
  const cacheKey = `${memberKey}|${fy}`;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) {
    return { status: "ok", ...hit.data };
  }

  // Deduplicate in-flight requests.
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
