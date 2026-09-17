// Management Reports: filter options + Excel generation.
import { Router, type IRouter, type Request, type Response } from "express";
import { currentOpenFy, deriveSaleLineCohortFy, closedReportingMonthCount, fyMonthLabels } from "../lib/fyAnchors.js";
import express from "express";
import { writeFile, rename as renameFile, mkdir as mkdirAsync } from "node:fs/promises";
import { dirname } from "node:path";
import { loadRoster, invalidateRosterCache, hrRosterCsvWritePath, saveRosterCsvToGcs, mgmtSources } from "../lib/mgmt/roster.js";
import { isAdminToken } from "../lib/adminAuth.js";
import { requireVerificationEndpointAccess } from "../lib/apiKeyAuth.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { getOpenResolutionHolds, resolveHoldExclusionsFromRows } from "../lib/resolution/holdResolver.js";
import { resolveOrderFileId, getOrderLoadStatus, loadOrderFile } from "../lib/mgmt/orders.js";
import {
  buildManagementWorkbook,
  assembleRows,
  regionMap,
  type ReportFilters,
} from "../lib/mgmt/report.js";
import { loadTargetsForFy, type TargetRow } from "../lib/mgmt/targets.js";
import { loadDbTargetsForFy } from "../lib/mgmt/memberTargetsStore.js";
import { loadHrSfaDashboard, type HrSfaRecord } from "../lib/mgmt/hrSfaDashboard.js";
import { runVerify, hasVerifyAnchors, verifyFyList } from "../lib/mgmt/verify.js";
import {
  loadPartyBridge,
  invalidatePartyBridgeCache,
  startBridgeBuild,
  getBridgeBuildState,
} from "../lib/mgmt/bridge.js";
import {
  loadPrimaryPeriodData,
  fiscalMonthsToLabels,
} from "../lib/mgmt/primaryPeriod.js";
import { buildFactoryPendingWorkbook, loadFactoryPending } from "../lib/mgmt/factoryPending.js";
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
import {
  loadDeepDiveData,
  loadMemberTargetSnapshots,
  loadMemberKpisForStateHead,
  normSecKey,
  loadRegistry,
  getRegistry,
} from "../lib/mgmt/deepDiveData.js";
import { splitAnnualToMonth, getSeasonalCalibration } from "../lib/seasonal.js";
import {
  buildPrimaryTargetMapFromStateTargets,
  periodTarget as dbPeriodTarget,
} from "../lib/mgmt/primaryTargets.js";
import { normName } from "../lib/mgmt/names.js";
import {
  db,
  secondaryHeadMonths,
  distributorTierOverrideTable,
  insertDistributorTierOverrideSchema,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { serveWithSnapshot, invalidateSnapshots, prewarmSnapshot } from "../lib/payloadSnapshot.js";
import { logger } from "../lib/logger.js";
import { isFrozen } from "../lib/customers/registerSync.js";
import { monthFreezeAt } from "../lib/registers/monthlyReplace.js";
import {
  buildDeepDiveExport,
  buildDeepDivePeriodAnalysis,
  type DeepDiveMonthlyRow,
  type DeepDiveBenchmark,
} from "../lib/mgmt/deepDiveExport.js";
import {
  buildStateHeadDeepDiveWorkbook,
  resolveAuthoritativePeriodValue,
  stateHeadWorkbookEvidence,
  type StateHeadPeriodMember,
} from "../lib/mgmt/stateHeadDeepDiveExport.js";
import { provisionalMonthsExportInfo } from "../lib/exportInfo.js";
import {
  buildCoverageReviewWorkbook,
  infoSheetEvidence,
  mapOperationalCoverageKpis,
  workbookSheetEvidence,
} from "../lib/organisationCoverageExport.js";
import { buildDistributorDeepDiveExport } from "../lib/mgmt/distributorDeepDiveExport.js";

const router: IRouter = Router();

// fiscalMonthsToLabels is imported from primaryPeriod.ts (single source of truth).

const FY_PATTERN = /^\d{4}-\d{2}$/;
// Default FY for management pages: the newest fully-ingested closed FY,
// derived at request time (never hardcoded) so pages cannot open on an
// outdated year after a rollover.
const defaultMgmtFy = deriveSaleLineCohortFy;

// Reason text attached to any pending field that is negative.
// A negative pending (sale > booking) means goods were dispatched against
// orders committed in a prior period.  Both possibilities — legitimate
// backlog-clearing and a data fault — need to be visible; zero conceals both.
const NEGATIVE_PENDING_NOTE =
  "dispatches exceed this period's booking — prior-period orders fulfilled";

// ── Cold-start fast path for GET /mgmt/data ──────────────────────────────────
// Assembling rows requires large Sheets reads (up to 380 k rows per FY), so
// the route is served through the shared snapshot layer (lib/payloadSnapshot):
// warm in-process cache → instant; cold cache with a persisted snapshot →
// instant with meta.refreshing while a background rebuild runs; first ever
// request → blocking live build. Invalidated when a new dashboard xlsx is
// uploaded so target data is always fresh.
type MgmtDataPayload = { rows: unknown[]; meta: Record<string, unknown> };
const MGMT_DATA_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MGMT_DATA_KEY_PREFIX = "mgmt-data|";

function mgmtDataSnapshotKey(fy: string, from: number, to: number): string {
  return `${MGMT_DATA_KEY_PREFIX}${fy}|${from}|${to}`;
}

// The period views every FY selector exposes: full year + the four quarters.
// Pre-warmed at startup (and after a register repair) so no user's first visit
// ever blocks on a multi-minute live build.
const PREWARM_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 12], [1, 3], [4, 6], [7, 9], [10, 12],
];

/**
 * Build any missing mgmt-data snapshots (full year + quarters) for the given
 * FYs — or every selectable FY when none are given. Sequential and
 * skip-if-exists (see prewarmSnapshot), so re-runs are cheap and a startup
 * loop never re-builds covered keys.
 */
export async function prewarmMgmtDataSnapshots(fys?: string[]): Promise<void> {
  const targets =
    fys ?? Object.keys(mgmtSources().secondary_order_booking.files_by_year).sort().reverse();
  let built = 0;
  for (const fy of targets) {
    for (const [from, to] of PREWARM_RANGES) {
      try {
        const result = await prewarmSnapshot({
          key: mgmtDataSnapshotKey(fy, from, to),
          ttlMs: MGMT_DATA_TTL_MS,
          build: () => buildMgmtDataPayload(fy, from, to, undefined, logger),
        });
        if (result === "built") {
          built += 1;
          logger.info({ fy, from, to }, "mgmt-data prewarm: snapshot built");
        }
      } catch (err) {
        logger.warn({ err, fy, from, to }, "mgmt-data prewarm: build failed");
      }
    }
  }
  logger.info({ fys: targets.length, built }, "mgmt-data prewarm: done");
}

// Fiscal-month index (1=Apr … 12=Mar) → month label like "Apr-26" for a FY.
function fiscalMonthLabel(fy: string, idx: number): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m || idx < 1 || idx > 12) return null;
  const startYear = parseInt(m[1], 10);
  const mon = (3 + (idx - 1)) % 12; // Apr=3 … Mar=2
  const year = startYear + (mon < 3 ? 1 : 0);
  const abbr = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mon];
  return `${abbr}-${String(year % 100).padStart(2, "0")}`;
}

/**
 * True when every month in the requested fiscal range is past its lock date
 * (7th of the following month). Such a slice of an open FY is as immutable as
 * a fully closed FY — the registers for those months are frozen and the sync
 * never rewrites them — so its snapshot can be served as final. Target/xlsx
 * edits still invalidate these snapshots via invalidateMgmtDataCache.
 */
function periodFrozenSince(fy: string, monthFrom: number, monthTo: number): number | null {
  if (isFrozen(fy)) return 0; // closed FY: any snapshot is post-freeze
  let latest = 0;
  for (let i = monthFrom; i <= monthTo; i++) {
    const label = fiscalMonthLabel(fy, i);
    const freezeAt = label ? monthFreezeAt(label) : null;
    if (!freezeAt || Date.now() < freezeAt.getTime()) return null;
    latest = Math.max(latest, freezeAt.getTime());
  }
  return latest;
}

export function invalidateMgmtDataCache(fy?: string): void {
  // Drops warm cache entries and the persisted route_payload_snapshot rows —
  // both hold the same payload (including target columns), so leaving either
  // would re-serve stale targets right after a dashboard xlsx upload.
  invalidateSnapshots(fy ? `${MGMT_DATA_KEY_PREFIX}${fy}|` : MGMT_DATA_KEY_PREFIX);
  // Period-filtered distributor deep-dive payloads are cached in memory with
  // a TTL; a re-sync/upload must not leave them serving pre-sync figures.
  void import("../lib/mgmt/distributorDeepDive.js")
    .then((m) => m.invalidateFilteredDistDdCache(fy))
    .catch(() => { /* cache module unavailable — nothing cached to drop */ });
  // Growth report payloads are cached in memory; invalidate them so a
  // re-sync / upload never serves a stale growth report.
  void import("./aiGrowthReport.js")
    .then((m) => m.invalidateGrowthReportCache(fy))
    .catch(() => { /* cache module unavailable — nothing cached to drop */ });
}

// Minimal logger surface shared by req.log (pino-http) and the app logger.
type MgmtLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

