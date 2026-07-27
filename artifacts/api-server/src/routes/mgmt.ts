// Management Reports: filter options + Excel generation.
import { Router, type IRouter, type Request, type Response } from "express";
import { loadRoster, mgmtSources } from "../lib/mgmt/roster.js";
import { resolveOrderFileId, getOrderLoadStatus } from "../lib/mgmt/orders.js";
import {
  buildManagementWorkbook,
  assembleRows,
  regionMap,
  type ReportFilters,
} from "../lib/mgmt/report.js";
import { loadTargetsForFy, type TargetRow } from "../lib/mgmt/targets.js";
import { loadHrSfaDashboard, type HrSfaRecord } from "../lib/mgmt/hrSfaDashboard.js";
import { runVerify, hasVerifyAnchors, verifyFyList } from "../lib/mgmt/verify.js";
import {
  loadPartyBridge,
  invalidatePartyBridgeCache,
  startBridgeBuild,
  getBridgeBuildState,
} from "../lib/mgmt/bridge.js";
import { loadStateHeadSale } from "../lib/mgmt/stateHeadSale.js";
import { loadOrderBookSaleByHead } from "../lib/mgmt/orderBookSale.js";
import { loadFactoryPending } from "../lib/mgmt/factoryPending.js";
import {
  getDistributorTmMapIfReady,
  loadDistributorTmMap,
} from "../lib/mgmt/distributorTmMap.js";
import {
  loadPrimaryAttribution,
  type PrimaryAttributionDiagnostics,
} from "../lib/mgmt/primaryAttribution.js";
import { loadPrimarySheetData } from "../lib/mgmt/primarySheets.js";
import {
  loadStateDashboard,
  type SecMember,
} from "../lib/mgmt/stateDashboard.js";
import { loadDeepDiveData, normSecKey } from "../lib/mgmt/deepDiveData.js";
import { splitAnnualToMonth, getSeasonalCalibration } from "../lib/seasonal.js";
import {
  buildPrimaryTargetMapFromStateTargets,
  periodTarget as dbPeriodTarget,
} from "../lib/mgmt/primaryTargets.js";
import { normName } from "../lib/mgmt/names.js";
import {
  db,
  distributorTierOverrideTable,
  insertDistributorTierOverrideSchema,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2025-26";

// ── Response cache for GET /mgmt/data ────────────────────────────────────────
// Assembling rows requires large Sheets reads (up to 380 k rows per FY).
// This cache serves repeat loads instantly; it is invalidated when a new
// dashboard xlsx is uploaded so target data is always fresh.
type MgmtDataPayload = { rows: unknown[]; meta: Record<string, unknown> };
const _mgmtDataCache = new Map<string, { payload: MgmtDataPayload; expiresAt: number }>();
const MGMT_DATA_TTL_MS = 30 * 60 * 1000; // 30 minutes

function mgmtDataCacheKey(fy: string, from: number, to: number): string {
  return `${fy}|${from}|${to}`;
}

export function invalidateMgmtDataCache(fy?: string): void {
  if (fy) {
    for (const key of _mgmtDataCache.keys()) {
      if (key.startsWith(`${fy}|`)) _mgmtDataCache.delete(key);
    }
  } else {
    _mgmtDataCache.clear();
  }
}

// Checks whether any targets have been saved in the Target Master sheet for
// the default FY. The sheet is read-only like all other Sheets sources.
async function targetsSource(req: Request): Promise<{
  key: string;
  name: string;
  status: string;
  detail: string;
}> {
  try {
    const map = await loadTargetsForFy(DEFAULT_FY);
    if (map.size > 0) {
      return {
        key: "targets",
        name: "Targets and business plans",
        status: "connected",
        detail: `${map.size} member target${map.size === 1 ? "" : "s"} saved in the Prayag Target Master sheet for ${DEFAULT_FY}. Achievement % columns fill from these.`,
      };
    }
    return {
      key: "targets",
      name: "Targets and business plans",
      status: "partial",
      detail:
        "The Prayag Target Master sheet is connected but has no saved targets for the current year yet. Set them in the Targets tab.",
    };
  } catch (err) {
    req.log.warn({ err }, "target master status check failed");
    return {
      key: "targets",
      name: "Targets and business plans",
      status: "missing",
      detail:
        "The Prayag Target Master sheet could not be read. Target and achievement % columns stay blank until it is reachable.",
    };
  }
}

router.get("/mgmt/options", async (req: Request, res: Response): Promise<void> => {
  try {
    // Roster load may fail when Google Sheets is unreachable; degrade gracefully.
    let roster: Awaited<ReturnType<typeof loadRoster>> | null = null;
    try {
      roster = await loadRoster();
    } catch (rErr) {
      req.log.warn({ err: rErr }, "roster unavailable for mgmt options; using empty fallback");
    }
    const cfg = mgmtSources();
    const fys = Object.keys(cfg.secondary_order_booking.files_by_year).sort().reverse();
    const states = roster
      ? [...new Set(roster.members.map((m) => m.state).filter(Boolean))].sort()
      : [];
    // Cheap folder check only — never trigger a full 380k-row read here. If a
    // report build already recorded a precise load status, surface that.
    let ordersStatus: string;
    let ordersDetail: string;
    const recorded = getOrderLoadStatus(DEFAULT_FY);
    if (recorded && recorded.status !== "no-file") {
      ordersStatus = recorded.status === "ok" ? "connected" : "partial";
      ordersDetail =
        recorded.status === "ok"
          ? `Order booking workbook connected for ${DEFAULT_FY} (${recorded.rowsRead ?? 0} rows read). Earlier years (2021-22 to 2025-26) are connected.`
          : `${recorded.detail} Earlier years (2021-22 to 2025-26) are connected.`;
    } else {
      try {
        const currentFyFile = await resolveOrderFileId(DEFAULT_FY);
        ordersStatus = currentFyFile ? "connected" : "partial";
        ordersDetail = currentFyFile
          ? "Order booking workbooks found for the selected years."
          : `No ${DEFAULT_FY} order booking workbook exists in the Drive folder yet; ${DEFAULT_FY} order columns will be blank until it is created. Earlier years (2021-22 to 2025-26) are connected.`;
      } catch (err) {
        req.log.warn({ err }, "order booking folder check failed");
        ordersStatus = "partial";
        ordersDetail = `The order booking Drive folder could not be listed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const sources = [
      {
        key: "roster",
        name: "Team member roster",
        status: roster
          ? roster.source === "hr_roster" ? "connected" : "partial"
          : "missing",
        detail: roster
          ? roster.source === "hr_roster"
            ? `${roster.members.length} team members from the HR roster workbook`
            : `${roster.members.length} team members. The Team Member Details (HR) file is not shared with the connected Google account yet, so the roster comes from the live STATE HEAD DASHBOARD identity columns.`
          : "The roster could not be loaded. Connect the Google account to enable state and member filtering.",
      },
      {
        key: "orders",
        name: "Secondary order booking",
        status: ordersStatus,
        detail: ordersDetail,
      },
      await targetsSource(req),
      {
        key: "sfa",
        name: "Field visits (SFA)",
        status: "missing",
        detail:
          "Visits, working days, GPS kilometres, and lead-counter columns stay blank until the SFA export is connected.",
      },
      {
        key: "payroll",
        name: "CTC and expenses",
        status: "missing",
        detail:
          "CTC, T.A. bill, and cost-ratio columns stay blank until payroll and expense sheets are connected.",
      },
    ];
    const regions = Object.entries(regionMap()).map(([name, sts]) => ({
      name,
      states: sts,
    }));
    const seasonalCalibration = getSeasonalCalibration();
    res.json({ fys, defaultFy: DEFAULT_FY, regions, states, sources, seasonalCalibration });
  } catch (err) {
    req.log.error({ err }, "mgmt options failed");
    res.status(500).json({ error: "Could not load report options." });
  }
});

// Inline helpers used only by GET /mgmt/data.
// tgtPeriod: sums monthly targets for [mFrom, mTo] (fiscal month, 1-based).
// When no monthly override exists, each blank month gets its SEASONAL share
// of the annual target rather than a flat ÷12.  This matches tgtMonthly() in
// report.ts and monthlyReconcileError() in targets.ts exactly.
// Secondary plans from the STATE HEAD DASHBOARD bypass this entirely — they
// are real hand-entered monthly figures sourced separately via sec.months.
function tgtPeriod(
  target: TargetRow | null,
  field: "secondary" | "primary" | "businessPlan",
  mFrom: number,
  mTo: number,
): number | null {
  if (!target) return null;
  let sum = 0, any = false;
  for (let i = mFrom - 1; i <= mTo - 1; i++) {
    const ov = target.monthly[field][i];
    const ann = target.annual[field];
    // i is the fiscal month index (Apr=0 … Mar=11) — exactly what splitAnnualToMonth expects.
    const v = ov != null ? ov : splitAnnualToMonth(ann, i);
    if (v != null) { sum += v; any = true; }
  }
  return any ? sum : null;
}

// secPeriod: slices sec.months[mFrom-1..mTo-1] to produce period-specific
// figures from the STATE HEAD DASHBOARD.
//
// This is the PS1 period resolver — every sec.ytd* reference in the member
// assembly now calls this instead, so Q1/Q2/Q3/Q4/Full/individual-month filters
// all return accurate OB/Sales/Plan/Achievement for the requested period.
//
// Key rule: PLAN is always read regardless of notYetRecorded.
//   Plans are set at year-start and are real for both past AND future months
//   (e.g. Q2 Jul–Sep plans are populated and meaningful even though the months
//   haven't closed yet).  notYetRecorded only gates ACTUALS (OB, sales).
//
// ACTUALS (orderedAmount, salesAmount) are only accumulated for months where
//   notYetRecorded = false (calendar-closed months not caught by the V4 arrears
//   guard).  Open or arrears months contribute 0 to OB/Sales.
//
// Return semantics:
//   plan null        → no planAmount data in the period at all (member has no target)
//   ob/sales 0       → plan exists but the period has no closed actuals yet (future quarter)
//   achievement null → plan is null OR no closed actuals (cannot compute)
function secPeriod(
  sec: SecMember,
  mFrom: number, // 1-based fiscal month (1 = Apr)
  mTo: number,   // 1-based fiscal month (12 = Mar)
): { plan: number | null; ob: number | null; sales: number | null; achievement: number | null } {
  let plan = 0, ob = 0, sales = 0;
  let hasPlan = false, hasClosedMonth = false;
  for (let i = mFrom - 1; i <= mTo - 1; i++) {
    const md = sec.months[i];
    if (!md) continue;
    // PLAN: always read — real for past AND future months.
    if (md.planAmount != null) { plan += md.planAmount; hasPlan = true; }
    // ACTUALS: only from closed/recorded months (notYetRecorded = false).
    if (!md.notYetRecorded) {
      hasClosedMonth = true;
      if (md.orderedAmount != null) ob += md.orderedAmount;
      if (md.salesAmount != null)   sales += md.salesAmount;
    }
  }
  if (!hasPlan && !hasClosedMonth) return { plan: null, ob: null, sales: null, achievement: null };
  return {
    plan: hasPlan ? plan : null,
    // 0 when there is a plan but the period has no recorded actuals yet (future Q).
    ob:    hasClosedMonth ? ob    : 0,
    sales: hasClosedMonth ? (sales > 0 ? sales : 0) : 0,
    achievement: hasPlan && plan > 0 && hasClosedMonth ? sales / plan : null,
  };
}

function serialDate(n: number | null): string | null {
  if (n == null || n <= 0) return null;
  return new Date((n - 25569) * 86400000).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function achBand(pct: number | null, hasTarget: boolean): string {
  if (!hasTarget || pct == null) return "noTarget";
  if (pct < 0.25) return "below25";
  if (pct < 0.50) return "below50";
  if (pct < 0.70) return "50to70";
  if (pct < 0.90) return "70to90";
  if (pct < 1.00) return "90to100";
  return "above100";
}

// GET /api/mgmt/data — live JSON view of the State Head Dashboard.
// Accepts: fy, monthFrom, monthTo (all optional, with defaults).
// Returns: { rows, meta }
router.get("/mgmt/data", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim() !== ""
      ? req.query.fy.trim()
      : DEFAULT_FY;
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  const intQ = (k: string, lo: number, hi: number, dflt: number): number => {
    const v = Number(req.query[k]);
    return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : dflt;
  };
  const monthFrom = intQ("monthFrom", 1, 12, 1);
  const monthTo = intQ("monthTo", monthFrom, 12, 12);
  const filters: ReportFilters = {
    fy, states: [], regions: [], monthFrom, monthTo, lowPerfPct: 50,
  };

  // _simulatedNow: ISO date string injected for testing the V4 arrears guard.
  // When present the mgmt-data cache is bypassed and the state dashboard is
  // loaded with the injected clock (does NOT write back to the in-process cache).
  const simulatedNowMs: number | undefined = (() => {
    const raw = req.query._simulatedNow;
    if (typeof raw !== "string" || !raw) return undefined;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : undefined;
  })();

  // Return the cached payload immediately if it is still fresh.
  // Bypass the cache when a simulated date is in play.
  const cacheKey = mgmtDataCacheKey(fy, monthFrom, monthTo);
  const cachedEntry = simulatedNowMs === undefined ? _mgmtDataCache.get(cacheKey) : undefined;
  if (cachedEntry && Date.now() < cachedEntry.expiresAt) {
    req.log.debug({ fy, cacheKey }, "mgmt data: cache hit");
    res.json(cachedEntry.payload);
    return;
  }

  try {
    const [assembled, hrSfa, secDash, dbTargetMap] = await Promise.all([
      assembleRows(filters),
      loadHrSfaDashboard().catch((): Map<string, HrSfaRecord> => new Map()),
      loadStateDashboard(fy, simulatedNowMs).catch((): null => null),
      // State Head Targets (primary_state_targets) override/supplement Target Master.
      buildPrimaryTargetMapFromStateTargets(fy).catch((): Map<string, number[]> => new Map()),
    ]);
    const { rows, ordersAvailable, targetsAvailable, rosterSource, orderStatus, nameMatches, xlsxTargetDiagnostic } = assembled;
    // Build a normKey → SecMember lookup for the member-row merge below.
    const secByKey = new Map<string, SecMember>();
    if (secDash) {
      for (const sm of secDash.members) {
        // Roster members use normName-based keys.  joinKey = normName(sm.name)
        // so the lookup at r.m.normKey (roster key) resolves correctly even when
        // the secondary sheet spells a name with a parenthetical disambiguator
        // (e.g. "Ravi (Faridabad)") that the roster omits.
        // First-entry wins: if two secondary members share the same joinKey the
        // first one is preserved (the second is tracked separately in the DB via
        // normKey but the roster can only reference one person per normName key).
        if (!secByKey.has(sm.joinKey)) secByKey.set(sm.joinKey, sm);
      }
    }

    // ── Primary sale (dispatched invoices, Taxable Value by STATE HEAD) ──────────
    // State Head Sale sheets per FY — after the FY2026-27 sheet-ID fix these now
    // correctly point to invoice-date dispatched sale, not booked orders.
    let dispatchSaleByHead: Map<string, number> | null = null;
    let dispatchSaleSource: string | null = null;
    try {
      const sd = await loadStateHeadSale(fy);
      if (!sd.error && sd.total > 0) {
        dispatchSaleByHead = sd.byHead;
        dispatchSaleSource = sd.label;
        req.log.info({ fy, total: sd.total, heads: sd.byHead.size }, "mgmt: dispatch sale loaded");
      }
    } catch (err) {
      req.log.warn({ err, fy }, "mgmt: dispatch sale load failed");
    }

    // ── Primary order booking (booked orders — FY2026-27 Order Sheet only) ────
    let orderBookingPrimaryByHead: Map<string, number> | null = null;
    let orderBookingPrimarySource: string | null = null;
    if (fy === "2026-27") {
      try {
        const ob = await loadOrderBookSaleByHead();
        if (!ob.error && ob.total > 0) {
          orderBookingPrimaryByHead = ob.byHead;
          orderBookingPrimarySource = "Order Sheet 26-27 (Primary Order Booking)";
          req.log.info({ total: ob.total, heads: ob.byHead.size }, "mgmt: primary order booking loaded");
        }
      } catch (err) {
        req.log.warn({ err }, "mgmt: primary order booking load failed");
      }
    }

    // ── Distributor-to-TM map + per-member primary attribution ─────────────────
    // The map is built once (60-min cache) by reading ~180 member files. On the
    // first request after a cache miss, getDistributorTmMapIfReady() returns null
    // immediately and kicks off a background build — per-member columns will be
    // blank on that one request, then populated on subsequent calls once the cache
    // is warm. loadDistributorTmMap() is called if the cache is already warm so
    // we never block the request path.
    const distMap = getDistributorTmMapIfReady();
    let primaryAttrib: Awaited<ReturnType<typeof loadPrimaryAttribution>> | null = null;
    let primaryDiagnostics: PrimaryAttributionDiagnostics | null = null;
    if (distMap && !distMap.error && distMap.byPartyKey.size > 0) {
      try {
        primaryAttrib = await loadPrimaryAttribution(fy, distMap);
        primaryDiagnostics = primaryAttrib.diagnostics;
      } catch (err) {
        req.log.warn({ err, fy }, "mgmt: primary attribution failed");
      }
    } else if (!distMap) {
      // Warm up the cache in the background on first request
      loadDistributorTmMap().catch((err) =>
        req.log.warn({ err }, "mgmt: dist-map background build failed"),
      );
    }

    const headSales: Record<string, number> | undefined = dispatchSaleByHead
      ? Object.fromEntries(dispatchSaleByHead)
      : undefined;
    const orderBookingPrimary: Record<string, number> | undefined = orderBookingPrimaryByHead
      ? Object.fromEntries(orderBookingPrimaryByHead)
      : undefined;

    const members = rows.map((r) => {
      const tgtSec = tgtPeriod(r.target, "secondary", monthFrom, monthTo);
      const tgtBp = tgtPeriod(r.target, "businessPlan", monthFrom, monthTo);
      // DB-stored primary target overrides the Target Master when present.
      const dbMonthly12 = dbTargetMap.get(r.m.normKey);
      const tgtPri = dbMonthly12 != null
        ? dbPeriodTarget(dbMonthly12, monthFrom, monthTo)
        : tgtPeriod(r.target, "primary", monthFrom, monthTo);
      const dbAnnualPrimary = dbMonthly12 != null
        ? dbMonthly12.reduce((s, v) => s + v, 0)
        : null;
      const booking = r.orders?.amount ?? null;
      const sec = secByKey.get(r.m.normKey);
      // PS1 period resolver: compute period-specific figures from sec.months rather
      // than using the pre-baked ytd* aggregates which always reflect full closed-YTD.
      const sp = sec ? secPeriod(sec, monthFrom, monthTo) : null;
      // Achievement = Sales Received / Plan (STATE HEAD DASHBOARD — authoritative).
      // Falls back to Order Booked / Target Master for years without state dashboard.
      const achPct =
        sp?.achievement ??
        (booking != null && tgtSec != null && tgtSec > 0 ? booking / tgtSec : null);
      const sfa = hrSfa.get(r.m.normKey);
      const primStats = primaryAttrib?.perMember.get(r.m.normKey);
      return {
        normKey: r.m.normKey,
        name: r.m.name,
        stateHead: r.m.stateHead,
        state: r.m.state,
        hq: r.m.headquarter,
        dojLabel: serialDate(r.m.dojSerial),
        workingState: r.m.workingState,
        channel: r.m.channel,
        oldNew: r.oldNew,
        activeLeft: r.m.activeLeft,
        targetSecondary: tgtSec,
        targetPrimary: tgtPri,
        targetBusinessPlan: tgtBp,
        // Annual figures for the UI to compute period-share labels ("₹X = ₹Y × Z%").
        // These are the raw annual targets before seasonal splitting; null when unset.
        targetPrimaryAnnual: dbAnnualPrimary ?? r.target?.annual.primary ?? null,
        targetBusinessPlanAnnual: r.target?.annual.businessPlan ?? null,
        // Secondary order booking: STATE HEAD DASHBOARD period figure (authoritative) > old order file
        orderBooking: sp?.ob ?? booking,
        // Secondary sales received: period-specific from STATE HEAD DASHBOARD
        saleAmount: sp?.sales ?? null,
        priorOrderBooking: r.priorAmount,
        totalRetailers: r.orders?.totalRetailers ?? null,
        oldRetailers: r.orders?.oldRetailers ?? null,
        newRetailers: r.orders?.newRetailers ?? null,
        distributorCount: r.orders?.distributorCount ?? null,
        directDealerCount: r.orders?.directDealerCount ?? null,
        orderCount: r.orders?.orderCount ?? null,
        achievementPct: achPct,
        band: achBand(achPct, sp?.plan != null || tgtSec != null),
        visitedParties: sfa?.visitedParties ?? null,
        workingDays: sfa?.workingDays ?? null,
        ctcMonthly: sec?.salary ?? sfa?.ctcMonthly ?? null,
        costRatioPct: sfa?.costRatioPct ?? null,
        designation: sfa?.designation ?? null,
        // Primary attribution (from distributor-TM map + primary sheets)
        primaryOrderAmount: primStats?.orderAmount ?? null,
        primarySaleAmount: primStats?.saleAmount ?? null,
        primaryDistributors: distMap?.distributorCountByMember.get(r.m.normKey) ?? null,
        primaryDirectDealers: distMap?.directDealerCountByMember.get(r.m.normKey) ?? null,
        // STATE HEAD DASHBOARD secondary fields — period-specific via PS1 resolver.
        // secondaryPlan: for SHD members (sec != null) we never fall back to the
        // Target Master — a member with no period plan in the SHD genuinely has a
        // zero target for that period.  Null is reserved for non-SHD members so the
        // frontend knows to substitute targetSecondary for them.
        secondaryPlan: sec ? (sp.plan ?? 0) : null,
        secondaryOrderBooked: sp?.ob ?? null,
        secondarySalesReceived: sp?.sales ?? null,
        secondaryAchievement: sp?.achievement ?? null,
        secondaryBusinessPlan: sec?.businessPlan ?? null,
        salary: sec?.salary ?? null,
        totalDealers: sec?.totalDealers ?? null,
        monthlyPlan: sec?.months.map((m) => m.planAmount) ?? null,
        monthlyOrderBooked: sec?.months.map((m) => m.orderedAmount) ?? null,
        monthlySalesReceived: sec?.months.map((m) => m.salesAmount) ?? null,
        monthlyAchievement: sec?.months.map((m) => m.achievement) ?? null,
        monthlyNotYetRecorded: sec?.months.map((m) => m.notYetRecorded) ?? null,
        isPrimaryRole: sec?.isPrimaryRole ?? false,
        // isLeft: stateDashboard section detection is primary; roster BA column is the fallback.
        isLeft: (sec?.isLeft ?? false) || r.m.activeLeft?.toUpperCase().trim() === "LEFT",
        hasSecondaryAnomaly: sec?.months.some((m) => m.isAnomaly) ?? false,
      };
    });

    // Secondary data now comes from STATE HEAD DASHBOARD — no upload required.
    const orderBookingNote: string | null = null;

    // Pending orders = primary order booking minus dispatched sale (company-wide)
    const obTotal = orderBookingPrimary
      ? Object.values(orderBookingPrimary).reduce((s, v) => s + v, 0)
      : 0;
    const saleTotal = headSales
      ? Object.values(headSales).reduce((s, v) => s + v, 0)
      : 0;
    const pendingOrdersTotal =
      obTotal > 0 && saleTotal > 0 ? obTotal - saleTotal : null;

    // PS1: period-specific company-level secondary totals for the meta block.
    // Sums secPeriod() across all members so the headline KPI tiles reflect
    // exactly the same [monthFrom, monthTo] window as the per-member rows.
    let _ptPlan = 0, _ptOB = 0, _ptSales = 0, _ptHasData = false;
    if (secDash) {
      for (const sm of secDash.members) {
        const smp = secPeriod(sm, monthFrom, monthTo);
        if (smp.plan != null) { _ptPlan += smp.plan; _ptHasData = true; }
        _ptOB    += smp.ob    ?? 0;
        _ptSales += smp.sales ?? 0;
      }
    }
    const periodSecTotal = secDash ? {
      plan: _ptHasData ? _ptPlan : secDash.totalPlan,
      orderBooked: _ptOB,
      salesReceived: _ptSales,
      ytdAchievement: _ptHasData && _ptPlan > 0 ? _ptSales / _ptPlan : null,
      totalDealers: secDash.totalDealers,
      arrearsMonths: secDash.arrearsMonths ?? [],
      sheetTotals: secDash.sheetTotals ?? null,
    } : null;

    const responsePayload: MgmtDataPayload = {
      rows: members,
      meta: {
        fy,
        monthFrom,
        monthTo,
        ordersAvailable,
        targetsAvailable,
        orderBookingNote,
        rosterSource,
        // Dispatch sale (actual invoiced goods, by STATE HEAD)
        ...(headSales ? { headSales } : {}),
        saleSource: dispatchSaleSource,
        // Primary order booking (booked orders, FY2026-27 only)
        ...(orderBookingPrimary ? { orderBookingPrimary } : {}),
        ...(orderBookingPrimarySource ? { orderBookingPrimarySource } : {}),
        // Derived: orders booked but not yet dispatched
        ...(pendingOrdersTotal != null ? { pendingOrdersTotal } : {}),
        // Raw sheet totals for OB (Primary) and Sale (Dispatched) tiles —
        // includes Non-territory + unresolved-head buckets that the per-head
        // breakdown filters out. Frontend uses these for the company-level tiles.
        ...(obTotal > 0 ? { primaryBookingRawTotal: obTotal } : {}),
        ...(saleTotal > 0 ? { saleRawTotal: saleTotal } : {}),
        // Secondary data: STATE HEAD DASHBOARD (authoritative for FY26-27 + FY25-26)
        secondarySource: secDash ? "state_head_dashboard" : null,
        ...(secDash ? {
          secondaryTotal: periodSecTotal,
          anomalies: secDash.anomalies,
          secondaryCoveragePct: saleTotal > 0 && secDash.totalSalesReceived > 0
            ? secDash.totalSalesReceived / saleTotal
            : null,
        } : { secondaryTotal: null, anomalies: [], secondaryCoveragePct: null }),
        orderBookingSource: secDash
          ? `STATE HEAD DASHBOARD — Secondary Order Booking ${fy}`
          : (ordersAvailable ? `Secondary Order Booking ${fy}` : null),
        orderBookingNameMatches: nameMatches,
        // Primary attribution diagnostics (null until dist-map is warm)
        ...(primaryDiagnostics ? { primaryAttributionDiagnostics: primaryDiagnostics } : {}),
        ...(xlsxTargetDiagnostic ? { targetMatchDiagnostic: xlsxTargetDiagnostic } : {}),
        // Seasonal calibration metadata so the frontend can show the basis and
        // single-year calibration caveat on any derived target column.
        seasonalCalibration: getSeasonalCalibration(),
      },
    };
    // Do not write back to cache when a simulated date is in play — the payload
    // is date-dependent and must not pollute the live-clock cache.
    if (simulatedNowMs === undefined) {
      _mgmtDataCache.set(cacheKey, { payload: responsePayload, expiresAt: Date.now() + MGMT_DATA_TTL_MS });
    }
    res.json(responsePayload);
  } catch (err) {
    req.log.error({ err, fy }, "mgmt data failed");
    res.status(500).json({
      error:
        "Could not load dashboard data. Google Sheets may be unavailable; try again in a minute.",
    });
  }
});

// GET /api/mgmt/primary — focused primary (Prayag→Dist) performance data.
// Returns company, state-head, and distributor tiers directly from the sheets
// (no bridge needed). The per-member tier is overlaid when the bridge is ready.
router.get("/mgmt/primary", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim()
      ? req.query.fy.trim()
      : "2026-27";
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }

  try {
    // Load head/distributor aggregations from sheets — no bridge needed.
    const sheetData = await loadPrimarySheetData(fy);

    // Per-member tier: requires the distributor-TM map.
    const distMap = getDistributorTmMapIfReady();
    let bridgeStatus: "ready" | "building" | "unavailable" = "unavailable";
    type MemberEntry = {
      normKey: string;
      name: string;
      stateHead: string;
      booking: number;
      sale: number;
      distributors: number;
    };
    let byMember: MemberEntry[] | null = null;

    if (distMap && !distMap.error && distMap.byPartyKey.size > 0) {
      bridgeStatus = "ready";
      try {
        const [primaryAttrib, roster] = await Promise.all([
          loadPrimaryAttribution(fy, distMap),
          loadRoster().catch(() => null),
        ]);
        const memberByNormKey = new Map(
          (roster?.members ?? []).map((m) => [m.normKey, m]),
        );
        byMember = [];
        for (const [normKey, stats] of primaryAttrib.perMember) {
          if (stats.orderAmount === 0 && stats.saleAmount === 0) continue;
          const member = memberByNormKey.get(normKey);
          byMember.push({
            normKey,
            name: member?.name ?? normKey,
            stateHead: member?.stateHead ?? "",
            booking: stats.orderAmount,
            sale: stats.saleAmount,
            distributors: distMap.distributorCountByMember.get(normKey) ?? 0,
          });
        }
        // Unassigned bucket — amounts not mapped to any TM but under a head
        for (const [headKey, ua] of primaryAttrib.unassignedByHead) {
          if (ua.orderAmount === 0 && ua.saleAmount === 0) continue;
          byMember.push({
            normKey: `__unassigned__${headKey}`,
            name: "Unassigned",
            stateHead: headKey,
            booking: ua.orderAmount,
            sale: ua.saleAmount,
            distributors: ua.customerCount,
          });
        }
        byMember.sort((a, b) => b.booking - a.booking);
        req.log.info(
          { fy, members: byMember.length },
          "mgmt primary: per-member tier ready",
        );
      } catch (err) {
        req.log.warn({ err, fy }, "mgmt primary: per-member attribution failed");
      }
    } else if (!distMap) {
      bridgeStatus = "building";
      loadDistributorTmMap().catch((err) =>
        req.log.warn({ err }, "mgmt primary: dist-map background build failed"),
      );
    }

    // Build head-level primary target map from state targets for use in the response.
    const dbHeadTargetMap = await buildPrimaryTargetMapFromStateTargets(fy).catch((): Map<string, number[]> => new Map());
    const headPrimaryTargets: Record<string, number | null> = {};
    for (const row of sheetData.byHead) {
      const nk = normName(row.head);
      const monthly12 = nk ? dbHeadTargetMap.get(nk) : undefined;
      headPrimaryTargets[row.head] = monthly12 != null
        ? monthly12.reduce((s, v) => s + v, 0)
        : null;
    }

    res.json({
      fy,
      companyBooking: sheetData.companyBooking,
      companySale: sheetData.companySale,
      companyPending: sheetData.companyPending,
      byHead: sheetData.byHead,
      byDistributor: sheetData.byDistributor,
      byMember,
      bridgeStatus,
      headPrimaryTargets,
      sources: sheetData.sources,
      bookingAvailable: sheetData.bookingAvailable,
      saleAvailable: sheetData.saleAvailable,
      tabInventory: sheetData.tabInventory ?? null,
    });
  } catch (err) {
    req.log.error({ err, fy }, "mgmt primary failed");
    res.status(500).json({ error: "Could not load primary performance data." });
  }
});

router.post("/mgmt/report", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fy = typeof body.fy === "string" && body.fy.trim() !== "" ? body.fy.trim() : DEFAULT_FY;
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const intIn = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === "number" ? Math.round(v) : NaN;
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const filters: ReportFilters = {
    fy,
    states: strArr(body.states),
    regions: strArr(body.regions),
    monthFrom: intIn(body.monthFrom, 1, 12, 1),
    monthTo: intIn(body.monthTo, 1, 12, 12),
    lowPerfPct: intIn(body.lowPerfPct, 1, 100, 60),
  };
  if (filters.monthFrom > filters.monthTo) {
    res.status(400).json({ error: "monthFrom must not be after monthTo" });
    return;
  }
  const knownRegions = new Set(Object.keys(regionMap()));
  const badRegion = filters.regions.find((r) => !knownRegions.has(r));
  if (badRegion) {
    res.status(400).json({ error: `Unknown region: ${badRegion}` });
    return;
  }
  try {
    const started = Date.now();
    const { workbook, memberCount } = await buildManagementWorkbook(filters);
    if (memberCount === 0) {
      res.status(422).json({
        error:
          "No team members match the selected filters. Widen the state or region selection.",
      });
      return;
    }
    const scope =
      filters.regions.length > 0
        ? filters.regions.join("-")
        : filters.states.length > 0
          ? "Custom"
          : "All";
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `StateHeadDashboard_${fy}_${scope}_${stamp}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
    req.log.info(
      { fy, scope, memberCount, ms: Date.now() - started },
      "management report generated",
    );
  } catch (err) {
    req.log.error({ err, fy }, "management report failed");
    if (!res.headersSent) {
      res.status(500).json({
        error:
          "Could not generate the report. Google Sheets may be rate-limiting reads; try again in a minute.",
      });
    } else {
      res.end();
    }
  }
});

// Reconcile the computed secondary-order-booking report against the signed-off
// dashboard anchors. Returns per-check pass/warn/fail with app vs expected vs
// delta%, an internal cross-foot, and any roster head missing from output.
router.get("/mgmt/verify", async (req: Request, res: Response): Promise<void> => {
  const raw = req.query.fy;
  const fy = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "2025-26";
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2025-26" });
    return;
  }
  if (!hasVerifyAnchors(fy)) {
    res.status(422).json({
      error: `No verification anchors are configured for ${fy}.`,
      availableFys: verifyFyList(),
    });
    return;
  }
  try {
    const result = await runVerify(fy);
    res.json(result);
  } catch (err) {
    req.log.error({ err, fy }, "mgmt verify failed");
    res.status(500).json({
      error:
        "Could not run verification. Google Sheets may be rate-limiting reads; try again in a minute.",
    });
  }
});

// Force a fresh auto-build of the Party TM Map from the member report
// folder. Returns immediately; poll GET /mgmt/bridge/status for progress.
router.post(
  "/mgmt/bridge/rebuild",
  (req: Request, res: Response): void => {
    invalidatePartyBridgeCache();
    const started = startBridgeBuild();
    const state = getBridgeBuildState();
    req.log.info({ started, state }, "party-tm bridge rebuild requested");
    res.status(202).json({
      started,
      alreadyRunning: !started,
      state,
    });
  },
);

// GET /api/mgmt/pending-orders
// Returns factory pending order book (REPORT 2 from the pending sheet) by state
// head and party, in quantity only, plus the derived pending (OB minus Sale).
router.get("/mgmt/pending-orders", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await loadFactoryPending();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "pending-orders: loadFactoryPending threw");
    res.status(500).json({ error: "Could not load factory pending data." });
  }
});

