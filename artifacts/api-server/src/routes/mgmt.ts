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
import {
  getDistributorTmMapIfReady,
  loadDistributorTmMap,
} from "../lib/mgmt/distributorTmMap.js";
import {
  loadPrimaryAttribution,
  type PrimaryAttributionDiagnostics,
} from "../lib/mgmt/primaryAttribution.js";
import {
  parseDashboardXlsx,
  storeDashboardXlsxData,
  loadDashboardXlsxData,
  invalidateDashboardXlsxCache,
  dashboardXlsxPath,
} from "../lib/mgmt/dashboardXlsx.js";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2025-26";

// The Target Master sheet is provisioned and writable; the status reflects
// whether any targets have actually been saved for the default FY yet.
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
    res.json({ fys, defaultFy: DEFAULT_FY, regions, states, sources });
  } catch (err) {
    req.log.error({ err }, "mgmt options failed");
    res.status(500).json({ error: "Could not load report options." });
  }
});

// Inline helpers used only by GET /mgmt/data.
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
    const v = ov != null ? ov : ann != null ? ann / 12 : null;
    if (v != null) { sum += v; any = true; }
  }
  return any ? sum : null;
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
  try {
    const [assembled, hrSfa] = await Promise.all([
      assembleRows(filters),
      loadHrSfaDashboard().catch((): Map<string, HrSfaRecord> => new Map()),
    ]);
    const { rows, ordersAvailable, targetsAvailable, rosterSource, orderStatus, nameMatches, xlsxTargetDiagnostic } = assembled;

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
      const tgtPri = tgtPeriod(r.target, "primary", monthFrom, monthTo);
      const tgtBp = tgtPeriod(r.target, "businessPlan", monthFrom, monthTo);
      const booking = r.orders?.amount ?? null;
      const achPct =
        booking != null && tgtSec != null && tgtSec > 0 ? booking / tgtSec : null;
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
        orderBooking: booking,
        // saleAmount on individual rows is null — the frontend reads meta.headSales
        // for the Summary view and KPI tile (head-level only, no per-member split).
        saleAmount: null,
        priorOrderBooking: r.priorAmount,
        totalRetailers: r.orders?.totalRetailers ?? null,
        oldRetailers: r.orders?.oldRetailers ?? null,
        newRetailers: r.orders?.newRetailers ?? null,
        distributorCount: r.orders?.distributorCount ?? null,
        directDealerCount: r.orders?.directDealerCount ?? null,
        orderCount: r.orders?.orderCount ?? null,
        achievementPct: achPct,
        band: achBand(achPct, tgtSec != null),
        visitedParties: sfa?.visitedParties ?? null,
        workingDays: sfa?.workingDays ?? null,
        ctcMonthly: sfa?.ctcMonthly ?? null,
        costRatioPct: sfa?.costRatioPct ?? null,
        designation: sfa?.designation ?? null,
        // Primary attribution (from distributor-TM map + primary sheets)
        primaryOrderAmount: primStats?.orderAmount ?? null,
        primarySaleAmount: primStats?.saleAmount ?? null,
        primaryDistributors: distMap?.distributorCountByMember.get(r.m.normKey) ?? null,
        primaryDirectDealers: distMap?.directDealerCountByMember.get(r.m.normKey) ?? null,
      };
    });

    const orderBookingNote = !ordersAvailable
      ? (orderStatus?.detail ??
          `FY${fy} Secondary Order Booking file not yet created. Order Booking and Achievement are pending until the file exists in Drive.`)
      : null;

    // Pending orders = primary order booking minus dispatched sale (company-wide)
    const obTotal = orderBookingPrimary
      ? Object.values(orderBookingPrimary).reduce((s, v) => s + v, 0)
      : 0;
    const saleTotal = headSales
      ? Object.values(headSales).reduce((s, v) => s + v, 0)
      : 0;
    const pendingOrdersTotal =
      obTotal > 0 && saleTotal > 0 ? obTotal - saleTotal : null;

    res.json({
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
        // Secondary order booking (per salesperson, from order-booking workbooks)
        orderBookingSource: ordersAvailable ? `Secondary Order Booking ${fy}` : null,
        orderBookingNameMatches: nameMatches,
        // Primary attribution diagnostics (null until dist-map is warm)
        ...(primaryDiagnostics ? { primaryAttributionDiagnostics: primaryDiagnostics } : {}),
        ...(xlsxTargetDiagnostic ? { targetMatchDiagnostic: xlsxTargetDiagnostic } : {}),
      },
    });
  } catch (err) {
    req.log.error({ err, fy }, "mgmt data failed");
    res.status(500).json({
      error:
        "Could not load dashboard data. Google Sheets may be unavailable; try again in a minute.",
    });
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

// ── Dashboard xlsx upload ──────────────────────────────────────────────────────

// Step 1: Get a short-lived presigned PUT URL for the browser to upload directly.
router.get(
  "/mgmt/dashboard-xlsx/upload-url",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const service = new ObjectStorageService();
      const uploadUrl = await service.getObjectEntityUploadURL();
      res.json({ uploadUrl });
    } catch (err) {
      req.log.error({ err }, "dashboard-xlsx upload-url failed");
      res.status(500).json({ error: "Could not create an upload URL." });
    }
  },
);