// Checks whether any targets have been saved in the Target Master sheet for
// the default FY. The sheet is read-only like all other Sheets sources.
async function targetsSource(req: Request): Promise<{
  key: string;
  name: string;
  status: string;
  detail: string;
}> {
  try {
    const targetsFy = await defaultMgmtFy();
    const [map, dbRows] = await Promise.all([
      loadTargetsForFy(targetsFy),
      loadDbTargetsForFy(targetsFy).catch(() => new Map<string, TargetRow>()),
    ]);
    const dbCount = dbRows.size;
    // Sheet-only share = merged entries whose key has no DB overlay (DB rows
    // can override sheet rows for the same member, so map.size - dbCount
    // would undercount the sheet).
    const sheetCount = [...map.keys()].filter((k) => !dbRows.has(k)).length;
    let rosterCount: number | null = null;
    try {
      rosterCount = (await loadRoster()).members.length;
    } catch { /* roster unavailable — omit the denominator */ }
    const ofRoster = rosterCount ? ` of ${rosterCount} roster members` : "";
    if (map.size === 0) {
      return {
        key: "targets",
        name: "Targets and business plans",
        status: "partial",
        detail:
          "The Prayag Target Master sheet is connected but effectively unmaintained — it holds no usable targets, and none have been saved in the app yet. Set targets in the Targets tab; those save to the app's own database, not the sheet.",
      };
    }
    const lowCoverage = rosterCount != null && map.size < rosterCount * 0.25;
    return {
      key: "targets",
      name: "Targets and business plans",
      status: lowCoverage ? "partial" : "connected",
      detail:
        `Targets exist for ${map.size}${ofRoster} for ${targetsFy}` +
        ` (${sheetCount} from the Target Master sheet, ${dbCount} saved in the app).` +
        (lowCoverage
          ? " The Target Master sheet is effectively unmaintained — it is not being filled in, not merely awaiting entry. New targets should be set in the Targets tab, which saves to the app database."
          : " Achievement % columns fill from these."),
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

// GET /mgmt/unmatched-names?fy=YYYY-YY — order-booking names that no roster
// member matches, each with its net Sale value and an identity-registry
// verdict. Purpose: before anyone is asked to fix 58 names by hand, show which
// are spelling variants the registry can already resolve and which are
// genuinely unknown.
const _unmatchedCache = new Map<string, { at: number; payload: unknown }>();
const UNMATCHED_TTL_MS = 10 * 60 * 1000;

router.get("/mgmt/unmatched-names", async (req: Request, res: Response): Promise<void> => {
  const fy = typeof req.query.fy === "string" && req.query.fy ? req.query.fy : await defaultMgmtFy();
  const hit = _unmatchedCache.get(fy);
  if (hit && Date.now() - hit.at < UNMATCHED_TTL_MS) {
    res.json(hit.payload);
    return;
  }
  try {
    // Registry access is warm-only (getRegistry, sync): triggering a full
    // deep-dive Sheets load from this diagnostic endpoint on a cold start
    // could burn quota / time out the Data Sources page. When cold, names
    // come back as "unchecked" and the next visit (after deep-dive pages
    // warm the cache) upgrades them.
    const [agg, roster] = await Promise.all([loadOrderFile(fy), loadRoster()]);
    const registry = getRegistry(fy);
    if (!agg) {
      res.status(404).json({ error: `No order booking file for ${fy}.` });
      return;
    }
    const rosterKeys = new Set(roster.members.map((m) => m.normKey));
    const names = [...agg.perTm.entries()]
      .filter(([key]) => !rosterKeys.has(key))
      .map(([, v]) => {
        const name = v.displayName;
        let registryStatus: "resolvable" | "ambiguous" | "unknown" | "unchecked" = "unchecked";
        let resolvedTo: string | null = null;
        let candidates: string[] | null = null;
        if (registry) {
          const r = registry.resolve(name);
          if (r.kind === "found") {
            registryStatus = "resolvable";
            resolvedTo = `${r.person.displayName} (${r.person.stateHead}${r.person.isLeft ? ", LEFT" : ""})`;
          } else if (r.kind === "ambiguous") {
            registryStatus = "ambiguous";
            candidates = r.candidates.map((p) => `${p.displayName} (${p.stateHead})`);
          } else {
            registryStatus = "unknown";
          }
        }
        return {
          name,
          amount: Math.round(v.amount),
          saleAmount: Math.round(v.saleAmount ?? 0),
          registryStatus,
          resolvedTo,
          candidates,
        };
      })
      .sort((a, b) => b.amount - a.amount);
    const totalAmount = names.reduce((s, n) => s + n.amount, 0);
    const payload = {
      fy,
      count: names.length,
      totalAmount,
      registryAvailable: registry != null,
      names,
    };
    // Only cache once the registry is warm — a cold "unchecked" response
    // should upgrade on the next visit, not stick for 10 minutes.
    if (registry != null) _unmatchedCache.set(fy, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err, fy }, "unmatched-names failed");
    res.status(500).json({ error: "Could not compute unmatched order-booking names." });
  }
});

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
    const ordersFy = await defaultMgmtFy();
    const recorded = getOrderLoadStatus(ordersFy);
    if (recorded && recorded.status !== "no-file") {
      ordersStatus = recorded.status === "ok" ? "connected" : "partial";
      ordersDetail =
        recorded.status === "ok"
          ? `Order booking workbook connected for ${ordersFy} (${recorded.rowsRead ?? 0} rows read). Earlier years (2021-22 onwards) are connected.`
          : `${recorded.detail} Earlier years (2021-22 onwards) are connected.`;
    } else {
      try {
        const currentFyFile = await resolveOrderFileId(ordersFy);
        ordersStatus = currentFyFile ? "connected" : "partial";
        ordersDetail = currentFyFile
          ? "Order booking workbooks found for the selected years."
          : `No ${ordersFy} order booking workbook exists in the Drive folder yet; ${ordersFy} order columns will be blank until it is created. Earlier years (2021-22 onwards) are connected.`;
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
        // Dashboard identity columns are the working source of truth by
        // design (not a stopgap awaiting the HR file), so they count as
        // connected, not partial.
        status: roster ? "connected" : "missing",
        detail: roster
          ? roster.source === "hr_roster_csv"
            ? `${roster.members.length} team members from User_List.csv (HR SFA system — 35 columns: emp code, designation, DOJ, CTC, active/deactive status)`
            : roster.source === "hr_roster"
              ? `${roster.members.length} team members from Team Member Details.xlsx (Drive — 7 columns, identity only; no emp code or status)`
              : `${roster.members.length} team members from the live STATE HEAD DASHBOARD identity columns (fallback — emp code and status unavailable)`
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
    res.json({ fys, defaultFy: await defaultMgmtFy(), regions, states, sources, seasonalCalibration });
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
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
// ACTUALS split:
//   OB (orderedAmount)  — accumulated for all closed months, including sales-lag
//     months (notYetRecorded=true because sales=0 but ob>0).  The distributor
//     placed the order; it is a real figure even if receipt hasn't been entered.
//   SALES (salesAmount) — only from months where notYetRecorded=false.
//     A zero-sales closed month with positive OB is a data-entry lag, not a
//     genuine zero; stateDashboard.ts sets notYetRecorded=true for that case.
//   ACHIEVEMENT — computed only from hasClosedMonth (fully recorded months).
//     If every closed month in the period is in the sales-lag state,
//     achievement returns null, not 0.
//
// Return semantics:
//   plan null        → no planAmount data in the period at all (member has no target)
//   ob/sales 0       → plan exists but the period has no recorded actuals yet (future Q)
//   achievement null → plan is null OR no fully-recorded closed actuals yet
export function secPeriod(
  sec: SecMember,
  mFrom: number, // 1-based fiscal month (1 = Apr)
  mTo: number,   // 1-based fiscal month (12 = Mar)
): {
  plan: number | null; ob: number | null; sales: number | null;
  // planRecorded: plan summed over fully-recorded closed months only — the
  // achievement denominator.  Differs from `plan` when the period contains
  // future or sales-lag months (e.g. a full-FY selection in August).
  planRecorded: number;
  achievement: number | null;
  // recordedMonths: fully-recorded closed months in the period.
  // lagMonths:      sales-lag months (closed, OB entered, sales not yet received).
  // When lagMonths > 0 the achievement denominator ≠ the displayed plan —
  // callers expose a "N of M months recorded" marker in the UI.
  recordedMonths: number; lagMonths: number;
} {
  let plan = 0, planForAchievement = 0, ob = 0, sales = 0;
  let hasPlan = false, hasClosedMonth = false, hasObData = false;
  let recordedMonths = 0, lagMonths = 0;
  for (let i = mFrom - 1; i <= mTo - 1; i++) {
    const md = sec.months[i];
    if (!md) continue;
    // PLAN for display: always read — real for past AND future months.
    // PLAN for achievement denominator: only fully-recorded months.
    //   A sales-lag month (notYetRecorded=true) has a real plan figure, but since
    //   its sales are not yet in, including it in the denominator would understate
    //   achievement.  E.g. Apr=lag, May+Jun=recorded → denominator = May+Jun plan only.
    if (md.planAmount != null) { plan += md.planAmount; hasPlan = true; }
    if (!md.notYetRecorded) {
      // Fully recorded closed month: accumulate OB, sales, and plan-for-achievement.
      hasClosedMonth = true;
      hasObData = true;
      recordedMonths++;
      if (md.planAmount    != null) planForAchievement += md.planAmount;
      if (md.orderedAmount != null) ob    += md.orderedAmount;
      if (md.salesAmount   != null) sales += md.salesAmount;
    } else if (md.orderedAmount != null && md.orderedAmount > 0) {
      // Sales-lag month: notYetRecorded=true because sales=0 but ob>0.
      // OB was entered by the state head — include it; do not advance hasClosedMonth
      // (so it contributes neither a zero to sales nor its plan to the denominator).
      lagMonths++;
      hasObData = true;
      ob += md.orderedAmount;
    }
  }
  if (!hasPlan && !hasClosedMonth && !hasObData) {
    return { plan: null, ob: null, sales: null, planRecorded: 0, achievement: null, recordedMonths: 0, lagMonths: 0 };
  }
  return {
    plan: hasPlan ? plan : null,
    // 0 when there is a plan but the period has no OB at all yet (future Q).
    ob:    hasObData      ? ob    : 0,
    sales: hasClosedMonth ? (sales > 0 ? sales : 0) : 0,
    planRecorded: planForAchievement,
    // Denominator = sum of plan for fully-recorded months only.
    achievement: hasClosedMonth && planForAchievement > 0 ? sales / planForAchievement : null,
    recordedMonths,
    lagMonths,
  };
}

function serialDate(n: number | null): string | null {
  if (n == null || n <= 0) return null;
  return new Date((n - 25569) * 86400000).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

export function achBand(pct: number | null, hasTarget: boolean): string {
  if (!hasTarget || pct == null) return "noTarget";
  if (pct < 0.25) return "below25";
  if (pct < 0.50) return "below50";
  if (pct < 0.70) return "50to70";
  if (pct < 0.90) return "70to90";
  if (pct <= 1.00) return "90to100"; // Glossary v2: Emerald is strictly >100
  return "above100";
}

// GET /api/mgmt/data — live JSON view of the State Head Dashboard.
// Accepts: fy, monthFrom, monthTo (all optional, with defaults).
// Returns: { rows, meta }
router.get("/mgmt/data", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim() !== ""
      ? req.query.fy.trim()
      : await defaultMgmtFy();
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

  // _simulatedNow: ISO date string injected for testing the V4 arrears guard.
  // When present the mgmt-data cache is bypassed and the state dashboard is
  // loaded with the injected clock (does NOT write back to the in-process cache).
  const simulatedNowMs: number | undefined = (() => {
    const raw = req.query._simulatedNow;
    if (typeof raw !== "string" || !raw) return undefined;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : undefined;
  })();

  try {
    if (simulatedNowMs !== undefined) {
      // Simulated clock: bypass every cache and snapshot; never persist.
      const payload = await buildMgmtDataPayload(fy, monthFrom, monthTo, simulatedNowMs, req.log);
      res.json(payload);
      return;
    }

    // Shared snapshot layer: warm cache → instant; persisted snapshot →
    // instant with meta.snapshotSavedAt + meta.refreshing while a background
    // rebuild runs; first ever request → blocking live build.
    const payload = await serveWithSnapshot<MgmtDataPayload>({
      key: mgmtDataSnapshotKey(fy, monthFrom, monthTo),
      ttlMs: MGMT_DATA_TTL_MS,
      build: () => buildMgmtDataPayload(fy, monthFrom, monthTo, undefined, req.log),
      log: req.log,
      ...(() => {
        const since = periodFrozenSince(fy, monthFrom, monthTo);
        return since === null ? {} : { frozen: true, frozenSince: since };
      })(),
    });
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err, fy }, "mgmt data failed");
    res.status(500).json({
      error:
        "Could not load dashboard data. Google Sheets may be unavailable; try again in a minute.",
    });
  }
});

// ── Operational Coverage Review export ───────────────────────────────────────
// This is intentionally built from the same period-aware member payload as the
// Management/Sales Deep Dive surfaces.  It must not use canonical coverage
// tables: those are a separate, read-only evidence domain.
router.get(["/mgmt/coverage-review/export", "/master/coverage-review/export"], async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim()
      ? req.query.fy.trim()
      : await defaultMgmtFy();
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  const intQ = (key: string, lo: number, hi: number, fallback: number): number => {
    const value = Number(req.query[key]);
    return Number.isFinite(value) && value >= lo && value <= hi ? Math.round(value) : fallback;
  };
  const monthFrom = intQ("monthFrom", 1, 12, 1);
  const monthTo = intQ("monthTo", monthFrom, 12, 12);
  const requestedMonths = typeof req.query.periodMonths === "string"
    ? req.query.periodMonths.split(",").map(Number).filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
    : [];
  const effectiveMonthFrom = requestedMonths.length ? Math.min(...requestedMonths) : monthFrom;
  const effectiveMonthTo = requestedMonths.length ? Math.max(...requestedMonths) : monthTo;
  const stateHead = typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
  const member = typeof req.query.member === "string" ? req.query.member.trim() : "";
  const search = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

  try {
    // Coverage tiles on the page come from MemberKpis/Data-tab fields, not
    // /mgmt/data's smaller roster row. This keeps export parity with the page:
    // totalRetailers, visitedRetailers, nonVisitedRetailers,
    // newPartyOrderBooking, and businessPerRetailer.
    const kpis = await loadMemberKpisForStateHead(fy, stateHead || undefined);
    const hrSfa = await loadHrSfaDashboard().catch(() => new Map<string, HrSfaRecord>());
    const rawRows = (kpis ?? []).filter((row) => {
      if (member && row.normKey !== member) return false;
      if (search && !row.name.toLowerCase().includes(search)) return false;
      return true;
    });
    const byMember = rawRows.map((row) => mapOperationalCoverageKpis({
      ...row,
      // HR/SFA uses the same normSecKey identity as the management assembly.
      // Do not fall back to display-name matching: an absent or ambiguous
      // normalized identity must remain UNKNOWN.
      hrSfa: hrSfa.get(row.normKey) ?? null,
    }));
    const headMap = new Map<string, ReturnType<typeof mapOperationalCoverageKpis>[]>();
    for (const row of byMember) {
      const bucket = headMap.get(row.stateHead) ?? [];
      bucket.push(row);
      headMap.set(row.stateHead, bucket);
    }
    const sumKnown = (rows: ReturnType<typeof mapOperationalCoverageKpis>[], key: keyof Pick<ReturnType<typeof mapOperationalCoverageKpis>, "retailers" | "visited" | "notVisited" | "partiesGivingBusiness" | "businessAmount">): { value: number | null; state: "VALUE" | "ZERO" | "UNKNOWN" | "INCOMPLETE"; source: string } => {
      const values = rows.map((row) => row[key]).filter((value): value is number => value != null);
      const value = values.length ? values.reduce((sum, item) => sum + item, 0) : null;
      const sourceKey = {
        retailers: "retailersSource",
        visited: "visitedSource",
        notVisited: "notVisitedSource",
        partiesGivingBusiness: "partiesGivingBusinessSource",
        businessAmount: "businessAmountSource",
      }[key];
      const sourceLabels = [...new Set(rows.map((row) => (row as unknown as Record<string, unknown>)[sourceKey]).filter(Boolean))].join("; ");
      return {
        value,
        state: values.length === 0 ? "UNKNOWN" : values.length < rows.length ? "INCOMPLETE" : value === 0 ? "ZERO" : "VALUE",
        source: values.length < rows.length
          ? `${sourceLabels}; known subset ${values.length}/${rows.length}; incomplete head population`
          : `${sourceLabels}; sum of all selected member values`,
      };
    };
    const byHead = [...headMap.entries()].map(([head, rows]) => ({
      stateHead: head,
      member: `${rows.length} member${rows.length === 1 ? "" : "s"}`,
      retailers: sumKnown(rows, "retailers").value,
      retailersSource: sumKnown(rows, "retailers").source,
      visited: sumKnown(rows, "visited").value,
      visitedSource: sumKnown(rows, "visited").source,
      notVisited: sumKnown(rows, "notVisited").value,
      notVisitedSource: sumKnown(rows, "notVisited").source,
      partiesGivingBusiness: sumKnown(rows, "partiesGivingBusiness").value,
      partiesGivingBusinessSource: sumKnown(rows, "partiesGivingBusiness").source,
      businessAmount: sumKnown(rows, "businessAmount").value,
      businessAmountSource: sumKnown(rows, "businessAmount").source,
      businessPerRetailer: null,
      businessPerRetailerSource: "Unavailable at head scope; no complete operands for a derived ratio",
      states: {
        retailers: sumKnown(rows, "retailers").state,
        visited: sumKnown(rows, "visited").state,
        notVisited: sumKnown(rows, "notVisited").state,
        partiesGivingBusiness: sumKnown(rows, "partiesGivingBusiness").state,
        businessAmount: sumKnown(rows, "businessAmount").state,
        businessPerRetailer: "UNKNOWN" as const,
      },
    }));
    const dataReadAt = new Date().toISOString();
    const workbook = buildCoverageReviewWorkbook({
      byHead,
      byMember,
      filters: {
        stateHead: stateHead || "All",
        member: member || "All",
        search: search || "All",
      },
      fy,
      period: requestedMonths.length
        ? `Fiscal months ${requestedMonths.sort((a, b) => a - b).join(", ")}`
        : `Fiscal months ${effectiveMonthFrom}–${effectiveMonthTo}`,
      sources: "Member figures: STATE HEAD DASHBOARD — Data tab fields shown on Sales Deep Dive; parties-giving-business: HR/SFA Dashboard business received parties joined by normSecKey.",
      dataReadAt,
    });
    req.log.info(
      { export: "operational-coverage-review", sheets: workbookSheetEvidence(workbook), info: infoSheetEvidence(workbook) },
      "operational coverage review export generated",
    );
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="CoverageReview_${fy}_${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err, fy }, "operational coverage review export failed");
    res.status(500).json({ error: "Could not build the operational Coverage Review export." });
  }
});

// Full live build of the /mgmt/data payload from Sheets + DB sources.
// Pure with respect to caches: writes nothing — callers decide whether the
// result may be cached/persisted (a simulated clock must never be).
async function buildMgmtDataPayload(
  fy: string,
  monthFrom: number,
  monthTo: number,
  simulatedNowMs: number | undefined,
  log: MgmtLog,
): Promise<MgmtDataPayload> {
  const filters: ReportFilters = {
    fy, states: [], regions: [], monthFrom, monthTo, lowPerfPct: 50,
  };
  {
    const [assembled, hrSfa, secDash, dbTargetMap] = await Promise.all([
      assembleRows(filters),
      loadHrSfaDashboard().catch((): Map<string, HrSfaRecord> => new Map()),
      loadStateDashboard(fy, simulatedNowMs).catch((): null => null),
      // State Head Targets (primary_state_targets) override/supplement Target Master.
      buildPrimaryTargetMapFromStateTargets(fy).catch((): Map<string, number[]> => new Map()),
    ]);
    const { rows, ordersAvailable, targetsAvailable, rosterSource, orderStatus, nameMatches, xlsxTargetDiagnostic } = assembled;
    // Build a normKey (normSecKey) → SecMember[] multi-map.
    // normKey keeps parentheticals so "Ashutosh Kumar" and
    // "Ashutosh Kumar (Rudrapur)" are distinct keys with no collision.
    // Previously indexed by joinKey (normName, strips parentheticals) which
    // required state-head disambiguation on every collision; that is no longer
    // needed when every key is already unique.
    const secByKeyMulti = new Map<string, SecMember[]>();
    if (secDash) {
      for (const sm of secDash.members) {
        const bucket = secByKeyMulti.get(sm.normKey);
        if (bucket) {
          bucket.push(sm);
        } else {
          secByKeyMulti.set(sm.normKey, [sm]);
        }
      }
    }

    // Normalise a state head name for comparison: lowercase alpha only.
    const normSh = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

    // State-head-aware SHD member lookup.
    // • Unique key  → return the only candidate.
    // • Collision   → prefer the candidate whose stateHead matches the roster
    //                 row's stateHead; fall back to the first candidate when no
    //                 match is found (preserves previous behaviour for unknown cases).
    const secLookup = (normKey: string, rosterStateHead: string): SecMember | undefined => {
      const candidates = secByKeyMulti.get(normKey);
      if (!candidates) return undefined;
      if (candidates.length === 1) return candidates[0];
      const rsh = normSh(rosterStateHead);
      return candidates.find((c) => normSh(c.stateHead) === rsh) ?? candidates[0];
    };

    // Flat first-entry map — kept for the meta aggregate loop which iterates
    // secDash.members directly and does not use the per-row join path.
    const secByKey = new Map<string, SecMember>();
    for (const [key, bucket] of secByKeyMulti) {
      secByKey.set(key, bucket[0]);
    }

    // ── Primary sale (dispatch) + Order Booking — shared period-aware service ──
    // Single call handles FY/period/DB/Sheets routing internally; no branches here.
    const monthLabels = fiscalMonthsToLabels(fy, monthFrom, monthTo);
    let dispatchSaleByHead: Map<string, number> | null = null;
    let dispatchSaleSource: string | null = null;
    let salePeriodFiltered = false;
    let orderBookingPrimaryByHead: Map<string, number> | null = null;
    let orderBookingPrimarySource: string | null = null;
    let primaryBookingPeriodFiltered = false;
    let primarySaleTotal = 0;
    let primaryBookingTotal = 0;
    try {
      const primary = await loadPrimaryPeriodData(fy, monthLabels);
      if (primary.sale.total > 0) {
        dispatchSaleByHead = primary.sale.byHead;
        dispatchSaleSource = primary.sale.source;
        salePeriodFiltered = primary.sale.periodFiltered;
        primarySaleTotal = primary.sale.total;
      }
      if (primary.booking.total > 0) {
        orderBookingPrimaryByHead = primary.booking.byHead;
        orderBookingPrimarySource = primary.booking.source;
        primaryBookingPeriodFiltered = primary.booking.periodFiltered;
        primaryBookingTotal = primary.booking.total;
      }
      log.info(
        {
          fy,
          saleTotal: primary.sale.total,
          bookingTotal: primary.booking.total,
          saleFiltered: primary.sale.periodFiltered,
          bookingFiltered: primary.booking.periodFiltered,
        },
        "mgmt: primary period data loaded",
      );
    } catch (err) {
      log.warn({ err, fy }, "mgmt: primary period data load failed");
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
        log.warn({ err, fy }, "mgmt: primary attribution failed");
      }
    } else if (!distMap) {
      // Warm up the cache in the background on first request
      loadDistributorTmMap().catch((err) =>
        log.warn({ err }, "mgmt: dist-map background build failed"),
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
      const sec = secLookup(r.m.normKey, r.m.stateHead);
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
        designation: sfa?.designation ?? r.m.designation ?? null,
        empCode: r.m.empCode ?? null,
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
        secondaryPlan: sec ? (sp?.plan ?? 0) : null,
        secondaryOrderBooked: sp?.ob ?? null,
        secondarySalesReceived: sp?.sales ?? null,
        secondaryAchievement: sp?.achievement ?? null,
        // Achievement denominator: plan summed over fully-recorded closed months
        // only.  Lets filtered frontend views (single head/employee) divide
        // recorded sales by recorded-month plan — same basis as secondaryTotal.
        secondaryPlanRecorded: sp ? sp.planRecorded : null,
        // Present when at least one closed month in the period has OB entered but
        // sales not yet received (notYetRecorded=true, ob>0).  In that state the
        // achievement denominator is smaller than the displayed plan, so the UI
        // shows "N of M months recorded" next to the achievement figure.
        secondaryAchievementBasis: (sp && sp.lagMonths > 0)
          ? { recorded: sp.recordedMonths, lag: sp.lagMonths }
          : null,
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

    // Pending orders = primary order booking minus dispatched sale (company-wide).
    // Use the period service's own totals (byHead can be empty for FYs without
    // head attribution, but the company total is still period-exact).
    const obTotal = primaryBookingTotal;
    const saleTotal = primarySaleTotal;
    // Only meaningful when both sides cover the SAME period basis; a full-FY
    // sale against a period-filtered booking produces nonsense. When the
    // selected period IS the full FY, an FY-total side and a period-filtered
    // side cover the same months — treat as matching bases.
    // A negative result is legitimate (dispatches against prior-period orders)
    // and must be surfaced, not clamped to zero.
    const pendingBasisMatch =
      primaryBookingPeriodFiltered === salePeriodFiltered || monthLabels.length >= 12;
    const pendingOrdersTotal =
      obTotal > 0 && saleTotal > 0 && pendingBasisMatch
        ? obTotal - saleTotal
        : null;
    const pendingOrdersTotalNote =
      pendingOrdersTotal != null && pendingOrdersTotal < 0
        ? NEGATIVE_PENDING_NOTE
        : null;

    // PS1: period-specific company-level secondary totals for the meta block.
    // Sums secPeriod() across all members so the headline KPI tiles reflect
    // exactly the same [monthFrom, monthTo] window as the per-member rows.
    let _ptPlan = 0, _ptOB = 0, _ptSales = 0, _ptPlanRec = 0, _ptHasData = false;
    if (secDash) {
      for (const sm of secDash.members) {
        const smp = secPeriod(sm, monthFrom, monthTo);
        if (smp.plan != null) { _ptPlan += smp.plan; _ptHasData = true; }
        _ptOB    += smp.ob    ?? 0;
        _ptSales += smp.sales ?? 0;
        _ptPlanRec += smp.planRecorded;
      }
    }
    const periodSecTotal = secDash ? {
      plan: _ptHasData ? _ptPlan : secDash.totalPlan,
      orderBooked: _ptOB,
      salesReceived: _ptSales,
      // planRecorded: achievement denominator — plan for fully-recorded closed
      // months only.  When < plan, the period contains months with no recorded
      // sales yet; the frontend labels the achievement as closed-months-only.
      planRecorded: _ptPlanRec,
      // Achievement numerator (recorded sales) and denominator (recorded-month
      // plan) use the SAME month set — never period sales / full-period plan,
      // which would understate achievement whenever future months carry a plan.
      ytdAchievement: _ptHasData && _ptPlanRec > 0 ? _ptSales / _ptPlanRec : null,
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
        ...(pendingOrdersTotalNote != null ? { pendingOrdersTotalNote } : {}),
        // Raw sheet totals for OB (Primary) and Sale (Dispatched) tiles —
        // includes Non-territory + unresolved-head buckets that the per-head
        // breakdown filters out. Frontend uses these for the company-level tiles.
        ...(obTotal > 0 ? { primaryBookingRawTotal: obTotal } : {}),
        ...(saleTotal > 0 ? { saleRawTotal: saleTotal } : {}),
        // Period-filter flags: true = figure corresponds to the selected period,
        // false = figure is a FY total regardless of period selection.
        salePeriodFiltered,
        primaryBookingPeriodFiltered,
        // Secondary data: STATE HEAD DASHBOARD (authoritative for FY26-27 + FY25-26)
        secondarySource: secDash ? "state_head_dashboard" : null,
        // Unix ms timestamp of when the SOBR sheet was last read from Google Sheets.
        // Use this to attribute any figure difference to live-sheet drift rather than
        // investigating it as a code bug.  Re-read if the figure is questioned.
        secondaryReadAt: secDash ? secDash.loadedAt : null,
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
        // Seasonal calibration metadata so the frontend can show the active
        // versioned basis on any derived target column.
        seasonalCalibration: getSeasonalCalibration(),
      },
    };
    return responsePayload;
  }
}

// GET /api/mgmt/primary — focused primary (Prayag→Dist) performance data.
//
// Accepts: fy, monthFrom (1=Apr … 12=Mar), monthTo.
// byHead, companyBooking, companySale, companyPending — period-filtered.
// byDistributor, tabInventory — always FY total (no per-row date in the distributor column).
//
// bookingPeriodFiltered / salePeriodFiltered:
//   true  = figure corresponds to the selected period.
//   false = FY total (period tabs not yet available or historical FY).
router.get("/mgmt/primary", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim()
      ? req.query.fy.trim()
      : currentOpenFy();
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
  const monthLabels = fiscalMonthsToLabels(fy, monthFrom, monthTo);

  try {
    // Period data (byHead, company totals) + sheet data (distributor/inventory) in parallel.
    // Sheet data is always FY-level; period data is filtered to the requested window.
    const [primaryPeriod, sheetData] = await Promise.all([
      loadPrimaryPeriodData(fy, monthLabels),
      loadPrimarySheetData(fy),
    ]);

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

    // ── byHead — period-filtered, merged from booking + sale sides ────────────
    // Same shape as before (PrimaryHeadRow[]) but now reflects the selected period.
    const allHeadNames = new Set([
      ...primaryPeriod.booking.byHead.keys(),
      ...primaryPeriod.sale.byHead.keys(),
    ]);
    // Per-head sale attribution can be unavailable (FYs whose register has no
    // state-head column: sale total is period-exact but byHead is empty). In
    // that case a per-head pending of booking−0 would be fabricated — send null.
    const saleHeadsAvailable =
      primaryPeriod.sale.total <= 0 || primaryPeriod.sale.byHead.size > 0;
    // Pending is only meaningful when both sides cover the same period basis
    // (or the selection is the full FY, where an FY-total side matches anyway).
    const pendingBasisMatch =
      primaryPeriod.booking.periodFiltered === primaryPeriod.sale.periodFiltered ||
      monthLabels.length >= 12;
    const byHead = Array.from(allHeadNames)
      .map((head) => {
        const booking = primaryPeriod.booking.byHead.get(head) ?? 0;
        const sale = primaryPeriod.sale.byHead.get(head) ?? 0;
        const pending =
          saleHeadsAvailable && pendingBasisMatch ? booking - sale : null;
        return {
          head,
          booking,
          sale,
          pending,
          // Surface the reason when sale exceeded booking — a negative pending
          // is either prior-period orders being fulfilled (legitimate) or a data
          // fault.  Either way it must be visible, not clamped to zero.
          ...(pending != null && pending < 0
            ? { pendingNote: NEGATIVE_PENDING_NOTE }
            : {}),
        };
      })
      .sort((a, b) => b.booking - a.booking);

    const companyBooking = primaryPeriod.booking.total;
    const companySale = primaryPeriod.sale.total;
    const companyPending =
      companyBooking > 0 && companySale > 0 && pendingBasisMatch
        ? companyBooking - companySale
        : null;
    const companyPendingNote =
      companyPending != null && companyPending < 0 ? NEGATIVE_PENDING_NOTE : null;

    // Build head-level primary target map from state targets for use in the response.
    const dbHeadTargetMap = await buildPrimaryTargetMapFromStateTargets(fy).catch((): Map<string, number[]> => new Map());
    const headPrimaryTargets: Record<string, number | null> = {};
    for (const row of byHead) {
      const nk = normName(row.head);
      const monthly12 = nk ? dbHeadTargetMap.get(nk) : undefined;
      headPrimaryTargets[row.head] = monthly12 != null
        ? monthly12.reduce((s, v) => s + v, 0)
        : null;
    }

    res.json({
      fy,
      monthFrom,
      monthTo,
      companyBooking,
      companySale,
      companyPending,
      ...(companyPendingNote != null ? { companyPendingNote } : {}),
      byHead,
      byDistributor: sheetData.byDistributor,
      byMember,
      bridgeStatus,
      headPrimaryTargets,
      sources: {
        booking: primaryPeriod.booking.source,
        sale: primaryPeriod.sale.source,
      },
      bookingAvailable: companyBooking > 0,
      saleAvailable: companySale > 0,
      bookingPeriodFiltered: primaryPeriod.booking.periodFiltered,
      salePeriodFiltered: primaryPeriod.sale.periodFiltered,
      tabInventory: sheetData.tabInventory ?? null,
    });
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err, fy }, "mgmt primary failed");
    res.status(500).json({ error: "Could not load primary performance data." });
  }
});