// GET /api/mgmt/deep-dive
// Phase 1: returns the ~38 mandatory KPIs for a chosen state head + member + FY
// from the 'Data' tab of the STATE HEAD DASHBOARD (source A). No re-derive yet.
router.get("/mgmt/deep-dive", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy =
      typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
        ? req.query.fy.trim()
        : "2026-27";

    const selectedStateHead =
      typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : undefined;

    const memberRaw =
      typeof req.query.member === "string" ? req.query.member.trim() : undefined;

    // Accept either the raw name or the normSecKey.
    const memberKey = memberRaw ? normSecKey(memberRaw) : undefined;

    req.log.info(
      { fy, selectedStateHead, memberKey },
      "mgmt/deep-dive: request received",
    );

    const result = await loadDeepDiveData(fy, selectedStateHead, memberKey);

    if (result.error && !result.stateHeads.length) {
      // Phase 5 (skuSpread) is DB-only — include it even when the Sheets
      // Data tab could not be loaded.
      res.status(502).json({ error: result.error, skuSpread: result.skuSpread ?? null });
      return;
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "mgmt/deep-dive: handler threw");
    res.status(500).json({ error: "Could not load deep-dive data." });
  }
});

// GET /api/mgmt/distributor-deep-dive
// Phase D1: groups retailer rows from all member working sheets under a state
// head by their Assigned Distributor field.
router.get("/mgmt/distributor-deep-dive", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy         = typeof req.query.fy         === "string" ? req.query.fy.trim()         : "2026-27";
    const stateHead  = typeof req.query.stateHead  === "string" ? req.query.stateHead.trim()  : undefined;

    req.log.info({ fy, stateHead }, "mgmt/distributor-deep-dive: request received");

    const { loadDistributorDeepDive } = await import("../lib/mgmt/distributorDeepDive.js");
    const result = await loadDistributorDeepDive(fy, stateHead);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "mgmt/distributor-deep-dive: handler threw");
    res.status(500).json({ error: "Could not load distributor deep-dive data." });
  }
});

