import { Router } from "express";
import { loadDeepDiveData } from "../lib/mgmt/deepDiveData.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { loadStateDashboard, type SecMember } from "../lib/mgmt/stateDashboard.js";
import { buildMemberPayload } from "../lib/mgmt/aiPayload.js";
import {
  computeMemberWarnings,
  splitWarnings,
  computeUnassignedStats,
} from "../lib/mgmt/warnings/engine.js";
import type { MemberWarnings, WarningsResponse } from "../lib/mgmt/warnings/types.js";
import {
  serveWithSnapshot,
  prewarmSnapshot,
  SnapshotHttpError,
} from "../lib/payloadSnapshot.js";
import { logger } from "../lib/logger.js";

const router = Router();

// In-process warm-cache TTL — matches the state dashboard's own 15-min TTL
// closely enough that a warm hit never serves figures older than one dashboard
// refresh cycle.
const WARNINGS_TTL_MS = 10 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fyElapsedFraction(fy: string): number {
  const startY = parseInt(fy.split("-")[0], 10);
  if (isNaN(startY)) return 0.25;
  const fyStart = new Date(startY, 3, 1); // Apr 1
  const fyEnd = new Date(startY + 1, 2, 31, 23, 59, 59); // Mar 31
  const now = new Date();
  if (now >= fyEnd) return 1;
  if (now <= fyStart) return 0;
  return (now.getTime() - fyStart.getTime()) / (fyEnd.getTime() - fyStart.getTime());
}

// Working-day norm for the elapsed portion of the FY.
// Mon-Sat (6-day week). Q1 = 91 days × 6/7 ≈ 78. Use 65 as a conservative
// field norm (not every member is in field all 6 days).
const TEAM_NORM_WORKING_DAYS = 65;

// ── GET /api/warnings ─────────────────────────────────────────────────────────