router.post("/mgmt/report", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fy = typeof body.fy === "string" && body.fy.trim() !== "" ? body.fy.trim() : await defaultMgmtFy();
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
    // Unified low-performer threshold: 50% everywhere (matches the dashboard
    // filter and the "below 50%" achievement band boundary).
    lowPerfPct: intIn(body.lowPerfPct, 1, 100, 50),
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
router.get("/mgmt/verify", requireVerificationEndpointAccess, async (req: Request, res: Response): Promise<void> => {
  const raw = req.query.fy;
  const fy = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : await defaultMgmtFy();
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
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "pending-orders: loadFactoryPending threw");
    res.status(500).json({ error: "Could not load factory pending data." });
  }
});

// XLSX audit export uses exactly the same response builder as the JSON route.
// Keeping the workbook construction downstream of loadFactoryPending prevents
// the export and the page from silently reconciling different source rows.
router.get("/mgmt/pending-orders/export", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await loadFactoryPending();
    if (!result.attributionAvailable) {
      res.status(503).json({
        error: "Factory pending attribution data is unavailable; export was not generated.",
        attributionAvailable: false,
      });
      return;
    }
    const workbook = buildFactoryPendingWorkbook(result);
    const bytes = await workbook.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="FactoryPendingAudit_${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(Buffer.from(bytes));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "pending-orders export failed");
    res.status(500).json({ error: "Could not build the factory pending audit export." });
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
        : currentOpenFy();

    const selectedStateHead =
      typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : undefined;

    const memberRaw =
      typeof req.query.member === "string" ? req.query.member.trim() : undefined;

    req.log.info(
      { fy, selectedStateHead, member: memberRaw },
      "mgmt/deep-dive: request received",
    );

    // Registry-based member resolution — Ambiguous returns 400 before any data load.
    let memberKey: string | undefined;
    if (memberRaw) {
      const registry = await loadRegistry(fy);
      const resolved = registry?.resolve(
        memberRaw,
        selectedStateHead ? { stateHead: selectedStateHead } : undefined,
      );
      if (resolved?.kind === "ambiguous") {
        res.status(400).json({
          error: resolved.message,
          candidates: resolved.candidates.map((p) => ({
            displayName: p.displayName,
            stateHead: p.stateHead,
            hq: p.hq ?? null,
          })),
        });
        return;
      }
      memberKey = resolved?.kind === "found" ? resolved.person.nsk : normSecKey(memberRaw);
    }

    const result = await loadDeepDiveData(fy, selectedStateHead, memberKey);

    if (result.error && !result.stateHeads.length) {
      // Phase 5 (skuSpread) is DB-only — include it even when the Sheets
      // Data tab could not be loaded.
        res.status(502).json({
          error: result.error,
          skuSpread: result.skuSpread ?? null,
          seasonalCalibration: getSeasonalCalibration("2025-26"),
        });
      return;
    }

    // Sales Deep Dive must use the same pinned approved curve as Momentum.
    // Resolve explicitly: a missing approved calibration is an API error, not
    // permission to silently fall back to a flat /12 projection.
    res.json({
      ...result,
      seasonalCalibration: getSeasonalCalibration("2025-26"),
    });
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/deep-dive: handler threw");
    res.status(500).json({ error: "Could not load deep-dive data." });
  }
});