// ── D7: distributor tier overrides ───────────────────────────────────────────
//
// GET  /api/mgmt/distributor-tier-override?fy=...&stateHead=...
// PUT  /api/mgmt/distributor-tier-override  (body: { fy, stateHead, normKey, tier, reason })
// DELETE /api/mgmt/distributor-tier-override  (body: { fy, stateHead, normKey })

router.get("/mgmt/distributor-tier-override", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim() : "2026-27";
    const stateHead = typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
    if (!stateHead) { res.status(400).json({ error: "stateHead is required" }); return; }
    const rows = await db.select().from(distributorTierOverrideTable).where(
      and(
        eq(distributorTierOverrideTable.stateHead, stateHead),
        eq(distributorTierOverrideTable.fy, fy),
      ),
    );
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "distributor-tier-override GET: failed");
    res.status(500).json({ error: "Could not load tier overrides." });
  }
});

router.put("/mgmt/distributor-tier-override", async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = insertDistributorTierOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const { stateHead, fy, normKey, tier, reason } = parsed.data;
    const [row] = await db
      .insert(distributorTierOverrideTable)
      .values({ stateHead, fy, normKey, tier, reason })
      .onConflictDoUpdate({
        target: [
          distributorTierOverrideTable.stateHead,
          distributorTierOverrideTable.fy,
          distributorTierOverrideTable.normKey,
        ],
        set: { tier, reason, overriddenAt: new Date() },
      })
      .returning();
    req.log.info({ stateHead, fy, normKey, tier }, "distributor-tier-override: upserted");
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "distributor-tier-override PUT: failed");
    res.status(500).json({ error: "Could not save tier override." });
  }
});