router.get("/warnings", async (req, res) => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim()
      ? req.query.fy.trim()
      : "2026-27";

  const stateHeadRaw =
    typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";

  if (!stateHeadRaw) {
    res.status(400).json({ error: "stateHead query parameter is required" });
    return;
  }

  req.log?.info({ fy, stateHead: stateHeadRaw }, "warnings: request");

  try {
    // Cold-start fast path: serve the last persisted payload instantly with
    // meta.snapshotSavedAt + meta.refreshing, rebuilding in the background
    // (the live build blocks ~9s on Sheets loads on a cold cache).
    const response = await serveWithSnapshot({
      key: `warnings|${fy}|${stateHeadRaw.toLowerCase()}`,
      ttlMs: WARNINGS_TTL_MS,
      build: () => buildWarningsResponse(fy, stateHeadRaw),
      log: req.log,
    });
    res.json(response);
  } catch (err) {
    if (err instanceof SnapshotHttpError) {
      res.status(err.status).json(err.body);
      return;
    }
    if (respondIfQuotaError(err, res)) return;
    req.log?.error({ err }, "warnings: error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Full live build of the warnings payload. Pure of caches/snapshots — errors
// are thrown as SnapshotHttpError so the route (and only the blocking path)
// can map them to HTTP responses; background refreshes just log them.
async function buildWarningsResponse(
  fy: string,
  stateHeadRaw: string,
): Promise<WarningsResponse> {
  {
    // 1. Load the state dashboard to get member list + month data.
    const dashboard = await loadStateDashboard(fy);
    if (!dashboard) {
      throw new SnapshotHttpError(503, { error: "State dashboard not available" });
    }

    // All state heads for the selector.
    const availableStateHeads = [
      ...new Set(dashboard.members.map((m) => m.stateHead).filter(Boolean)),
    ].sort() as string[];

    // Filter members for the requested state head.
    const normalised = stateHeadRaw.toLowerCase();
    const memberRefs = dashboard.members.filter(
      (m) => m.stateHead?.toLowerCase() === normalised,
    );

    if (memberRefs.length === 0) {
      throw new SnapshotHttpError(404, {
        error: `No members found for state head: ${stateHeadRaw}`,
      });
    }

    // Build a month-data lookup by normKey.
    const monthsByKey = new Map<string, SecMember["months"]>();
    for (const m of dashboard.members) {
      if (m.normKey) monthsByKey.set(m.normKey, m.months ?? []);
    }

    const elapsedFraction = fyElapsedFraction(fy);
    const period = `YTD (elapsed ${(elapsedFraction * 100).toFixed(1)}%)`;

    // 2. Load deep dive data for each member in parallel.
    const memberResults = await Promise.allSettled(
      memberRefs.map(async (ref) => {
        const data = await loadDeepDiveData(fy, stateHeadRaw, ref.normKey, { skipExtras: true });
        return { ref, data };
      }),
    );

    // 3. Compute warnings for each member.
    const members: MemberWarnings[] = [];
    let teamTotalRetailers = 0;
    let teamUnassigned = 0;
    let teamVisitsToUnassigned = 0;
    let membersWithSheet = 0;
    let membersWithoutSheet = 0;
    let teamActive = 0;

    for (const result of memberResults) {
      if (result.status === "rejected") continue;
      const { ref, data } = result.value;

      const hasMappedSheet =
        data.retailerDetail?.status === "ok" &&
        (data.retailerDetail.rows?.length ?? 0) > 0;

      const rows =
        data.retailerDetail?.status === "ok" ? (data.retailerDetail.rows ?? []) : [];

      if (hasMappedSheet) {
        membersWithSheet++;
        const stats = computeUnassignedStats(rows);
        teamTotalRetailers += stats.retailersTotal;
        teamUnassigned += stats.unassignedCount;
        teamVisitsToUnassigned += stats.visitsToUnassigned;
      } else {
        membersWithoutSheet++;
      }

      const rawMonths = monthsByKey.get(ref.normKey) ?? null;
      // Map SecMonthData[] → Month[] (engine's internal type).
      // SecMonthData index 0=Apr..11=Mar; synthesise the label from index.
      const MONTH_NAMES: string[] = [
        "Apr", "May", "Jun", "Jul", "Aug", "Sep",
        "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
      ];
      const secMonths: { monthLabel: string; orderedAmount: number; salesAmount: number }[] | null =
        rawMonths
          ? rawMonths.map((m, idx) => ({
              monthLabel: MONTH_NAMES[idx] ?? `M${idx}`,
              orderedAmount: m.orderedAmount ?? 0,
              salesAmount: m.salesAmount ?? 0,
            }))
          : null;

      // Build the payload (same as aiPayload route).
      let payload;
      if (!data.kpis) {
        // No KPIs — synthesise a minimal NOT_AVAILABLE payload.
        const allWarnings = [
          {
            code: "J1",
            family: "J",
            title: "No working sheet mapped",
            severity: "NOT_AVAILABLE" as const,
            baseSeverity: "NOT_AVAILABLE" as const,
            trend: null,
            metric: { value: null, label: "Working sheet", formatted: "ABSENT" },
            threshold: { direction: "above" as const },
            source: "deep-dive configuration",
            suggestedAction: "Map a working sheet to enable analytics for this member",
            notAvailableReason: "Detail is ABSENT, not zero.",
            suppresses: [],
          },
        ];
        const { rootWarnings, suppressedWarnings, jFlags } = splitWarnings(allWarnings);
        members.push({
          memberKey: ref.normKey,
          name: ref.name,
          stateHead: stateHeadRaw,
          hasMappedSheet: false,
          isPartialTenure: false,
          workingDaysActual: null,
          retailersTotal: null,
          unassignedCount: null,
          visitsToUnassigned: null,
          rootWarnings,
          suppressedWarnings,
          jFlags,
          suppressedCount: suppressedWarnings.length,
        });
        continue;
      }

      try {
        payload = buildMemberPayload(
          fy,
          stateHeadRaw,
          period,
          data.kpis,
          data.retailerDetail ?? null,
          data.roiCost ?? null,
          data.skuSpread ?? null,
        );
      } catch {
        continue;
      }

      const kpisWorkingDaysActual = data.kpis.workingDaysActual ?? null;
      const isPartialTenure =
        kpisWorkingDaysActual != null && kpisWorkingDaysActual < 55;

      const allWarnings = computeMemberWarnings({
        payload,
        rows,
        kpisWorkingDaysActual,
        secMemberMonths: secMonths
          ? secMonths.map((m) => ({
              monthLabel: m.monthLabel,
              orderedAmount: m.orderedAmount,
              salesAmount: m.salesAmount,
            }))
          : null,
        elapsedFraction,
        teamNormWorkingDays: TEAM_NORM_WORKING_DAYS,
      });

      const { rootWarnings, suppressedWarnings, jFlags } = splitWarnings(allWarnings);

      const stats = computeUnassignedStats(rows);
      teamActive += payload.coverage.active ?? 0;

      members.push({
        memberKey: ref.normKey,
        name: ref.name,
        stateHead: stateHeadRaw,
        hasMappedSheet,
        isPartialTenure,
        workingDaysActual: kpisWorkingDaysActual,
        retailersTotal: stats.retailersTotal || payload.coverage.retailersTotal,
        unassignedCount: stats.unassignedCount,
        visitsToUnassigned: stats.visitsToUnassigned,
        rootWarnings,
        suppressedWarnings,
        jFlags,
        suppressedCount: suppressedWarnings.length,
      });
    }

    // Sort members: most severe first (reds first, then by total warning count).
    members.sort((a, b) => {
      const aSev = a.rootWarnings.filter((w) => w.severity === "RED").length;
      const bSev = b.rootWarnings.filter((w) => w.severity === "RED").length;
      if (bSev !== aSev) return bSev - aSev;
      return b.rootWarnings.length - a.rootWarnings.length;
    });

    const response: WarningsResponse = {
      fy,
      stateHead: stateHeadRaw,
      availableStateHeads,
      elapsedFraction,
      members,
      teamSummary: {
        totalRetailers: teamTotalRetailers,
        unassignedRetailers: teamUnassigned,
        visitsToUnassigned: teamVisitsToUnassigned,
        membersWithSheet,
        membersWithoutSheet,
        activeRetailers: teamActive,
      },
    };

    return response;
  }
}

// ── Startup pre-warm ─────────────────────────────────────────────────────────
//
// Guarantees every state head in the selector has a persisted warnings
// snapshot shortly after a cold start, so the first-ever request for any
// state head never blocks ~35-55s on Sheets deep-dive loads.
//
// Deliberately low priority: strictly sequential (one state head at a time)
// and skips any key that already has a persisted snapshot, so it never
// competes with user-facing Sheets reads for heads that are already covered.
export async function prewarmWarningsSnapshots(fy: string): Promise<void> {
  const dashboard = await loadStateDashboard(fy);
  if (!dashboard) {
    logger.warn({ fy }, "warnings prewarm: state dashboard not available, skipping");
    return;
  }
  const stateHeads = [
    ...new Set(dashboard.members.map((m) => m.stateHead).filter(Boolean)),
  ].sort() as string[];

  logger.info({ fy, count: stateHeads.length }, "warnings prewarm: starting");
  let built = 0;
  let skipped = 0;
  for (const stateHead of stateHeads) {
    try {
      const result = await prewarmSnapshot({
        key: `warnings|${fy}|${stateHead.toLowerCase()}`,
        ttlMs: WARNINGS_TTL_MS,
        build: () => buildWarningsResponse(fy, stateHead),
      });
      if (result === "built") {
        built++;
        logger.info({ fy, stateHead }, "warnings prewarm: snapshot built");
      } else {
        skipped++;
      }
    } catch (err) {
      logger.warn({ err, fy, stateHead }, "warnings prewarm: build failed");
    }
  }
  logger.info({ fy, built, skipped }, "warnings prewarm: done");
}

export default router;