// Workbook generation is intentionally separate from the JSON endpoint.  A
// small keyed guard prevents two clicks (or two browser tabs) from doing the
// same expensive Sheets/DB work concurrently.
const deepDiveExportInFlight = new Map<string, Promise<Buffer>>();
const EXPORT_RETAILER_WAIT_MS = 20_000;

/**
 * The page endpoint deliberately returns quickly while a member working sheet
 * loads. An export is different: it is an audit artifact, so give the
 * already-single-flight member-sheet read a bounded opportunity to finish.
 * Re-entering loadDeepDiveData joins loadMemberSheet's in-flight promise; it
 * does not start another Sheets read.
 */
export async function loadDeepDiveDataForExport(
  fy: string,
  stateHead: string | undefined,
  memberKey: string,
): Promise<Awaited<ReturnType<typeof loadDeepDiveData>>> {
  let result = await loadDeepDiveData(fy, stateHead, memberKey);
  if (result.retailerDetail?.status !== "loading") return result;

  const deadline = Date.now() + EXPORT_RETAILER_WAIT_MS;
  while (result.retailerDetail?.status === "loading") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ...result,
        retailerDetail: {
          status: "loading",
          error: `Retailer detail remained loading for ${EXPORT_RETAILER_WAIT_MS}ms; export stopped waiting without claiming complete coverage.`,
        },
      };
    }
    const next = loadDeepDiveData(fy, stateHead, memberKey);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    const resolved = await Promise.race([next, timeout]);
    if (resolved == null) {
      return {
        ...result,
        retailerDetail: {
          status: "loading",
          error: `Retailer detail remained loading for ${EXPORT_RETAILER_WAIT_MS}ms; export stopped waiting without claiming complete coverage.`,
        },
      };
    }
    result = resolved;
  }
  return result;
}

