// Phase A1 — GET /api/ai/payload
//
// Returns the verified metrics payload: a pre-computed, fully reconciled data
// structure that later AI phases will receive instead of raw sheet data.
//
// THIS ROUTE MAKES NO ANTHROPIC API CALL. Zero. The payload is pure computation
// from already-loaded Deep Dive data. See lib/mgmt/aiPayload.ts for the build
// logic and its architecture note.
//
// Rules:
//   app = numbers. Claude = judgement.
//   Never send raw retailer rows to any AI.
//   Never console.log — use req.log / logger.

import { Router, type IRouter, type Request, type Response } from "express";
import { loadDeepDiveData, normSecKey } from "../lib/mgmt/deepDiveData.js";
import {
  buildMemberPayload,
  buildStateHeadPayload,
} from "../lib/mgmt/aiPayload.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2026-27";

// Normalise the 'period' query param to a canonical string.
function normalisePeriod(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "ytd";
  const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (s === "yeartodate" || s === "ytd") return "ytd";
  if (s === "year" || s === "fullyear") return "year";
  if (s === "quarter" || s === "q") return "quarter";
  if (s === "q1") return "q1";
  if (s === "q2") return "q2";
  if (s === "q3") return "q3";
  if (s === "q4") return "q4";
  if (s === "month" || s === "currentmonth") return "month";
  return "ytd";
}

router.get("/ai/payload", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim()
      ? req.query.fy.trim()
      : DEFAULT_FY;

  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }

  const stateHead =
    typeof req.query.stateHead === "string" && req.query.stateHead.trim()
      ? req.query.stateHead.trim()
      : undefined;

  const memberRaw =
    typeof req.query.member === "string" && req.query.member.trim()
      ? req.query.member.trim()
      : undefined;
  const memberKey = memberRaw ? normSecKey(memberRaw) : undefined;

  const period = normalisePeriod(req.query.period);

  req.log.info({ fy, stateHead, member: memberRaw, period }, "ai/payload: request");

  try {
    const data = await loadDeepDiveData(fy, stateHead, memberKey);

    if (data.error && !data.kpis) {
      res.status(502).json({ error: data.error });
      return;
    }

    // ── State Head aggregate (no member selected) ────────────────────────────
    if (!memberKey) {
      const head = stateHead ?? null;
      const teamMembers = head
        ? data.members
            .map((ref) =>
              data.kpis?.normKey === ref.normKey ? data.kpis : null,
            )
            .filter(Boolean)
        : [];

      // When kpis is available it's for ONE member — we need all members under
      // the head. Re-issue loadDeepDiveData without a memberKey just gets refs.
      // The Data tab entry for each member IS in the cache but we need to walk
      // all of them. The team summary approach: accumulate from the member refs
      // that the Data-tab parse already produced via the DeepDiveDataResult.
      //
      // loadDeepDiveData returns members: MemberRef[] (no KPIs per member) when
      // no memberKey is specified. To get KPIs per member we must resolve each.
      // Phase A1: resolve each member synchronously from the SAME cache entry
      // by calling loadDeepDiveData per member (all will be cache hits).

      const memberRefs = data.members; // already filtered by stateHead if given

      if (memberRefs.length === 0 && head) {
        res.status(404).json({ error: `State head '${head}' not found or has no members.` });
        return;
      }

      const memberKpisList = await Promise.all(
        memberRefs.map((ref) =>
          loadDeepDiveData(fy, ref.stateHead, ref.normKey).then((d) => d.kpis),
        ),
      );
      const validKpis = memberKpisList.filter(
        (k): k is NonNullable<typeof k> => k !== null,
      );

      const payload = buildStateHeadPayload(
        fy,
        head ?? (validKpis[0]?.stateHead ?? "Unknown"),
        period,
        validKpis,
      );

      req.log.info(
        {
          fy,
          stateHead: head,
          memberCount: validKpis.length,
          secondaryOB: payload.performance.secondaryOB,
          directDealerOB: payload.performance.directDealerOB,
          salesReceived: payload.performance.salesReceived,
          visits: payload.visits?.done,
          retailers: payload.coverage.retailersTotal,
        },
        "ai/payload: state-head aggregate — verify against acceptance criteria",
      );

      res.json(payload);
      return;
    }

    // ── Single member ────────────────────────────────────────────────────────
    if (!data.kpis) {
      res.status(404).json({
        error: memberRaw
          ? `Member '${memberRaw}' not found in the FY${fy} Data tab.`
          : "No kpis available. Specify a member key.",
      });
      return;
    }

    const payload = buildMemberPayload(
      fy,
      stateHead ?? data.kpis.stateHead ?? null,
      period,
      data.kpis,
      data.retailerDetail,
      data.roiCost,
      data.skuSpread,
    );

    req.log.info(
      {
        fy,
        member: data.kpis.name,
        stateHead: data.kpis.stateHead,
        dataCutoff:     payload.identity.dataCutoff,
        elapsedMonths:  payload.identity.elapsedMonths,
        workingDays:    payload.identity.workingDays,
        secondaryOB:    payload.performance.secondaryOB,
        directDealerOB: payload.performance.directDealerOB,
        totalOB:        payload.performance.totalOB,
        salesReceived:  payload.performance.salesReceived,
        totalOBPct:     payload.achievement.totalOBPct?.toFixed(1),
        secondaryOBPct: payload.achievement.secondaryOBPct?.toFixed(1),
        directDealerPct: payload.achievement.directDealerPct?.toFixed(1),
        salePct:        payload.achievement.salePct?.toFixed(1),
        annualProgress: payload.achievement.annualProgressPct?.toFixed(1),
        retailersTotal: payload.coverage.retailersTotal,
        active:         payload.coverage.active,
        dormant:        payload.coverage.dormant,
        customerStates: payload.customerStates
          ? {
              retained:    payload.customerStates.retained.count,
              reactivated: payload.customerStates.reactivated.count,
              atRisk:      payload.customerStates.atRisk.count,
              never:       payload.customerStates.never.count,
            }
          : null,
        top5Share:      payload.concentration?.top5SharePct?.toFixed(1),
        top10Share:     payload.concentration?.top10SharePct?.toFixed(1),
        hhi:            payload.concentration?.hhi?.toFixed(0),
        effectiveRetailers: payload.concentration?.effectiveRetailers?.toFixed(1),
        visitsDone:     payload.visits?.done,
        visitsRequired: payload.visits?.required,
        visitedNoOrder: payload.visits?.visitedNoOrder,
        ctcToDate:      payload.cost?.ctcToDate,
        taBill:         payload.cost?.taBill,
        totalCost:      payload.cost?.totalCost,
        costRatioOB:    payload.cost?.costRatioOB?.toFixed(2),
        costPerVisit:   payload.cost?.costPerVisit?.toFixed(0),
        dataQualityCodes: payload.dataQuality.map((f) => f.code),
      },
      "ai/payload: member payload built — verify against acceptance criteria",
    );

    res.json(payload);
  } catch (err) {
    req.log.error({ err, fy, stateHead, member: memberRaw }, "ai/payload: unexpected error");
    res.status(500).json({ error: "Failed to build the AI payload." });
  }
});

export default router;