router.delete("/mgmt/distributor-tier-override", async (req: Request, res: Response): Promise<void> => {
  try {
    const { fy, stateHead, normKey } = req.body as Record<string, string>;
    if (!fy || !stateHead || !normKey) {
      res.status(400).json({ error: "fy, stateHead, and normKey are required" });
      return;
    }
    await db.delete(distributorTierOverrideTable).where(
      and(
        eq(distributorTierOverrideTable.stateHead, stateHead),
        eq(distributorTierOverrideTable.fy, fy),
        eq(distributorTierOverrideTable.normKey, normKey),
      ),
    );
    req.log.info({ stateHead, fy, normKey }, "distributor-tier-override: deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "distributor-tier-override DELETE: failed");
    res.status(500).json({ error: "Could not delete tier override." });
  }
});

router.get("/mgmt/bridge/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const bridge = await loadPartyBridge();
    res.json({
      bridge: {
        status: bridge.status,
        detail: bridge.detail,
        fileId: bridge.fileId ?? null,
        rows: bridge.rows.length,
        distributorParties: bridge.entries.size,
        conflicts: bridge.conflicts.length,
      },
      build: getBridgeBuildState(),
    });
  } catch (err) {
    req.log.error({ err }, "bridge status failed");
    res.status(500).json({ error: "Could not load bridge status." });
  }
});


export default router;