const EXPORT_MONTHS = new Set(Array.from({ length: 12 }, (_, i) => i + 1));
export function normalizeDeepDiveExportPeriod(raw: unknown): number[] | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("periodMonths must be a comma-separated list");
  if (raw === "none") return [];
  const values = raw.split(",").map((v) => Number(v.trim()));
  if (values.length === 0 || values.length > 12 || values.some((v) => !Number.isInteger(v) || !EXPORT_MONTHS.has(v))) {
    throw new Error("periodMonths must contain only fiscal month indexes 1-12");
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function deepDiveExportGuardKey(
  fy: string,
  stateHead: string | undefined,
  memberKey: string,
  period: { months?: number[]; label: string; preset: string; month: string; fromDate: string; toDate: string },
): string {
  return [
    fy, stateHead ?? "", memberKey, period.months === undefined ? "*" : period.months.join(","),
    period.label, period.preset, period.month, period.fromDate, period.toDate,
  ].join("|");
}

router.get("/mgmt/deep-dive/export", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy =
      typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
        ? req.query.fy.trim()
        : currentOpenFy();
    const stateHeadRaw = typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
    const stateHead = stateHeadRaw || undefined;
    const memberRaw = typeof req.query.member === "string" ? req.query.member.trim() : "";
    if (!memberRaw && !stateHead) {
      res.status(400).json({ error: "member is required" });
      return;
    }
    let periodMonths: number[] | undefined;
    try {
      periodMonths = normalizeDeepDiveExportPeriod(req.query.periodMonths);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid periodMonths" });
      return;
    }
    if (!periodMonths && typeof req.query.periodMonth === "string") {
      const legacyIndex = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
        .indexOf(req.query.periodMonth.trim());
      if (legacyIndex >= 0) periodMonths = [legacyIndex + 1];
    }
    const periodLabelRaw = typeof req.query.periodLabel === "string" ? req.query.periodLabel.trim() : "";
    if (periodLabelRaw.length > 120 || /[\u0000-\u001f\u007f]/.test(periodLabelRaw)) {
      res.status(400).json({ error: "periodLabel is invalid or too long" });
      return;
    }
    const periodLabel = periodLabelRaw || "Full FY / current page selection";
    const periodPreset = typeof req.query.periodPreset === "string" ? req.query.periodPreset : "";
    const periodMonth = typeof req.query.periodMonth === "string" ? req.query.periodMonth : "";
    const fromDate = typeof req.query.fromDate === "string" ? req.query.fromDate : "";
    const toDate = typeof req.query.toDate === "string" ? req.query.toDate : "";
    if (!["", "today", "7d", "15d", "month", "custom"].includes(periodPreset) ||
        (periodMonth && !["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"].includes(periodMonth)) ||
        (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) ||
        (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate))) {
      res.status(400).json({ error: "period query input is invalid" });
      return;
    }
    const period = {
      months: periodMonths,
      label: periodLabel,
      preset: periodPreset,
      month: periodMonth,
      fromDate,
      toDate,
    };

    // Section C: an additional head-scope export.  This branch intentionally
    // runs before member identity resolution and leaves the established
    // member-level export path below byte-for-byte in scope and shape.
    if (!memberRaw && stateHead) {
      let headResult = await loadDeepDiveData(fy, stateHead, undefined, { skipExtras: true });
      let canonicalHead = stateHead;
      if (!headResult.teamSummary) {
        // State-head options are normally canonical already, but resolve
        // case/spacing differences defensively without guessing a member.
        const allResult = await loadDeepDiveData(fy, undefined, undefined, { skipExtras: true });
        const resolvedHead = allResult.stateHeads.find((candidate) => normName(candidate) === normName(stateHead));
        if (resolvedHead) {
          canonicalHead = resolvedHead;
          headResult = await loadDeepDiveData(fy, canonicalHead, undefined, { skipExtras: true });
        }
      }
      if (headResult.error && !headResult.teamSummary) throw new Error(headResult.error);
      const headKpis = await loadMemberKpisForStateHead(fy, canonicalHead);
      if (!headResult.teamSummary || !headKpis || headKpis.length === 0) {
        res.status(404).json({ error: `No members found under state head ${stateHead}.` });
        return;
      }

      const closedMonths = closedReportingMonthCount(fy);
      let periodMembers: Record<string, StateHeadPeriodMember> | undefined;
      let periodReportingMonthCount: number | null = null;
      let periodTeamOperands: {
        headlineOb: number | null;
        headlineTarget: number | null;
        lflOb: number | null;
        lflTarget: number | null;
      } | undefined;
      if (periodMonths !== undefined) {
        const monthlyRows = await db
          .select({
            headCanon: secondaryHeadMonths.headCanon,
            monthIdx: secondaryHeadMonths.monthIdx,
            planAmount: secondaryHeadMonths.planAmount,
            orderedAmount: secondaryHeadMonths.orderedAmount,
            receivedAmount: secondaryHeadMonths.receivedAmount,
          })
          .from(secondaryHeadMonths)
          .where(and(
            eq(secondaryHeadMonths.fy, fy),
            eq(secondaryHeadMonths.stateHead, canonicalHead),
          ))
          .orderBy(secondaryHeadMonths.monthIdx);
        const rowsByMember = new Map<string, typeof monthlyRows>();
        for (const row of monthlyRows) {
          const rows = rowsByMember.get(row.headCanon);
          if (rows) rows.push(row);
          else rowsByMember.set(row.headCanon, [row]);
        }
        // UI/API fiscal month indexes are 1=Apr..12=Mar; the authoritative
        // secondary_head_month table stores 0=Apr..11=Mar.
        const selectedSet = new Set(periodMonths.map((month) => month - 1));
        const selectedClosedMonths = periodMonths.filter((month) => month <= closedMonths).length;
        periodReportingMonthCount = selectedClosedMonths > 0 ? selectedClosedMonths : null;
        const selectedValue = (
          rows: typeof monthlyRows,
          field: "planAmount" | "orderedAmount" | "receivedAmount",
          label: string,
        ): { value: number | null; reason: string } => {
          const resolved = resolveAuthoritativePeriodValue(
            rows.map((row) => ({ monthIdx: Number(row.monthIdx), value: row[field] == null ? null : Number(row[field]) })),
            periodMonths,
            label,
          );
          const exactMonthSet = new Set(rows.map((row) => Number(row.monthIdx)));
          const exactRows = rows.length === periodMonths.length
            && exactMonthSet.size === periodMonths.length
            && [...selectedSet].every((month) => exactMonthSet.has(month));
          if (field === "planAmount" && exactRows && rows.every((row) => row[field] == null)) {
            return { value: null, reason: "No target recorded for the selected period." };
          }
          return resolved;
        };
        periodMembers = {};
        for (const member of headKpis) {
          const rows = (rowsByMember.get(member.normKey) ?? [])
            .filter((row) => selectedSet.has(Number(row.monthIdx)));
          const targetResult = selectedValue(rows, "planAmount", "target");
          const obResult = selectedValue(rows, "orderedAmount", "order booking");
          const salesResult = selectedValue(rows, "receivedAmount", "sales");
          const explicitNoTarget = targetResult.reason === "No target recorded for the selected period.";
          periodMembers[member.normKey] = {
            target: explicitNoTarget ? 0 : targetResult.value,
            orderBooking: obResult.value,
            sales: salesResult.value,
            source: "secondary_head_month authoritative monthly array",
            targetReason: targetResult.value == null ? targetResult.reason : undefined,
            orderBookingReason: obResult.value == null ? obResult.reason : undefined,
            salesReason: salesResult.value == null ? salesResult.reason : undefined,
            taBill: null,
            taReason: "T.A. is supplied only as a YTD Data-tab field and cannot be period-resolved.",
            coverageReason: "Coverage counts are supplied only as YTD Data-tab fields and cannot be period-resolved.",
          };
        }
        const activePeriodMembers = headKpis.filter((member) => !member.isLeft);
        const noTarget = (member: typeof headKpis[number]): boolean =>
          periodMembers?.[member.normKey].target == null
          && periodMembers?.[member.normKey].targetReason?.startsWith("No target recorded") === true;
        const knownTargets = activePeriodMembers.filter((member) => !noTarget(member));
        const headlineOb = activePeriodMembers.every((member) => periodMembers?.[member.normKey].orderBooking != null)
          ? activePeriodMembers.reduce((sum, member) => sum + periodMembers![member.normKey].orderBooking!, 0)
          : null;
        const headlineTarget = activePeriodMembers.every((member) => noTarget(member) || periodMembers?.[member.normKey].target != null)
          ? knownTargets.reduce((sum, member) => sum + periodMembers![member.normKey].target!, 0)
          : null;
        const lflMembers = activePeriodMembers.filter((member) => periodMembers![member.normKey].target != null
          && periodMembers![member.normKey].target! > 0);
        const unknownTarget = activePeriodMembers.some((member) =>
          periodMembers?.[member.normKey].target == null && !noTarget(member));
        const lflOb = !unknownTarget && lflMembers.every((member) => periodMembers?.[member.normKey].orderBooking != null)
          ? lflMembers.reduce((sum, member) => sum + periodMembers![member.normKey].orderBooking!, 0)
          : null;
        const lflTarget = !unknownTarget && lflMembers.every((member) => periodMembers?.[member.normKey].target != null)
          ? lflMembers.reduce((sum, member) => sum + periodMembers![member.normKey].target!, 0)
          : null;
        periodTeamOperands = { headlineOb, headlineTarget, lflOb, lflTarget };
      }
      const snapshots = await loadMemberTargetSnapshots(fy);
      const benchmarkRatios = periodMonths === undefined ? (snapshots ?? [])
        .filter((member) => !member.isLeft && member.saleAvailable && member.sale > 0 && member.ctcMonthly != null)
        .map((member) => ((member.ctcMonthly! * closedMonths) + (member.taBillYtd ?? 0)) / member.sale) : [];
      const benchmarkReturns = periodMonths === undefined ? (snapshots ?? [])
        .filter((member) => !member.isLeft && member.saleAvailable && member.sale > 0 && member.ctcMonthly != null)
        .map((member) => member.sale / ((member.ctcMonthly! * closedMonths) + (member.taBillYtd ?? 0)))
        .filter((value) => Number.isFinite(value)) : [];
      const median = (values: number[]): number | null => {
        if (values.length === 0) return null;
        const ordered = [...values].sort((a, b) => a - b);
        const middle = Math.floor(ordered.length / 2);
        return ordered.length % 2 === 0
          ? (ordered[middle - 1] + ordered[middle]) / 2
          : ordered[middle];
      };
      const companyBenchmark = {
        costRatio: median(benchmarkRatios),
        returnPerRupee: median(benchmarkReturns),
        source: "Resolved Data-tab member target snapshots",
        population: periodMonths === undefined
          ? "All active company members with cost and sales"
          : "Period-specific company benchmark unavailable; source snapshots are YTD",
        peerCount: benchmarkRatios.length,
      };
      const workbook = buildStateHeadDeepDiveWorkbook({
        fy,
        stateHead: canonicalHead,
        periodLabel,
        periodMonths,
        members: headKpis,
        teamSummary: headResult.teamSummary,
        reportingMonthCount: closedMonths,
        periodMembers,
        periodReportingMonthCount,
        periodTeamOperands,
        dataReadAt: headResult.dataReadAt,
        provisionalMonths: await provisionalMonthsExportInfo(fy),
        fromDbSnapshot: headResult.fromDbSnapshot,
        stale: headResult.stale,
        companyBenchmark,
        sources: {
          dashboard: "Resolved STATE HEAD DASHBOARD Data tab",
          cost: "Resolved STATE HEAD DASHBOARD Data tab cost fields",
          coverage: "Resolved STATE HEAD DASHBOARD Data tab coverage fields",
        },
      });
      const evidence = stateHeadWorkbookEvidence(workbook);
      req.log.info({ evidence, fy, stateHead: canonicalHead }, "mgmt/deep-dive head export generated");
      const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
      const filename = `SalesDeepDive_${safe(canonicalHead)}_${fy}_${safe(period.label)}_Team.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(bytes);
      return;
    }

    // Keep export identity resolution byte-for-byte aligned with the normal
    // deep-dive route. In particular, an ambiguous registry name is never
    // silently guessed.
    const registry = await loadRegistry(fy);
    const resolved = registry?.resolve(
      memberRaw,
      stateHead ? { stateHead } : undefined,
    );
    if (resolved?.kind === "ambiguous") {
      res.status(400).json({
        error: resolved.message,
        candidates: resolved.candidates.map((p) => ({
          displayName: p.displayName,
          stateHead: p.stateHead,
          hq: p.hq ?? null,
        })),
      });
      return;
    }
    if (resolved?.kind !== "found") {
      res.status(400).json({ error: "Selected member was not found in the identity registry." });
      return;
    }
    if (stateHead && normName(resolved.person.stateHead) !== normName(stateHead)) {
      res.status(400).json({
        error: `Selected member does not belong to state head ${stateHead}.`,
      });
      return;
    }
    const memberKey = resolved.person.nsk;
    const canonicalStateHead = resolved.person.stateHead;
    const guardKey = deepDiveExportGuardKey(fy, stateHead, memberKey, period);
    let work = deepDiveExportInFlight.get(guardKey);
    if (!work) {
      work = (async () => {
        const result = await loadDeepDiveDataForExport(fy, stateHead, memberKey);
        if (result.error && !result.kpis) throw new Error(result.error);
        if (!result.kpis) throw new Error("Selected member was not found.");
        const monthlyDbRows = await db
          .select({
            monthLabel: secondaryHeadMonths.monthLabel,
            monthIdx: secondaryHeadMonths.monthIdx,
            planAmount: secondaryHeadMonths.planAmount,
            orderedAmount: secondaryHeadMonths.orderedAmount,
            receivedAmount: secondaryHeadMonths.receivedAmount,
            achievementPct: secondaryHeadMonths.achievementPct,
            notYetRecorded: secondaryHeadMonths.notYetRecorded,
          })
          .from(secondaryHeadMonths)
          .where(and(
            eq(secondaryHeadMonths.fy, fy),
            // Exact resolved normKey only. Never use state-head/team joins or
            // roll subordinate rows into this selected-member workbook.
            eq(secondaryHeadMonths.headCanon, result.kpis.normKey),
            eq(secondaryHeadMonths.stateHead, canonicalStateHead),
          ))
          .orderBy(secondaryHeadMonths.monthIdx);
        const monthlyRows: DeepDiveMonthlyRow[] = monthlyDbRows.map((r) => ({
          monthLabel: r.monthLabel,
          monthIdx: Number(r.monthIdx),
          planAmount: r.planAmount == null ? null : Number(r.planAmount),
          orderedAmount: r.orderedAmount == null ? null : Number(r.orderedAmount),
          receivedAmount: r.receivedAmount == null ? null : Number(r.receivedAmount),
          achievementPct: r.achievementPct == null ? null : Number(r.achievementPct),
          notYetRecorded: Boolean(r.notYetRecorded),
        }));
        // Cost must use the same closed reporting window as the selected
        // sales metric, not the target-sheet tenure/pro-rata field (which can
        // lag the dashboard window).  This explicit count is passed to the
        // exporter so it cannot invent calendar semantics independently.
        const closedBoundaryCount = closedReportingMonthCount(fy);
        const closedBoundarySet = new Set(
          fyMonthLabels(fy).slice(0, closedBoundaryCount).map((_, index) => index),
        );
        const selectedMonthSet = periodMonths == null ? null : new Set(periodMonths.map((month) => month - 1));
        const selectedClosedCount = periodMonths == null ? null : [...selectedMonthSet!]
          .filter((month) => closedBoundarySet.has(month)).length;
        const rowClosedCount = monthlyRows.filter((row) =>
          (selectedMonthSet == null || selectedMonthSet.has(row.monthIdx))
          && !row.notYetRecorded
          && row.receivedAmount != null,
        ).length;
        const reportingMonthCandidate = selectedClosedCount ?? (rowClosedCount > 0 ? rowClosedCount : closedBoundaryCount);
        const reportingMonthCount = reportingMonthCandidate > 0
          ? reportingMonthCandidate
          : result.kpis.ctcMonthly != null && result.kpis.sale != null && result.kpis.sale > 0
            ? null
            : reportingMonthCandidate;
        const priorQuarterly = [
          result.kpis.lastYearQ1, result.kpis.lastYearQ2,
          result.kpis.lastYearQ3, result.kpis.lastYearQ4,
        ];
        const sortedPeriodMonths = periodMonths ? [...new Set(periodMonths)].sort((a, b) => a - b) : [];
        const quarterIndex = sortedPeriodMonths.length === 3
          && sortedPeriodMonths[2] - sortedPeriodMonths[0] === 2
          && sortedPeriodMonths.every((month, i) => month === sortedPeriodMonths[0] + i)
          && (sortedPeriodMonths[0] - 1) % 3 === 0
          ? Math.floor((sortedPeriodMonths[0] - 1) / 3) : null;
        const exactFullYear = sortedPeriodMonths.length === 12
          && sortedPeriodMonths.every((month, i) => month === i + 1);
        const priorFullYearOb = exactFullYear && priorQuarterly.every((v): v is number => v != null)
          ? priorQuarterly.reduce<number>((sum, v) => sum + v, 0) : null;
        const priorSamePeriodOb = quarterIndex != null && priorQuarterly[quarterIndex] != null
          ? priorQuarterly[quarterIndex]
          : exactFullYear ? priorFullYearOb : null;
        // Benchmarks are resolved from an explicit state-head peer population.
        // The member snapshot contains full current-FY/YTD figures only; when
        // a custom period is selected we disclose the benchmark as
        // unavailable rather than reusing a mismatched full-period median.
        const benchmarkPeers = periodMonths === undefined
          ? (await loadMemberTargetSnapshots(fy))?.filter((peer) =>
              !peer.isLeft
              && peer.stateHead === canonicalStateHead
              && peer.normKey !== result.kpis!.normKey,
            ) ?? []
          : [];
        const median = (values: number[]): number | null => {
          if (values.length === 0) return null;
          const sorted = [...values].sort((a, b) => a - b);
          const middle = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 0
            ? (sorted[middle - 1] + sorted[middle]) / 2
            : sorted[middle];
        };
        const benchmarkPeriod = periodMonths === undefined
          ? `FY ${fy} resolved YTD`
          : `${period.label} (period-specific peer payload unavailable)`;
        const benchmarkSource = "Resolved Data-tab member target snapshots";
        const selectedCostBasis: "ctcOnly" | "fullCost" =
          result.kpis.taBillStCost == null ? "ctcOnly" : "fullCost";
        const peerCostRatios = reportingMonthCount != null
          ? benchmarkPeers
            .filter((peer) => peer.saleAvailable && peer.sale > 0 && peer.ctcMonthly != null
              && (selectedCostBasis === "ctcOnly" || peer.taBillYtd != null))
            .map((peer) => {
              const knownCtc = peer.ctcMonthly! * reportingMonthCount;
              const comparableCost = selectedCostBasis === "fullCost"
                ? knownCtc + (peer.taBillYtd ?? 0)
                : knownCtc;
              return comparableCost / peer.sale * 100;
            })
          : [];
        const peerBusinessPerRetailer = benchmarkPeers
          .filter((peer) => peer.obAvailable && peer.totalRetailers != null && peer.totalRetailers > 0)
          .map((peer) => peer.obTotal / (peer.totalRetailers ?? 1));
        const benchmarks: DeepDiveBenchmark[] = [
          {
            metric: "costRatio",
            median: median(peerCostRatios),
            population: `active peers under state head ${canonicalStateHead}`,
            peerCount: peerCostRatios.length,
            period: benchmarkPeriod,
            source: benchmarkSource,
            basis: selectedCostBasis,
            reason: periodMonths === undefined ? undefined : "Period-specific peer values were not resolved.",
          },
          {
            metric: "businessPerRetailer",
            median: median(peerBusinessPerRetailer),
            population: `active peers under state head ${canonicalStateHead}`,
            peerCount: peerBusinessPerRetailer.length,
            period: benchmarkPeriod,
            source: benchmarkSource,
            reason: periodMonths === undefined ? undefined : "Period-specific peer values were not resolved.",
          },
          {
            metric: "attainment",
            median: median(benchmarkPeers
              .filter((peer) => peer.obAvailable && peer.totalTargetToDate != null && peer.totalTargetToDate > 0)
              .map((peer) => peer.obTotal / (peer.totalTargetToDate ?? 1) * 100)),
            population: `active peers under state head ${canonicalStateHead}`,
            peerCount: benchmarkPeers.filter((peer) => peer.obAvailable && peer.totalTargetToDate != null && peer.totalTargetToDate > 0).length,
            period: benchmarkPeriod,
            source: benchmarkSource,
            reason: periodMonths === undefined ? undefined : "Period-specific peer values were not resolved.",
          },
          {
            metric: "sales",
            median: median(benchmarkPeers.filter((peer) => peer.saleAvailable).map((peer) => peer.sale)),
            population: `active peers under state head ${canonicalStateHead}`,
            peerCount: benchmarkPeers.filter((peer) => peer.saleAvailable).length,
            period: benchmarkPeriod,
            source: benchmarkSource,
            reason: periodMonths === undefined ? undefined : "Period-specific peer values were not resolved.",
          },
          {
            metric: "orderBooking",
            median: median(benchmarkPeers.filter((peer) => peer.obAvailable).map((peer) => peer.obTotal)),
            population: `active peers under state head ${canonicalStateHead}`,
            peerCount: benchmarkPeers.filter((peer) => peer.obAvailable).length,
            period: benchmarkPeriod,
            source: benchmarkSource,
            reason: periodMonths === undefined ? undefined : "Period-specific peer values were not resolved.",
          },
        ];
        return buildDeepDiveExport({
          fy,
          kpis: result.kpis,
          monthlyRows,
          reportingMonthCount,
          periodAnalysis: buildDeepDivePeriodAnalysis(
            result.retailerDetail?.status === "ok" ? result.retailerDetail.months : null,
            periodMonths,
            monthlyRows,
            {
              priorSamePeriodOb,
              priorFullYearOb,
              priorSamePeriodSales: null,
              priorFullYearSales: null,
            },
          ),
          periodLabel: period.label,
          periodMonths,
          dataReadAt: result.dataReadAt,
          provisionalMonths: await provisionalMonthsExportInfo(fy),
          fromDbSnapshot: result.fromDbSnapshot,
          stale: result.stale,
          retailerDetailStatus: result.retailerDetail?.status ?? "not-loaded",
          retailerRowCount: result.retailerDetail?.status === "ok"
            ? result.retailerDetail.rows.length
            : null,
          retailerDetail: result.retailerDetail,
          roiCost: result.roiCost,
          skuSpread: result.skuSpread,
          winBack: result.winBack,
          benchmarks,
          skuSpreadIncluded: result.skuSpread != null,
          winBackIncluded: result.winBack != null,
        });
      })();
      deepDiveExportInFlight.set(guardKey, work);
      void work.then(
        () => deepDiveExportInFlight.delete(guardKey),
        () => deepDiveExportInFlight.delete(guardKey),
      );
    }
    const buffer = await work;
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    const filename = `SalesDeepDive_${safe(resolved.person.displayName)}_${fy}_${safe(period.label)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(buffer);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/deep-dive/export failed");
    if (!res.headersSent) res.status(500).json({ error: "Could not generate deep-dive workbook." });
  }
});

