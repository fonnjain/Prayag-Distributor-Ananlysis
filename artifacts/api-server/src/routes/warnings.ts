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
import { isFrozen } from "../lib/customers/registerSync.js";

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

// Fallback working-day norm, used only when a team has no usable working-day
// data at all. The real norm is derived per team as the median of the members'
// actual working days (AG column) — teams range widely (11–79 days), so one
// hardcoded norm does not fit all.
const FALLBACK_NORM_WORKING_DAYS = 65;

// Partial tenure = working days below 85% of the team median (was a hardcoded
// 55-day cutoff against a hardcoded 65-day norm — same ratio, now team-derived).
const PARTIAL_TENURE_RATIO = 0.85;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

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
      key: `warnings|v3|${fy}|${stateHeadRaw.toLowerCase()}`,
      ttlMs: WARNINGS_TTL_MS,
      build: () => buildWarningsResponse(fy, stateHeadRaw),
      log: req.log,
      frozen: isFrozen(fy),
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
    // LEFT members are excluded from current-period warnings everywhere else
    // (low-perf counts, rankings) — exclude them here too. Their history stays
    // in the register untouched; they simply raise no current warnings.
    const memberRefs = dashboard.members.filter(
      (m) => m.stateHead?.toLowerCase() === normalised && !m.isLeft,
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

    // Resolve the register's head spelling to the Data tab's spelling.
    // The secondary register writes e.g. "AQIL RIZVI" where the Data tab has
    // "Syed Aqil Rizvi" — the deep-dive loader matches exactly, so without
    // this mapping an entire team reads as "no working sheet" (all J1).
    const normHead = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
    const headTokens = (s: string) => new Set(normHead(s).split(" ").filter(Boolean));
    let deepDiveHead = stateHeadRaw;
    try {
      const headIndex = await loadDeepDiveData(fy, undefined, undefined, { skipExtras: true });
      const candidates = headIndex.stateHeads ?? [];
      const exact = candidates.find((h) => normHead(h) === normHead(stateHeadRaw));
      if (exact) {
        deepDiveHead = exact;
      } else {
        // One-directional and ≥2 tokens only: every register token must appear
        // in the candidate (e.g. "AQIL RIZVI" ⊂ "Syed Aqil Rizvi"). Single-token
        // names are too ambiguous to auto-resolve.
        const want = headTokens(stateHeadRaw);
        if (want.size >= 2) {
          const subset = candidates.filter((h) => {
            const have = headTokens(h);
            return [...want].every((t) => have.has(t));
          });
          if (subset.length === 1) {
            deepDiveHead = subset[0];
          } else if (subset.length > 1) {
            logger.warn(
              { stateHeadRaw, candidates: subset },
              "warnings: ambiguous state-head resolution — using raw spelling",
            );
          }
        }
      }
    } catch {
      // fall through with the raw name
    }

    // 2. Load deep dive data for each member in parallel.
    const memberResults = await Promise.allSettled(
      memberRefs.map(async (ref) => {
        const data = await loadDeepDiveData(fy, deepDiveHead, ref.normKey, { skipExtras: true });
        return { ref, data };
      }),
    );

    // Team working-day median → partial-tenure norm + cutoff (never hardcoded).
    const teamWorkingDays: number[] = [];
    for (const result of memberResults) {
      if (result.status !== "fulfilled") continue;
      const wd = result.value.data.kpis?.workingDaysActual;
      if (wd != null && wd > 0) teamWorkingDays.push(wd);
    }
    const teamMedianWd = median(teamWorkingDays);
    // Tiny teams (<5 usable samples) get a meaningless "median" — e.g. a
    // two-person team of new joiners with 8 and 27 working days would set the
    // norm to ~17 days and never flag anyone. Use the company-wide fallback
    // norm instead, and expose which basis was used.
    // Basis depends on team SIZE (memberRefs), not on how many sheets loaded
    // this pass — otherwise a transient cold-load miss flips a 5-person team
    // to the company norm and the snapshot freezes that misclassification.
    const normBasis: "team-median" | "company-fallback" =
      teamMedianWd != null && memberRefs.length >= 5
        ? "team-median"
        : "company-fallback";
    const teamNormWorkingDays =
      normBasis === "team-median" ? teamMedianWd! : FALLBACK_NORM_WORKING_DAYS;
    const partialTenureCutoffDays = Math.round(teamNormWorkingDays * PARTIAL_TENURE_RATIO);

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
      const secMonths:
        | { monthLabel: string; orderedAmount: number; salesAmount: number; notYetRecorded: boolean }[]
        | null = rawMonths
        ? rawMonths.map((m, idx) => ({
            monthLabel: MONTH_NAMES[idx] ?? `M${idx}`,
            orderedAmount: m.orderedAmount ?? 0,
            salesAmount: m.salesAmount ?? 0,
            notYetRecorded: m.notYetRecorded,
          }))
        : null;
      // Lag months: closed with booking present but sales not yet entered —
      // data-entry delay, never a performance signal.
      const lagMonths =
        secMonths?.filter((m) => m.notYetRecorded && m.orderedAmount > 0).length ?? 0;

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
        kpisWorkingDaysActual != null &&
        kpisWorkingDaysActual < partialTenureCutoffDays;

      // Per-member elapsed months from the sheet's BD column — pace pro-rating
      // uses each member's own tenure, not the global FY fraction.
      const memberElapsedFraction =
        data.kpis.elapsedMonths != null && data.kpis.elapsedMonths > 0
          ? data.kpis.elapsedMonths / 12
          : null;

      const allWarnings = computeMemberWarnings({
        payload,
        rows,
        kpisWorkingDaysActual,
        secMemberMonths: secMonths,
        elapsedFraction,
        memberElapsedFraction,
        teamNormWorkingDays,
        partialTenureCutoffDays,
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
        lagMonths,
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
        normWorkingDays: teamNormWorkingDays,
        normBasis,
        partialTenureCutoffDays,
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
        key: `warnings|v3|${fy}|${stateHead.toLowerCase()}`,
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