// Step 2: Register an uploaded file — download from object storage, parse, persist.
router.post(
  "/mgmt/dashboard-xlsx/register",
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as {
      fy?: unknown;
      uploadUrl?: unknown;
      fileName?: unknown;
    };
    const fy = typeof body.fy === "string" ? body.fy.trim() : "";
    const uploadUrl = typeof body.uploadUrl === "string" ? body.uploadUrl.trim() : "";
    const fileName =
      typeof body.fileName === "string" && body.fileName.trim()
        ? body.fileName.trim()
        : `dashboard-state-head-${fy}.xlsx`;

    if (!FY_PATTERN.test(fy) || !uploadUrl) {
      res.status(400).json({ error: "fy and uploadUrl are required." });
      return;
    }

    try {
      const service = new ObjectStorageService();
      const objectPath = service.normalizeObjectEntityPath(uploadUrl);
      const file = await service.getObjectEntityFile(objectPath);

      // Write the xlsx to the local uploads directory so the fallback order-file
      // loader and the dashboard parser can read it without re-fetching.
      const dest = dashboardXlsxPath(fy);
      const destDir = dirname(dest);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

      await new Promise<void>((ok, fail) => {
        const ws = createWriteStream(dest);
        const nodeStream = file.createReadStream();
        (nodeStream as NodeJS.ReadableStream).pipe(ws);
        ws.on("finish", ok);
        ws.on("error", fail);
        (nodeStream as NodeJS.ReadableStream).on("error", fail);
      });

      const data = await parseDashboardXlsx(dest, fy, fileName);
      await storeDashboardXlsxData(data);
      invalidateDashboardXlsxCache(fy);

      req.log.info(
        {
          fy,
          fileName,
          totalRecords: data.status.totalRecords,
          headerRow: data.status.headerRow,
          targetPeriod: data.status.targetPeriod,
        },
        "dashboard-xlsx registered",
      );

      res.json({ status: data.status });
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Uploaded file not found in object storage." });
        return;
      }
      req.log.error({ err, fy }, "dashboard-xlsx register failed");
      res
        .status(500)
        .json({
          error:
            err instanceof Error
              ? err.message
              : "Could not parse the uploaded file.",
        });
    }
  },
);

// Step 3: Get status / parsed summary for a FY.
router.get(
  "/mgmt/dashboard-xlsx/:fy",
  async (req: Request, res: Response): Promise<void> => {
    const fy = String(req.params.fy ?? "").trim();
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "Invalid fiscal year." });
      return;
    }
    try {
      const data = await loadDashboardXlsxData(fy);
      if (!data) {
        res.status(404).json({ error: `No dashboard xlsx uploaded for ${fy}.` });
        return;
      }
      res.json({ status: data.status });
    } catch (err) {
      req.log.error({ err, fy }, "dashboard-xlsx status failed");
      res.status(500).json({ error: "Could not load dashboard xlsx status." });
    }
  },
);

export default router;