// GET /api/mgmt/retailer-drift
// Per-member drift between the Data tab typed retailer count and the member
// working-sheet row count. Maintenance signal per State Head — sheet is the
// fresher source; typed>sheet flags possible unrecorded retailers.
router.get("/mgmt/retailer-drift", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim() : currentOpenFy();
    const stateHead = typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
    if (!stateHead) { res.status(400).json({ error: "stateHead is required" }); return; }

    const { loadRetailerDrift } = await import("../lib/mgmt/retailerDrift.js");
    const result = await loadRetailerDrift(fy, stateHead);
    res.json(result);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/retailer-drift: handler threw");
    res.status(500).json({ error: "Could not load retailer drift report." });
  }
});

// GET /api/mgmt/retailer-identity
// Task 172: retailer identity acceptance report — distinct RET# per FY,
// RET#s with multiple spellings (ONE retailer each), same-name distinct
// RET#s (RESOLVED-DIFFERENT — reported, never merged), and rows still
// resolving via the name+geography fallback.
router.get("/mgmt/retailer-identity", async (req: Request, res: Response): Promise<void> => {
  try {
    const { buildRetailerIdentityReport } = await import("../lib/mgmt/retailerRegistry.js");
    res.json(await buildRetailerIdentityReport());
  } catch (err) {
    req.log.error({ err }, "mgmt/retailer-identity: handler threw");
    res.status(500).json({ error: "Could not build retailer identity report." });
  }
});

// GET /api/mgmt/distributor-deep-dive
// Phase D1: groups retailer rows from all member working sheets under a state
// head by their Assigned Distributor field.
//
// Optional: ?months=Apr-26,May-26  — restricts register-derived figures
// (primary dispatch, flow gap) to the named months.  Sheet-based figures
// (OB, secondary out from member sheets) are always full-FY.  Filtered
// requests bypass the snapshot entirely (never served from or written to it).
router.get("/mgmt/distributor-deep-dive", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy         = typeof req.query.fy         === "string" ? req.query.fy.trim()         : currentOpenFy();
    const stateHead  = typeof req.query.stateHead  === "string" ? req.query.stateHead.trim()  : undefined;

    // Parse optional period filter — same validation as distributor-tab.
    let months: string[] | undefined;
    if (typeof req.query.months === "string" && req.query.months.trim() !== "") {
      const tokens = req.query.months.split(",").map((m) => m.trim());
      if (tokens.some((m) => !/^[A-Z][a-z]{2}-\d{2}$/.test(m))) {
        res.status(400).json({ error: "months must be comma-separated labels like Apr-26" });
        return;
      }
      months = tokens;
    }
    req.log.info({ fy, stateHead, months }, "mgmt/distributor-deep-dive: request received");

    // Resilient loader: a transient Sheets failure serves the last saved
    // snapshot with a `stale` flag instead of a hard 500 (see distributorDeepDive.ts).
    // Filtered requests always go live (bypassSnapshot is implicitly handled
    // inside loadDistributorDeepDiveResilient when months are provided).
    const { loadDistributorDeepDiveResilient } = await import("../lib/mgmt/distributorDeepDive.js");
    const result = await loadDistributorDeepDiveResilient(fy, stateHead, undefined, months);
    res.json(result);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/distributor-deep-dive: handler threw");
    res.status(500).json({ error: "Could not load distributor deep-dive data." });
  }
});

// GET /api/mgmt/distributor-deep-dive/export
// Six-sheet, source-labelled workbook for the same scope as the Distributor
// Deep Dive payload.  The directory and identity counts are deliberately
// loaded independently so Info can explain a 191-of-269 scope without a
// hardcoded claim.
const distributorDeepDiveExportInFlight = new Set<string>();
const MAX_DISTRIBUTOR_DEEP_DIVE_EXPORTS = 2;
router.get("/mgmt/distributor-deep-dive/export", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = typeof req.query.fy === "string" ? req.query.fy.trim() : currentOpenFy();
    const stateHead = typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
    const distributorFilter = typeof req.query.dist === "string" ? req.query.dist.trim() : "";
    const geoLabel = typeof req.query.geo === "string" ? req.query.geo.trim() : "All India";
    const selectedStates = typeof req.query.states === "string"
      ? req.query.states.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const months = typeof req.query.months === "string" && req.query.months.trim()
      ? req.query.months.split(",").map((m) => m.trim())
      : [];
    if (months.some((m) => !/^[A-Z][a-z]{2}-\d{2}$/.test(m))) {
      res.status(400).json({ error: "months must be comma-separated labels like Apr-26" });
      return;
    }
    if (!stateHead) {
      res.status(400).json({ error: "stateHead is required for a distributor deep-dive export" });
      return;
    }
    const guardKey = [fy, stateHead, distributorFilter, selectedStates.join(","), months.join(",")].join("|");
    if (distributorDeepDiveExportInFlight.has(guardKey)) {
      res.status(409).json({ error: "An identical distributor export is already being generated." });
      return;
    }
    if (distributorDeepDiveExportInFlight.size >= MAX_DISTRIBUTOR_DEEP_DIVE_EXPORTS) {
      res.status(429).json({ error: "Distributor export capacity is busy; retry shortly." });
      return;
    }
    distributorDeepDiveExportInFlight.add(guardKey);
    try {
    const { loadDistributorDeepDiveResilient } = await import("../lib/mgmt/distributorDeepDive.js");
    const [{ result, directory, registry }, provisional, holds] = await Promise.all([
      (async () => {
        const [result, directory, registry] = await Promise.all([
          loadDistributorDeepDiveResilient(fy, stateHead, undefined, months.length ? months : undefined),
          (async () => {
            const { loadDistributorDirectory } = await import("../lib/mgmt/distributorDirectory.js");
            return loadDistributorDirectory(fy);
          })(),
          (async () => {
            const { loadDistributorRegistry } = await import("../lib/mgmt/distributorRegistry.js");
            return loadDistributorRegistry();
          })(),
        ]);
        return { result, directory, registry };
      })(),
      provisionalMonthsExportInfo(fy),
      getOpenResolutionHolds(),
    ]);
    const allowed = new Set(directory.distributors
      .filter((d) => (!selectedStates.length || d.states.some((s) => selectedStates.includes(s)))
        && (!distributorFilter || d.distKey === distributorFilter))
      .map((d) => d.distKey));
    const scopedResult = {
      ...result,
      distributors: result.distributors.filter((d) => allowed.has(d.normKey)),
      sharedRetailers: result.sharedRetailers.filter((r) => r.distributorParts.some((p) => {
        const key = p.trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
        return allowed.has(key);
      })),
    };
    const { secondaryCoverageNote } = await import("../lib/mgmt/skuSpread.js");
    const buf = await buildDistributorDeepDiveExport({
      result: scopedResult,
      directoryCount: allowed.size,
      identityCount: registry.records.length,
      directoryMemberCount: directory.distributors.filter((d) => allowed.has(d.distKey)).reduce((n, d) => n + d.members.length, 0),
      directoryStateCount: new Set(directory.distributors.filter((d) => allowed.has(d.distKey)).flatMap((d) => d.states)).size,
      directoryHeadCount: new Set(directory.distributors.filter((d) => allowed.has(d.distKey)).flatMap((d) => d.heads)).size,
      stateHead,
      geoLabel,
      distributorFilter,
      months,
      periodLabel: months.length ? months.join("–") : "Full FY",
      provisionalMonths: provisional,
      secondaryCoverage: await secondaryCoverageNote(fy) ?? null,
      selectedStates,
      activeHolds: holds.map((h) => `${h.code ?? h.id}: ${h.title}`),
      generatedAt: new Date(),
    });
    const safeFy = fy.replace(/[^0-9-]/g, "");
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Distributor_Deep_Dive_${safeFy}.xlsx"`,
      "Content-Length": buf.length,
    });
    res.send(buf);
    } finally {
      distributorDeepDiveExportInFlight.delete(guardKey);
    }
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/distributor-deep-dive/export failed");
    res.status(500).json({ error: "Could not generate distributor deep-dive workbook." });
  }
});

// GET /api/mgmt/distributor-recon — vocabulary reconciliation report
router.get("/mgmt/distributor-recon", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = String(req.query.fy ?? currentOpenFy());
    const { buildDistributorRecon } = await import("../lib/mgmt/distributorTabs.js");
    res.json(await buildDistributorRecon(fy));
  } catch (err) {
    req.log.error({ err }, "mgmt/distributor-recon: handler threw");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/mgmt/distributor-tab?fy=&dist=<normKey>&tab=secondary|sku|push
router.get("/mgmt/distributor-tab", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = String(req.query.fy ?? currentOpenFy());
    const dist = String(req.query.dist ?? "");
    const tab = String(req.query.tab ?? "");
    // Optional global-period restriction: "Apr-26,May-26". Whole FY when absent.
    // Fail closed: an invalid token 400s rather than silently widening to the full FY.
    let months: string[] | null = null;
    if (typeof req.query.months === "string" && req.query.months.trim() !== "") {
      const tokens = req.query.months.split(",").map((m) => m.trim());
      const { MONTH_LABEL_RE } = await import("../lib/mgmt/distributorTabs.js");
      if (tokens.some((m) => !MONTH_LABEL_RE.test(m))) {
        res.status(400).json({ error: "months must be comma-separated labels like Apr-26" });
        return;
      }
      months = tokens;
    }
    // Validate scope and tab before applying data-availability holds. Invalid
    // requests must remain 400s even while a requested period is held.
    const head = String(req.query.head ?? "").trim();
    const statesRaw = String(req.query.states ?? "").trim();
    const geoStates = statesRaw ? statesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (!dist && !head) {
      res.status(400).json({ error: "dist (distributor normKey) or head (state head name) is required" });
      return;
    }
    const VALID_TABS = new Set(["secondary", "sku", "push"]);
    if (!VALID_TABS.has(tab)) {
      res.status(400).json({ error: "tab must be secondary | sku | push" });
      return;
    }
    if (tab === "secondary" || tab === "sku") {
      const secondaryExclusions = (await getOpenResolutionHolds()).flatMap((hold) =>
        resolveHoldExclusionsFromRows({
          measure: "secondary SKU",
          product: "secondary SKU",
          requestedPeriods: months ?? fyMonthLabels(fy),
        }, [hold]),
      );
      if (secondaryExclusions.length > 0) {
        res.json({
          fy, tab, availability: "unavailable", value: null,
          exclusions: secondaryExclusions, data: [],
        });
        return;
      }
    }
    // Head-scoped aggregation: when no single distributor is picked, a state
    // head (optionally narrowed by geography states) can scope the Secondary
    // and SKU tabs across every distributor served by that head's team.
    // Validate tab early — before any registry or Sheets loads — so a bad
    // tab value returns 400 immediately without waiting on a cold-cache
    // registry load (which can take >30 s and cause the guard to see
    // status=-1 rather than a clean 400).
    // The head-scope path further restricts push to dist-only below, but
    // this catches obviously wrong values before any async work starts.
    const tabs = await import("../lib/mgmt/distributorTabs.js");
    if (!dist) {
      if (tab === "push") {
        res.status(400).json({ error: "The push tab is per-distributor — pick a single distributor." });
        return;
      }
      const { loadDistributorDirectory } = await import("../lib/mgmt/distributorDirectory.js");
      const dir = await loadDistributorDirectory(fy);
      const candidateKeys = dir.distributors
        .filter((d) =>
          d.heads.includes(head) &&
          (geoStates === null || d.states.length === 0 || d.states.some((s) => geoStates.includes(s))))
        .map((d) => d.distKey);
      if (candidateKeys.length === 0) {
        res.status(404).json({
          error: `${head} has no distributors mapped in the ${fy} directory${geoStates ? " within the selected geography" : ""} — nothing to aggregate yet. This usually means the head's member working sheets carry no distributor assignments.`,
        });
        return;
      }
      // Same fail-closed identity rule as the single-distributor path: a
      // normKey covering more than one DIST# identity must never be blended.
      // Ambiguous keys are EXCLUDED from the aggregate and disclosed in the
      // label rather than silently merged.
      let keys: string[];
      let ambiguousCount = 0;
      try {
        const { loadDistributorRegistry } = await import("../lib/mgmt/distributorRegistry.js");
        const registry = await loadDistributorRegistry();
        keys = candidateKeys.filter((k) => {
          const r = registry.resolve(k);
          if (r.kind === "ambiguous") { ambiguousCount += 1; return false; }
          return true;
        });
      } catch (regErr) {
        req.log.error({ err: regErr }, "mgmt/distributor-tab: registry unavailable — failing closed (head scope)");
        res.status(503).json({
          error:
            "Distributor identity registry is unavailable, so the head's distributor names cannot be verified as single identities. Retry shortly.",
        });
        return;
      }
      if (keys.length === 0) {
        res.status(409).json({ error: `Every distributor name under ${head} is ambiguous in the identity registry — resolve them before aggregating.` });
        return;
      }
      const scope = {
        keys,
        label: `${head} — ${keys.length} distributor${keys.length === 1 ? "" : "s"}${ambiguousCount > 0 ? ` (${ambiguousCount} ambiguous name${ambiguousCount === 1 ? "" : "s"} excluded)` : ""}`,
      };
      if (tab === "secondary") res.json(await tabs.buildSecondaryTab(fy, scope, months));
      else if (tab === "sku") res.json(await tabs.buildSkuEvolution(fy, scope, months));
      else res.status(400).json({ error: "tab must be secondary | sku | push" });
      return;
    }
    // Shared identity registry: if this normKey covers more than one DIST#
    // identity, refuse rather than silently blend two distributors' figures.
    // FAIL CLOSED: if the registry cannot be loaded we cannot rule out an
    // ambiguous key, so refuse (503) rather than silently blend two
    // distributors' figures — exactly the error this guard exists to prevent.
    try {
      const { loadDistributorRegistry } = await import("../lib/mgmt/distributorRegistry.js");
      const registry = await loadDistributorRegistry();
      const resolved = registry.resolve(dist);
      if (resolved.kind === "ambiguous") {
        res.status(400).json({ error: resolved.message, candidates: resolved.candidates });
        return;
      }
    } catch (regErr) {
      req.log.error({ err: regErr }, "mgmt/distributor-tab: registry unavailable — failing closed");
      res.status(503).json({
        error:
          "Distributor identity registry is unavailable, so this name cannot be verified as one distributor. Retry shortly.",
      });
      return;
    }
    if (tab === "secondary") res.json(await tabs.buildSecondaryTab(fy, dist, months));
    else if (tab === "sku") res.json(await tabs.buildSkuEvolution(fy, dist, months));
    else if (tab === "push") res.json(await tabs.buildPushTab(fy, dist, months));
    else res.status(400).json({ error: "tab must be secondary | sku | push" });
  } catch (err) {
    req.log.error({ err }, "mgmt/distributor-tab: handler threw");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/mgmt/distributor-directory
// Cross-head distributor index for the Geography → Distributor → State Head
// filter chain. Snapshot-backed per head; canonical state vocabulary.
router.get("/mgmt/distributor-directory", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = typeof req.query.fy === "string" ? req.query.fy.trim() : currentOpenFy();
    const { loadDistributorDirectory } = await import("../lib/mgmt/distributorDirectory.js");
    res.json(await loadDistributorDirectory(fy));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/distributor-directory: handler threw");
    res.status(500).json({ error: "Could not build the distributor directory." });
  }
});

// GET /api/mgmt/distributor-identity?fy=
// Distributor identity report: registry counts, transacting distributors with
// no DIST# (name+state+district identity fallback), and similar-name candidate
// pairs with ID/state/district/value — reported for a human decision, NEVER
// auto-merged. Pairs transacting in the same period are RESOLVED-DIFFERENT.
router.get("/mgmt/distributor-identity", async (req: Request, res: Response): Promise<void> => {
  try {
    const fy = typeof req.query.fy === "string" ? req.query.fy.trim() : currentOpenFy();
    const { buildDistributorIdentityReport } = await import("../lib/mgmt/distributorRegistry.js");
    res.json(await buildDistributorIdentityReport(fy));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/distributor-identity: handler threw");
    res.status(500).json({ error: "Could not build the distributor identity report." });
  }
});

// GET /api/mgmt/member-sheet-coverage
// Acceptance metric for the shared member-sheet resolver: per state head, how
// many roster members have a mapped working sheet (config/member_sheet_map.json,
// bundled — identical in dev and production). Lists the unmapped names.
router.get("/mgmt/member-sheet-coverage", async (req: Request, res: Response): Promise<void> => {
  try {
    const { coverageByHead } = await import("../lib/mgmt/memberResolver.js");
    const includeLeft = req.query.includeLeft === "1" || req.query.includeLeft === "true";
    const heads = await coverageByHead(includeLeft);
    const totals = heads.reduce(
      (a, h) => ({ members: a.members + h.members, withSheet: a.withSheet + h.withSheet }),
      { members: 0, withSheet: 0 },
    );
    res.json({ source: "config/member_sheet_map.json (bundled)", totals, heads });
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "mgmt/member-sheet-coverage: handler threw");
    res.status(500).json({ error: "Could not compute member-sheet coverage." });
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
      ? req.query.fy.trim() : currentOpenFy();
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

// ── POST /admin/roster/refresh ────────────────────────────────────────────────
// Accepts a fresh User_List.csv export from the HR SFA system, overwrites
// config/hr_roster.csv, clears the in-process roster cache and all mgmt-data
// snapshots, and returns the updated active-member count.
//
// Auth: X-Admin-Secret: <ADMIN_SECRET> header required (same pattern as
//       POST /registers/:fy/lock-month-anchor).  ADMIN_SECRET is the
//       dedicated operator credential; a DB API key is not sufficient authority
//       for durable config mutations. SESSION_SECRET is separate — it signs
//       session cookies and must never be used here.
//
// Usage:
//   curl -X POST /api/admin/roster/refresh \
//        -H "Content-Type: text/csv" \
//        -H "X-Admin-Secret: $ADMIN_SECRET" \
//        --data-binary @User_List.csv
//
// The body must be UTF-8 CSV with the 35-column User_List.csv schema.  Exact
// required header columns ("Name", "Status") are validated before the file is
// written; at least one parseable data row is required.
router.post(
  "/admin/roster/refresh",
  express.raw({ type: "*/*", limit: "20mb" }),
  async (req: Request, res: Response): Promise<void> => {
    // ── 1. Admin auth ──────────────────────────────────────────────────────
    const adminSecret = String(req.headers["x-admin-secret"] ?? "").trim();
    if (!isAdminToken(adminSecret)) {
      res.status(401).json({
        error: "Admin authorisation required. Pass ADMIN_SECRET as: X-Admin-Secret: <ADMIN_SECRET>",
      });
      return;
    }

    try {
      // ── 2. Body present ────────────────────────────────────────────────
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({
          error: "Send the User_List.csv file as the raw request body (Content-Type: text/csv or application/octet-stream).",
        });
        return;
      }

      const csvText = req.body.toString("utf8");
      const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        res.status(422).json({
          error: "The uploaded file has fewer than two lines — it does not look like a valid User_List.csv.",
        });
        return;
      }

      // ── 3. Exact header validation ─────────────────────────────────────
      // Split only the first line into column headers using a simple comma
      // split (sufficient for the header row which never has quoted commas).
      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
      const missing: string[] = [];
      for (const required of ["name", "status"]) {
        if (!headers.includes(required)) missing.push(required);
      }
      if (missing.length > 0) {
        res.status(422).json({
          error: `The uploaded CSV is missing required column(s): ${missing.map((c) => `"${c}"`).join(", ")}. ` +
            "This does not look like a User_List.csv from the HR SFA system.",
          detectedHeaders: headers.slice(0, 10),
        });
        return;
      }

      // ── 4. At least one parseable data row ────────────────────────────
      // The second line must have the same number of commas as the header
      // (a rough structural check before we overwrite the live file).
      const headerColCount = headers.length;
      const secondLineColCount = lines[1].split(",").length;
      if (secondLineColCount < Math.max(5, Math.floor(headerColCount * 0.5))) {
        res.status(422).json({
          error: "The first data row has far fewer columns than the header — the file may be truncated or misformatted.",
          headerColumns: headerColCount,
          dataRowColumns: secondLineColCount,
        });
        return;
      }

      // ── 5. Atomic write + GCS persist + invalidate ────────────────────
      // Always write to the canonical runtime-writable path (uploads/) so uploads
      // land in the same location that GCS restores write to — NOT the dist/config
      // path which does not exist in the production build output.
      const csvPath = hrRosterCsvWritePath();
      const tmpPath = `${csvPath}.tmp`;
      // Ensure the parent directory exists (uploads/ is created on demand).
      await mkdirAsync(dirname(csvPath), { recursive: true });
      await writeFile(tmpPath, csvText, "utf8");
      await renameFile(tmpPath, csvPath);
      req.log.info(
        { csvPath, bytes: req.body.length, rows: lines.length - 1 },
        "admin/roster/refresh: hr_roster.csv overwritten",
      );

      // Persist to object storage so the file survives deployment restarts.
      // Non-blocking — failure is logged but does NOT fail the request.
      void saveRosterCsvToGcs(csvText).catch((err) =>
        req.log.warn({ err }, "admin/roster/refresh: GCS persist failed (non-fatal)"),
      );

      // Clear caches so the next request re-reads the new file.
      invalidateRosterCache();
      invalidateMgmtDataCache();

      // ── 6. Return new counts ───────────────────────────────────────────
      const roster = await loadRoster();
      const activeCount = roster.members.filter((m) => !m.activeLeft || m.activeLeft === "Active").length;

      res.json({
        ok: true,
        memberCount: roster.members.length,
        activeCount,
        csvRows: lines.length - 1,
        source: roster.source,
        csvPath,
        refreshedAt: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, "admin/roster/refresh failed");
      res.status(500).json({ error: "Could not refresh the roster CSV." });
    }
  },
);

export default router;
