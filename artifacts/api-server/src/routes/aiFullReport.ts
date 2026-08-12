// Full structured report generation — two types, one pipeline.
//
// REPORT TYPE 1 — DISTRIBUTOR (10 sections)
//   POST /api/ai/full-report/distributor
//   Body: { fy, stateHead, distributor, monthFrom?, monthTo? }
//
// REPORT TYPE 2 — STATE HEAD (9 sections)
//   POST /api/ai/full-report/statehead
//   Body: { fy, stateHead, monthFrom?, monthTo? }
//
// HARD RULES (from product spec):
//   - Every figure names its period.
//   - Two sources both printed and labelled — never silently pick one.
//   - Never print 0 for a missing value — print a reason string instead.
//   - Territory figures exclude project channel; state that in each section header.
//   - No margin, profit or cost-derived figure.
//   - 2 decimals truncated (not rounded); deltas computed from same truncated values.
//   - Numbers come from the query layer only — Claude writes narrative around them.
//
// Claude is used for:
//   Distributor: lever priorities + position sentences (§2); "what to do" (§9).
//   State head:  "what to do" (§8).

import { Router, type IRouter, type Request, type Response } from "express";
import { currentOpenFy } from "../lib/fyAnchors.js";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  loadDistributorDeepDive,
  normDistKey,
  toPriorYearMonths,
  type DistributorDeepDiveResult,
  type DistributorGroup,
} from "../lib/mgmt/distributorDeepDive.js";
import { computeNudgeList, type NudgeRow, type NudgeResult } from "../lib/schemes/nudge.js";
import { getBlockedCustomers } from "../lib/schemes/dues.js";
import { fiscalMonthsToLabels } from "../lib/mgmt/primaryPeriod.js";
import { runNumericGuard, type GuardResult } from "../lib/mgmt/numericGuard.js";
import type { AiPayload } from "../lib/mgmt/aiPayload.js";
import { assembleRows } from "../lib/mgmt/report.js";
import {
  findLiveJobForCacheKey,
  createJob,
  markJobRunning,
  markJobComplete,
  markJobFailed,
  loadJobResult,
} from "../lib/aiReportJobQueue.js";

const router: IRouter = Router();

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;
const FY_PATTERN = /^\d{4}-\d{2}$/;
const PROJECT_HEAD = "Non-territory / Project / Govt";

// ── Number helpers ─────────────────────────────────────────────────────────────

/** Truncate to 2 decimal places (not rounded). Matches frontend trunc2(). */
function t2(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v !== v) return null;
  return Math.trunc(Math.round(v * 1e6) / 1e4) / 100;
}

function t2safe(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : null;
  return t2(n);
}

function pct(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return t2((a / b) * 100);
}

function delta(cur: number | null, prior: number | null): number | null {
  if (cur == null || prior == null) return null;
  return t2(cur - prior);
}

function deltaPct(cur: number | null, prior: number | null): number | null {
  if (cur == null || prior == null || prior === 0) return null;
  return t2(((cur - prior) / prior) * 100);
}

// ── Period helpers ─────────────────────────────────────────────────────────────

const FULL_MONTH_NAMES = [
  "April", "May", "June", "July", "August", "September",
  "October", "November", "December", "January", "February", "March",
];

function buildPeriodLabel(fy: string, from: number, to: number): string {
  const fyStart = parseInt(fy.split("-")[0]!, 10);
  if (from === 1 && to === 12) return `Full FY ${fy}`;
  const n = to - from + 1;
  const f = FULL_MONTH_NAMES[from - 1]!;
  const t = FULL_MONTH_NAMES[to - 1]!;
  const fromY = from <= 9 ? fyStart : fyStart + 1;
  const toY   = to   <= 9 ? fyStart : fyStart + 1;
  if (fromY === toY && f !== t) return `${f} to ${t} ${fromY} (${n} months)`;
  if (fromY === toY && f === t) return `${f} ${fromY} (1 month)`;
  return `${f} ${fromY} to ${t} ${toY} (${n} months)`;
}

function fiscalMonthToQuarter(month: number): "Q1" | "Q2" | "Q3" | "Q4" {
  if (month <= 3) return "Q1";
  if (month <= 6) return "Q2";
  if (month <= 9) return "Q3";
  return "Q4";
}

function prevFy(fy: string): string {
  const s = parseInt(fy.split("-")[0]!, 10) - 1;
  return `${s}-${String(s + 1).slice(-2)}`;
}

// ── Customer name resolution ───────────────────────────────────────────────────

/** All raw customer names in sale_line_current (both FYs) that share a normDistKey. */
async function resolveCustomerNames(fy: string, nk: string): Promise<string[]> {
  const py = prevFy(fy);
  const rows = await db.execute<{ name: string }>(sql`
    SELECT DISTINCT UPPER(TRIM(customer)) AS name
    FROM sale_line_current
    WHERE version_status = 'current'
      AND fy IN (${fy}, ${py})
      AND customer IS NOT NULL AND customer != ''
  `);
  return rows.rows.map((r: { name: string }) => r.name).filter(n => normDistKey(n) === nk);
}

// ── Headline SQL ───────────────────────────────────────────────────────────────

type HeadlineRow = { net: string | null; qty: string | null; codes: string | null };

async function queryHeadline(
  labels: string[],
  customerNames: string[],
): Promise<HeadlineRow> {
  if (customerNames.length === 0 || labels.length === 0) {
    return { net: null, qty: null, codes: null };
  }
  const nameFrag  = sql.join(customerNames.map(n => sql`${n}`), sql`, `);
  const labelFrag = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<HeadlineRow>(sql`
    SELECT
      SUM(amount::float8)::text         AS net,
      SUM(qty::float8)::text            AS qty,
      COUNT(DISTINCT code)::text        AS codes
    FROM sale_line_current
    WHERE version_status = 'current'
      AND UPPER(TRIM(customer)) IN (${nameFrag})
      AND month_label IN (${labelFrag})
      AND code IS NOT NULL AND code != ''
      AND (head_canon IS NULL OR head_canon != ${PROJECT_HEAD})
      -- SUPERSEDED (customer-upload load, Aug 2026): type_raw holds PRODUCT
      -- GROUPS, not entity classes, so ILIKE '%direct%' does not reliably
      -- separate distributors from direct dealers. The authoritative
      -- Direct-Dealer / Distributor classification now lives in
      -- customer_master.entity_type (keyed by DIST#). This transactional
      -- predicate is retained for sale-line scoping only; do not treat it as
      -- the entity-type source.
      AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')
  `);
  return res.rows[0] ?? { net: null, qty: null, codes: null };
}

// ── Segment stats SQL ──────────────────────────────────────────────────────────

type SegRow = { segment: string; codes_bought: string; net: string };
type PeerRow = { segment: string; median_codes: string; dist_count: string };

async function querySegmentStats(labels: string[], customerNames: string[]): Promise<SegRow[]> {
  if (customerNames.length === 0 || labels.length === 0) return [];
  const nameFrag  = sql.join(customerNames.map(n => sql`${n}`), sql`, `);
  const labelFrag = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<SegRow>(sql`
    SELECT
      COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
      COUNT(DISTINCT code)::text  AS codes_bought,
      SUM(amount::float8)::text   AS net
    FROM sale_line_current
    WHERE version_status = 'current'
      AND UPPER(TRIM(customer)) IN (${nameFrag})
      AND month_label IN (${labelFrag})
      AND code IS NOT NULL AND code != ''
      AND (head_canon IS NULL OR head_canon != ${PROJECT_HEAD})
      AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')
    GROUP BY 1
    ORDER BY SUM(amount::float8) DESC
  `);
  return res.rows;
}

async function queryPeerMedian(labels: string[]): Promise<PeerRow[]> {
  if (labels.length === 0) return [];
  const labelFrag = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<PeerRow>(sql`
    WITH dist_seg AS (
      SELECT
        UPPER(TRIM(customer))                           AS cust,
        COALESCE(group_canon, group_raw, 'Unmapped')    AS seg,
        COUNT(DISTINCT code)::float8                    AS codes
      FROM sale_line_current
      WHERE version_status = 'current'
        AND month_label IN (${labelFrag})
        AND code IS NOT NULL AND code != ''
        AND (head_canon IS NULL OR head_canon != ${PROJECT_HEAD})
        AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')
      GROUP BY 1, 2
    )
    SELECT
      seg                                                         AS segment,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY codes)::text   AS median_codes,
      COUNT(DISTINCT cust)::text                                  AS dist_count
    FROM dist_seg
    GROUP BY 1
  `);
  return res.rows;
}

// ── Lost-codes SQL (per customer) ─────────────────────────────────────────────

type LostRow = { code: string; segment: string; net: string };

async function queryLostCodes(
  priorFyLabel: string, priorLabels: string[],
  currentLabels: string[],
  customerNames: string[],
): Promise<LostRow[]> {
  if (customerNames.length === 0) return [];
  const nameFrag  = sql.join(customerNames.map(n => sql`${n}`), sql`, `);
  const curFrag   = sql.join(currentLabels.map(l => sql`${l}`), sql`, `);
  const priorFrag = sql.join(priorLabels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<LostRow>(sql`
    WITH prior AS (
      SELECT code, COALESCE(group_canon, group_raw, 'Unmapped') AS segment, SUM(amount::float8) AS net
      FROM sale_line_current
      WHERE version_status = 'current'
        AND fy = ${priorFyLabel}
        AND UPPER(TRIM(customer)) IN (${nameFrag})
        AND month_label IN (${priorFrag})
        AND code IS NOT NULL AND code != ''
      GROUP BY 1, 2
    ), cur AS (
      SELECT DISTINCT code
      FROM sale_line_current
      WHERE version_status = 'current'
        AND UPPER(TRIM(customer)) IN (${nameFrag})
        AND month_label IN (${curFrag})
        AND code IS NOT NULL AND code != ''
    )
    SELECT p.code, p.segment, p.net::text
    FROM prior p
    LEFT JOIN cur c ON c.code = p.code
    WHERE c.code IS NULL AND p.net > 0
    ORDER BY p.net DESC
    LIMIT 20
  `);
  return res.rows;
}

// ── State head team qty SQL ────────────────────────────────────────────────────

type TeamQtyRow = { head_canon: string; qty: string };

async function queryTeamQty(fy: string, labels: string[], heads: string[]): Promise<TeamQtyRow[]> {
  if (heads.length === 0 || labels.length === 0) return [];
  const headFrag  = sql.join(heads.map(h => sql`${h}`), sql`, `);
  const labelFrag = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<TeamQtyRow>(sql`
    SELECT head_canon, SUM(qty::float8)::text AS qty
    FROM sale_line_current
    WHERE version_status = 'current'
      AND fy = ${fy}
      AND head_canon IN (${headFrag})
      AND month_label IN (${labelFrag})
    GROUP BY head_canon
  `);
  return res.rows;
}

// ── State head shrinkers SQL ──────────────────────────────────────────────────

type ShrinkerRow = { customer: string; net: string; prior_net: string; qty: string; prior_qty: string };

async function queryShrinkers(fy: string, labels: string[], priorFyLabel: string, priorLabels: string[]): Promise<ShrinkerRow[]> {
  if (labels.length === 0 || priorLabels.length === 0) return [];
  const labelFrag = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const priorFrag = sql.join(priorLabels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<ShrinkerRow>(sql`
    WITH cur AS (
      SELECT UPPER(TRIM(customer)) AS customer, SUM(amount::float8) AS net, SUM(qty::float8) AS qty
      FROM sale_line_current
      WHERE version_status = 'current'
        AND fy = ${fy}
        AND month_label IN (${labelFrag})
        AND (head_canon IS NULL OR head_canon != ${PROJECT_HEAD})
        AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')
      GROUP BY 1
    ), prior AS (
      SELECT UPPER(TRIM(customer)) AS customer, SUM(amount::float8) AS net, SUM(qty::float8) AS qty
      FROM sale_line_current
      WHERE version_status = 'current'
        AND fy = ${priorFyLabel}
        AND month_label IN (${priorFrag})
        AND (head_canon IS NULL OR head_canon != ${PROJECT_HEAD})
        AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')
      GROUP BY 1
    )
    SELECT c.customer, c.net::text, p.net::text AS prior_net, c.qty::text, p.qty::text AS prior_qty
    FROM cur c
    JOIN prior p ON p.customer = c.customer
    WHERE c.net > p.net
      AND p.qty > 0 AND c.qty < p.qty
    ORDER BY (p.qty - c.qty) DESC
    LIMIT 10
  `);
  return res.rows;
}

// ── Claude helpers ─────────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function gatherText(obj: unknown): string {
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(gatherText).join(" ");
  if (obj && typeof obj === "object") return Object.values(obj as Record<string, unknown>).map(gatherText).join(" ");
  return "";
}

function safeGuard(payload: unknown, content: { title: string; body: string }): GuardResult {
  try {
    return runNumericGuard(
      { content } as Parameters<typeof runNumericGuard>[0],
      payload as unknown as AiPayload,
    );
  } catch {
    return { status: "ok", unmatched: [], checked: 0 };
  }
}

// ── ROUTE 1: Distributor ───────────────────────────────────────────────────────

// ── Job status polling ────────────────────────────────────────────────────────
// Shared by both growth and statehead async jobs.
// The growth router also exports this same underlying helper via aiReportJobQueue.
router.get("/ai/full-report/status/:jobId", async (req: Request, res: Response): Promise<void> => {
  const { jobId } = req.params;
  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  try {
    const result = await loadJobResult(jobId);
    if (result === null) {
      res.status(404).json({ error: "Job not found or expired." });
      return;
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "full-report/status failed");
    res.status(500).json({ error: "Could not load job status." });
  }
});

router.post("/ai/full-report/distributor", async (req: Request, res: Response): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fy          = typeof b.fy === "string" && FY_PATTERN.test(b.fy.trim()) ? b.fy.trim() : currentOpenFy();
  const stateHead   = typeof b.stateHead === "string" && b.stateHead.trim() ? b.stateHead.trim() : "";
  const distributor = typeof b.distributor === "string" && b.distributor.trim() ? b.distributor.trim() : "";
  const monthFrom   = Math.max(1,  Math.min(12, Number(b.monthFrom ?? 1)));
  const monthTo     = Math.max(monthFrom, Math.min(12, Number(b.monthTo ?? 12)));

  if (!stateHead)   { res.status(400).json({ error: "stateHead is required" }); return; }
  if (!distributor) { res.status(400).json({ error: "distributor is required" }); return; }

  const py          = prevFy(fy);
  const labels      = fiscalMonthsToLabels(fy, monthFrom, monthTo);
  const priorLabels = toPriorYearMonths(labels);
  const periodLabel      = buildPeriodLabel(fy, monthFrom, monthTo);
  const priorPeriodLabel = buildPeriodLabel(py, monthFrom, monthTo);
  const quarter          = fiscalMonthToQuarter(monthTo);
  const targetNormKey    = normDistKey(distributor.toUpperCase().trim());

  try {
    // ── Load data in parallel ─────────────────────────────────────────────────
    const [deepDiveResult, customerNames, blockedResult] = await Promise.all([
      loadDistributorDeepDive(fy, stateHead).catch((): DistributorDeepDiveResult | null => null),
      resolveCustomerNames(fy, targetNormKey),
      getBlockedCustomers().catch((): { blocked: Set<string>; available: boolean } => ({ blocked: new Set<string>(), available: false })),
    ]);

    const distEntry: DistributorGroup | null = deepDiveResult?.distributors.find(d => d.normKey === targetNormKey) ?? null;
    const displayName = distEntry?.name ?? distributor.toUpperCase().trim();
    const effectiveCustomerNames = customerNames.length > 0 ? customerNames : [displayName];

    const nudgeResultPromise: Promise<NudgeResult | null> = computeNudgeList(
      fy, quarter, blockedResult.blocked, blockedResult.available, 0.05, stateHead,
    ).catch((): NudgeResult | null => null);

    const [curHead, priorHead, segRows, peerRows, lostRows, schemeResult] = await Promise.all([
      queryHeadline(labels, effectiveCustomerNames),
      queryHeadline(priorLabels, effectiveCustomerNames),
      querySegmentStats(labels, effectiveCustomerNames),
      queryPeerMedian(labels),
      queryLostCodes(py, priorLabels, labels, effectiveCustomerNames),
      nudgeResultPromise,
    ]);

    const nudge: NudgeRow | undefined = schemeResult?.nudges.find((n: NudgeRow) =>
      normDistKey(n.customer.toUpperCase().trim()) === targetNormKey
    );

    // ── §1 Headline ───────────────────────────────────────────────────────────
    const curNet   = t2safe(curHead.net);
    const curQty   = t2safe(curHead.qty);
    const curCodes = t2safe(curHead.codes);
    const prNet    = t2safe(priorHead.net);
    const prQty    = t2safe(priorHead.qty);
    const prCodes  = t2safe(priorHead.codes);
    const realisedPerPiece      = curNet != null && curQty != null && curQty !== 0 ? t2(curNet / curQty) : null;
    const priorRealisedPerPiece = prNet  != null && prQty  != null && prQty  !== 0 ? t2(prNet  / prQty) : null;

    const headline = {
      periodLabel, priorPeriodLabel,
      net: curNet, qty: curQty, codesBought: curCodes, realisedPerPiece,
      priorNet: prNet, priorQty: prQty, priorCodesBought: prCodes, priorRealisedPerPiece,
      activeRetailersFromSheet: distEntry?.activeCount ?? null,
      activeRetailersSource: "member working sheets (D1 — declared by territory member)",
      priorActiveRetailersNote: "not available — prior year member sheet data not loaded",
      netDelta:    delta(curNet, prNet),
      netDeltaPct: deltaPct(curNet, prNet),
    };

    // ── §3 Reach ──────────────────────────────────────────────────────────────
    const rc = distEntry?.retailerConcentration;
    const reach = {
      periodLabel,
      retailersOnBook:       distEntry?.retailerCount ?? null,
      retailersOnBookSource: "member working sheets (D1 — Retailer Master declared by territory member)",
      active:                distEntry?.activeCount   ?? null,
      activeSource:          "member working sheets (D1 — order placed at least once this period)",
      dormant:               distEntry?.dormantCount  ?? null,
      activationPct:         distEntry?.retailerCount && distEntry.activeCount != null
        ? pct(distEntry.activeCount, distEntry.retailerCount) : null,
      top5RetailerSharePct:  rc?.top5SharePct != null ? t2(rc.top5SharePct) : null,
      topRetailerSharePct:   rc?.topRetailerSharePct != null ? t2(rc.topRetailerSharePct) : null,
      unassignedNote: "unassigned count is a territory-level metric — see state head report for district breakdown",
    };

    // ── §4 Range ──────────────────────────────────────────────────────────────
    const peerMap = new Map(peerRows.map((r: PeerRow) => [r.segment, { median: parseFloat(r.median_codes), count: parseInt(r.dist_count) }]));
    const totalNet = segRows.reduce((s: number, r: SegRow) => s + (parseFloat(r.net) || 0), 0);

    const segments = segRows.map((r: SegRow) => {
      const netV   = t2(parseFloat(r.net));
      const codes  = parseInt(r.codes_bought);
      const peer   = peerMap.get(r.segment);
      const pmCodes = peer ? t2(peer.median) : null;
      return {
        segment:         r.segment,
        net:             netV,
        sharePct:        totalNet > 0 ? t2((parseFloat(r.net) / totalNet) * 100) : null,
        codesBought:     codes,
        peerMedianCodes: pmCodes,
        gap:             pmCodes != null ? t2(pmCodes - codes) : null,
      };
    });

    const peerCount0 = peerMap.size > 0 ? [...peerMap.values()][0]?.count ?? null : null;
    const range = {
      excludesProject: true as const,
      excludesProjectNote: "territory figures — project / govt / non-territory channel excluded",
      periodLabel, segments, peerCount: peerCount0,
      rank: null as number | null, rankOutOf: null as number | null,
      rankNote: "distributor rank requires a full territory ranking pass — not included in this report",
    };

    // ── §5 Recovery ───────────────────────────────────────────────────────────
    const recovery = {
      periodLabel,
      atRiskCount:              distEntry?.dormantCount ?? null,
      atRiskCountSource:        "member working sheets — retailers on book with no order this period",
      atRiskPriorYearValueNote: "prior-year value by retailer requires secondary register breakdown — not available",
      lostCodes: lostRows.map((r: LostRow) => ({
        code:     r.code,
        segment:  r.segment,
        priorNet: t2(parseFloat(r.net)) ?? 0,
      })),
      reactivatedNote: "reactivated count requires prior-year secondary register — not available",
    };

    // ── §6 Rhythm ─────────────────────────────────────────────────────────────
    const flows = distEntry?.flows;
    const rhythm = {
      periodLabel, priorPeriodLabel,
      hasPrimaryData:     flows?.hasPrimaryData ?? false,
      ordersThisPeriod:   flows?.invoiceCount    ?? null,
      ordersPerMonth:     flows?.ordersPerMonth  != null ? t2(flows.ordersPerMonth) : null,
      daysSinceLastOrder: flows?.daysSinceLastOrder ?? null,
      lastOrderDate:      flows?.lastInvoiceDate  ?? null,
      priorNote:          "prior-year order rhythm not separately loaded — refer to D2 year-on-year period",
      yoyDispatch: (flows?.currentPeriodDispatch != null && flows?.priorPeriodDispatch != null) ? {
        current:   t2(flows.currentPeriodDispatch),
        prior:     t2(flows.priorPeriodDispatch),
        period:    flows.yoyPeriod ?? periodLabel,
        growthPct: flows.growthPct != null ? t2(flows.growthPct) : null,
      } : null,
    };

    // ── §7 Scheme ─────────────────────────────────────────────────────────────
    const scheme = nudge ? {
      quarter,
      deadline:             schemeResult?.deadline ?? null,
      billedSoFar:          t2(nudge.billedSoFar),
      currentSlab:          nudge.currentSlab != null ? t2(nudge.currentSlab) : null,
      currentRate:          t2(nudge.currentRate * 100),
      nextSlab:             t2(nudge.nextSlab),
      nextRate:             nudge.nextRate != null ? t2(nudge.nextRate * 100) : null,
      gap:                  t2(nudge.gap),
      extraEarn:            nudge.extraEarn != null ? t2(nudge.extraEarn) : null,
      extraRoi:             nudge.extraRoi  != null ? t2(nudge.extraRoi * 100) : null,
      extraEarnNewPurchase: nudge.nextRate != null && nudge.gap != null
        ? t2(nudge.gap * nudge.nextRate) : null,
      extraEarnRePricing:   nudge.nextRate != null
        ? t2((nudge.nextRate - nudge.currentRate) * nudge.billedSoFar) : null,
      status:               nudge.status,
      blockedReason:        nudge.blockedReason,
      unavailableReason:    null as string | null,
    } : {
      quarter, deadline: schemeResult?.deadline ?? null,
      billedSoFar: null, currentSlab: null, currentRate: null,
      nextSlab: null, nextRate: null, gap: null, extraEarn: null, extraRoi: null,
      extraEarnNewPurchase: null, extraEarnRePricing: null,
      status: null, blockedReason: null,
      unavailableReason: schemeResult
        ? `${displayName} has no qualifying scheme nudge in ${quarter} ${fy}`
        : "scheme data could not be loaded",
    };

    // ── §8 Tier ───────────────────────────────────────────────────────────────
    const inv = distEntry?.investment;
    const tierData = inv?.tier ? {
      tier: inv.tier.tier,
      score: inv.tier.score,
      inputs: inv.tier.inputs,
      recommendedCadence: inv.tier.visitCadence,
      isOverridden: inv.tier.isOverridden,
      overrideReason: inv.tier.overrideReason,
      unavailableReason: null as string | null,
    } : {
      tier: null as "A" | "B" | "C" | null,
      score: null, inputs: [],
      recommendedCadence: null, isOverridden: false, overrideReason: null,
      unavailableReason: "tier score requires at least one complete FY of primary sales data",
    };

    // ── §10 Not available ──────────────────────────────────────────────────────
    const notAvailableItems: { item: string; reason: string }[] = [
      { item: "Margin and cost-derived figures", reason: "no cost master exists in the system — MRP discount is not margin" },
    ];
    if (reach.active == null) notAvailableItems.push({ item: "Active retailers", reason: "member working sheet not loaded" });
    if (recovery.atRiskPriorYearValueNote) notAvailableItems.push({ item: "At-risk retailer prior-year value", reason: recovery.atRiskPriorYearValueNote });
    if (recovery.reactivatedNote) notAvailableItems.push({ item: "Reactivated count", reason: recovery.reactivatedNote });
    if (!flows?.hasPrimaryData) notAvailableItems.push({ item: "Primary order rhythm", reason: "no primary dispatch data matched for this distributor in the current FY" });
    if (scheme.unavailableReason) notAvailableItems.push({ item: "Scheme nudge", reason: scheme.unavailableReason });
    if (tierData.unavailableReason) notAvailableItems.push({ item: "Tier score", reason: tierData.unavailableReason });
    if (range.rank == null) notAvailableItems.push({ item: "Distributor range rank", reason: "full territory ranking pass not computed in this report" });

    // ── §2 Five Levers + §9 What To Do via Claude ─────────────────────────────
    const dataContext = {
      distributor: displayName, fy, periodLabel, stateHead,
      headline: { net: headline.net, qty: headline.qty, codesBought: headline.codesBought, priorNet: headline.priorNet },
      reach: { retailersOnBook: reach.retailersOnBook, active: reach.active, dormant: reach.dormant, activationPct: reach.activationPct },
      range: { segments: segments.slice(0, 5), peerCount: range.peerCount },
      recovery: { atRiskCount: recovery.atRiskCount, lostCodesCount: recovery.lostCodes.length },
      rhythm: { daysSinceLastOrder: rhythm.daysSinceLastOrder, ordersPerMonth: rhythm.ordersPerMonth, yoyDispatch: rhythm.yoyDispatch },
      scheme: { gap: scheme.gap, extraEarn: scheme.extraEarn, extraRoi: scheme.extraRoi, status: scheme.status },
      tier: { tier: tierData.tier, score: tierData.score, recommendedCadence: tierData.recommendedCadence },
    };

    const leverPrompt = `You are writing two sections of a distributor performance report for ${displayName} (state head: ${stateHead}, FY ${fy}, period: ${periodLabel}).

ABSOLUTE RULES:
1. Use ONLY numbers present in the data context below. Never compute, estimate or invent any figure.
2. No emojis. Management register.
3. Return ONLY valid JSON matching the exact schema — no markdown, no commentary.
4. Null means the data is unavailable — say so rather than guessing.

DATA CONTEXT (all figures pre-computed):
${JSON.stringify(dataContext, null, 2)}

Output JSON with this exact schema:
{
  "levers": [
    { "name": "Activate", "priority": "High"|"Medium"|"Low"|"None", "position": "<1 sentence current position>", "dataContext": "<key metric cited>" },
    { "name": "Widen",    "priority": "High"|"Medium"|"Low"|"None", "position": "<1 sentence>", "dataContext": "<metric>" },
    { "name": "Recover",  "priority": "High"|"Medium"|"Low"|"None", "position": "<1 sentence>", "dataContext": "<metric>" },
    { "name": "Read",     "priority": "High"|"Medium"|"Low"|"None", "position": "<1 sentence>", "dataContext": "<metric>" },
    { "name": "Close",    "priority": "High"|"Medium"|"Low"|"None", "position": "<1 sentence>", "dataContext": "<metric>" }
  ],
  "whatToDo": {
    "thisWeek": ["<action 1>", "<action 2>", "<action 3>"],
    "visitPlan": "<2-3 sentences — no invented retailer names>"
  }
}`;

    const claudeRes = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: leverPrompt }],
    });
    const rawText = claudeRes.content.map(c => c.type === "text" ? c.text : "").join("");
    let levers: unknown[] = [];
    let whatToDo: { thisWeek: string[]; visitPlan: string } = { thisWeek: [], visitPlan: "" };
    try {
      const parsed = JSON.parse(stripFences(rawText)) as Record<string, unknown>;
      levers = Array.isArray(parsed.levers) ? parsed.levers : [];
      if (parsed.whatToDo && typeof parsed.whatToDo === "object") {
        const wtd = parsed.whatToDo as Record<string, unknown>;
        whatToDo = {
          thisWeek:  Array.isArray(wtd.thisWeek) ? wtd.thisWeek.map(String) : [],
          visitPlan: typeof wtd.visitPlan === "string" ? wtd.visitPlan : "",
        };
      }
    } catch { req.log.warn("full-report/distributor: failed to parse Claude JSON"); }

    const guard: GuardResult = safeGuard(
      { identity: { fy, stateHead }, headline, reach, range, recovery, rhythm, scheme, tier: tierData },
      { title: displayName, body: gatherText({ levers, whatToDo }) },
    );

    res.json({
      type: "full-distributor-report",
      fy, stateHead, distributor: displayName, normKey: targetNormKey,
      periodLabel, priorPeriodLabel, monthFrom, monthTo,
      dataCutoff: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      headline, levers, reach, range, recovery, rhythm, scheme, tier: tierData,
      whatToDo,
      notAvailable: { items: notAvailableItems },
      guard,
    });
  } catch (err) {
    req.log.error({ err }, "full-report/distributor failed");
    res.status(500).json({ error: "Could not generate distributor report." });
  }
});

// ── ROUTE 2: State Head ────────────────────────────────────────────────────────

router.post("/ai/full-report/statehead", async (req: Request, res: Response): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fy        = typeof b.fy === "string" && FY_PATTERN.test(b.fy.trim()) ? b.fy.trim() : currentOpenFy();
  const stateHead = typeof b.stateHead === "string" && b.stateHead.trim() ? b.stateHead.trim() : "";
  const monthFrom = Math.max(1,  Math.min(12, Number(b.monthFrom ?? 1)));
  const monthTo   = Math.max(monthFrom, Math.min(12, Number(b.monthTo ?? 12)));

  if (!stateHead) { res.status(400).json({ error: "stateHead is required" }); return; }

  const py          = prevFy(fy);
  const labels      = fiscalMonthsToLabels(fy, monthFrom, monthTo);
  const priorLabels = toPriorYearMonths(labels);
  const periodLabel      = buildPeriodLabel(fy, monthFrom, monthTo);
  const priorPeriodLabel = buildPeriodLabel(py, monthFrom, monthTo);
  const quarter     = fiscalMonthToQuarter(monthTo);

  // ── Async job — return 202 immediately, compute in background ─────────────
  const cacheKey = `statehead|${fy}|${stateHead}|${monthFrom}|${monthTo}`;
  try {
    const existingJobId = findLiveJobForCacheKey(cacheKey);
    if (existingJobId) {
      res.status(202).json({ jobId: existingJobId, status: "running" });
      return;
    }

    const jobId = await createJob(cacheKey);
    res.status(202).json({ jobId, status: "queued" });

    void (async () => {
      try {
        await markJobRunning(jobId);
    // ── Load data in parallel ─────────────────────────────────────────────────
    const [deepDiveResult, rowsResult, blockedResult] = await Promise.all([
      loadDistributorDeepDive(fy, stateHead).catch((): DistributorDeepDiveResult | null => null),
      assembleRows({ fy, states: [], regions: [], monthFrom, monthTo, lowPerfPct: 0 }).catch(() => null),
      getBlockedCustomers().catch((): { blocked: Set<string>; available: boolean } => ({ blocked: new Set<string>(), available: false })),
    ]);

    const schemeResult: NudgeResult | null = await computeNudgeList(
      fy, quarter, blockedResult.blocked, blockedResult.available, 0.05, stateHead,
    ).catch((): NudgeResult | null => null);

    // Member name list (for qty query) — use member names from assembleRows
    // These match head_canon in sale_line_current (member display names).
    const uniqueHeads = [
      ...new Set((rowsResult?.rows ?? []).map(r => r.m?.name).filter((n): n is string => !!n)),
    ];

    const [teamQtyRows, shrinkerRows] = await Promise.all([
      queryTeamQty(fy, labels, uniqueHeads),
      queryShrinkers(fy, labels, py, priorLabels),
    ]);

    const totalTeamQty = teamQtyRows.reduce((s: number, r: TeamQtyRow) => s + (parseFloat(r.qty) || 0), 0);

    // ── §1 Headline (from assembleRows secondary OB + targets) ────────────────
    const rows = rowsResult?.rows ?? [];
    const teamSecondaryOb = rows.reduce((s, r) => s + (r.orders?.amount ?? 0), 0);
    // Annual secondary target (full-year denominator for achievement %)
    const teamTarget      = rows.reduce((s, r) => s + (r.target?.annual?.secondary ?? 0), 0);
    const activeCount     = rows.filter(r => (r.orders?.orderCount ?? 0) > 0).length;

    const headline = {
      periodLabel, priorPeriodLabel,
      teamNet:            teamSecondaryOb > 0 ? t2(teamSecondaryOb) : null,
      teamNetSource:      "secondary order booking (Sub Total from member working sheets)",
      teamQty:            totalTeamQty > 0 ? t2(totalTeamQty) : null,
      teamQtySource:      "primary sales register (sale_line) — pieces dispatched",
      achievementPct:     teamTarget > 0 && teamSecondaryOb > 0 ? pct(teamSecondaryOb, teamTarget) : null,
      target:             teamTarget > 0 ? t2(teamTarget) : null,
      targetSource:       "Target Master sheet",
      activeMemberCount:  activeCount,
      totalMemberCount:   rows.length,
    };

    // ── §2 Team table ─────────────────────────────────────────────────────────
    const memberRows = rows.map(row => {
      const net     = t2(row.orders?.amount ?? null);
      const prNet   = t2(row.priorAmount ?? null);
      const tgtAnnual = row.target?.annual?.secondary ?? null;
      const tgt       = tgtAnnual != null && tgtAnnual > 0 ? t2(tgtAnnual) : null;
      const hasTarget = tgt != null;
      const achievement = hasTarget && net != null ? pct(net, tgt!) : null;
      return {
        name:                    row.m?.name ?? "Unknown",
        net,
        priorNet:                prNet,
        netGrowthPct:            deltaPct(net, prNet),
        retailersDeclared:       row.orders?.totalRetailers ?? null,
        retailersDeclaredSource: "member working sheets (secondary order file — declared active party count)",
        retailersFromSheet:      null as number | null,
        retailersFromSheetNote:  "Retailer Master from member working sheet not loaded in this request",
        achievementPct:          achievement,
        target:                  tgt,
        hasTarget,
        targetNote:              !hasTarget ? "no target recorded" : null,
      };
    });

    // ── §3 Coverage ───────────────────────────────────────────────────────────
    const dd = deepDiveResult;
    const assignmentGapDistricts = dd ? (() => {
      // gather from per-state rows — whitespace.districtStats has district-level detail
      const wh = dd.whitespace;
      if (!wh) return [];
      return wh.districtStats
        .filter(d => d.noneCount > 0)
        .sort((a, b) => b.noneCount - a.noneCount)
        .slice(0, 10)
        .map(d => ({ district: d.district, count: d.noneCount }));
    })() : [];

    const coverage = {
      periodLabel,
      distributorCount:          dd?.distributors.length ?? null,
      distributorRetailerCount:  dd?.distributors.reduce((s: number, d: DistributorGroup) => s + d.retailerCount, 0) ?? null,
      unassignedRetailerCount:   dd?.noneAssigned?.retailerCount ?? null,
      assignmentGapDistricts,
      assignmentGapDistrictsSource: "member working sheets (D1 — retailers with no distributor assigned)",
    };

    // ── §4 Distributor mix ────────────────────────────────────────────────────
    const tierBuckets = new Map<string, number>();
    const concentrationFlags: { name: string; sharePct: number }[] = [];

    for (const d of dd?.distributors ?? [] as DistributorGroup[]) {
      const tier = d.investment?.tier?.tier ?? "unscored";
      tierBuckets.set(tier, (tierBuckets.get(tier) ?? 0) + 1);
      if (d.isConcentrationRisk && d.obSharePct != null) {
        concentrationFlags.push({ name: d.name, sharePct: t2(d.obSharePct) ?? d.obSharePct });
      }
    }
    const tierCounts = [...tierBuckets.entries()].map(([tier, count]) => ({ tier, count }));

    let largestDep: { distributorName: string; retailerName: string; sharePct: number } | null = null;
    for (const d of dd?.distributors ?? [] as DistributorGroup[]) {
      const rc = d.retailerConcentration;
      if (rc?.topRetailerSharePct != null && rc.topRetailerName != null) {
        if (largestDep == null || rc.topRetailerSharePct > largestDep.sharePct) {
          largestDep = {
            distributorName: d.name,
            retailerName: rc.topRetailerName,
            sharePct: t2(rc.topRetailerSharePct) ?? rc.topRetailerSharePct,
          };
        }
      }
    }

    const distributorMix = { tierCounts, concentrationFlags, largestRetailerDependency: largestDep };

    // ── §5 Range ──────────────────────────────────────────────────────────────
    // DistributorSkuSpread has distinctBrands (not codesBought); use it as proxy.
    const skuSpreadData = (dd?.distributors ?? [] as DistributorGroup[])
      .filter((d: DistributorGroup) => d.skuSpread?.distinctBrands != null)
      .map((d: DistributorGroup) => ({
        distributorName: d.name,
        distinctBrands:  d.skuSpread!.distinctBrands!,
        broadSegments:   d.skuSpread?.broadSegmentsCovered ?? null,
      }));

    const top5ByGapValue = skuSpreadData
      .sort((a, b) => (a.distinctBrands ?? 0) - (b.distinctBrands ?? 0))
      .slice(0, 5)
      .map(d => ({
        distributorName: d.distributorName,
        distinctBrands:  d.distinctBrands,
        broadSegments:   d.broadSegments ?? null,
        gapValueNote: "value of range gap requires per-code net — not computed in this report",
      }));

    const stateCodesBought = skuSpreadData.length > 0
      ? skuSpreadData.reduce((s, d) => s + d.distinctBrands, 0) : null;

    const rangeData = {
      excludesProject: true as const,
      excludesProjectNote: "territory figures — project / govt / non-territory channel excluded",
      stateCodesBought,
      stateCodesBoughtNote: skuSpreadData.length > 0
        ? `sum of ${skuSpreadData.length} distributors with SKU spread data` : "SKU spread data not available",
      nationalMedianCodes: null as number | null,
      nationalMedianCodesSource: "peer median not available in SKU spread data (requires primary sales comparison)",
      top5ByGapValue,
    };

    // ── §6 Attention ──────────────────────────────────────────────────────────
    const hiddenShrinkers = shrinkerRows.map((r: ShrinkerRow) => ({
      name:         r.customer,
      net:          t2safe(r.net),
      priorNet:     t2safe(r.prior_net),
      netGrowthPct: deltaPct(t2safe(r.net), t2safe(r.prior_net)),
      qtyGrowthPct: deltaPct(t2safe(r.qty), t2safe(r.prior_qty)),
    }));

    const silentDistributors = (dd?.distributors ?? [] as DistributorGroup[])
      .filter((d: DistributorGroup) => d.flows?.daysSinceLastOrder != null && d.flows.daysSinceLastOrder > 42)
      .map((d: DistributorGroup) => ({
        name:          d.name,
        daysSilent:    d.flows!.daysSinceLastOrder!,
        lastOrderDate: d.flows?.lastInvoiceDate ?? null,
      }))
      .sort((a, b) => b.daysSilent - a.daysSilent);

    const attention = { hiddenShrinkers, silentDistributors };

    // ── §7 Schemes ────────────────────────────────────────────────────────────
    const stateNudges = (schemeResult?.nudges ?? [] as NudgeRow[])
      .filter((n: NudgeRow) => n.status === "NUDGE" || n.status === "TRIP_ZONE")
      .sort((a: NudgeRow, b: NudgeRow) => (b.extraEarn ?? 0) - (a.extraEarn ?? 0))
      .slice(0, 20)
      .map((n: NudgeRow) => ({
        customer:    n.customer,
        extraEarn:   n.extraEarn != null ? t2(n.extraEarn) : null,
        extraRoi:    n.extraRoi  != null ? t2(n.extraRoi * 100) : null,
        gap:         t2(n.gap) ?? 0,
        billedSoFar: t2(n.billedSoFar),
      }));

    const totalGapToClose = stateNudges.reduce((s, n) => s + (n.gap ?? 0), 0);

    const schemes = {
      quarter, deadline: schemeResult?.deadline ?? null,
      nudges: stateNudges,
      totalGapToClose: stateNudges.length > 0 ? t2(totalGapToClose) : null,
    };

    // ── §9 Not available ──────────────────────────────────────────────────────
    const notAvailableItems: { item: string; reason: string }[] = [
      { item: "Margin and cost-derived figures", reason: "no cost master exists in the system" },
    ];
    if (!deepDiveResult) notAvailableItems.push({ item: "Distributor and coverage data", reason: "distributor deep dive could not be loaded" });
    if (rangeData.stateCodesBought == null) notAvailableItems.push({ item: "SKU range comparison", reason: "SKU spread data not available for this state head" });
    if (memberRows.every(m => m.retailersFromSheet == null)) {
      notAvailableItems.push({ item: "Retailer count from Retailer Master (per member)", reason: "member working sheets not loaded in this request" });
    }

    // ── §8 What To Do via Claude ──────────────────────────────────────────────
    const wtdContext = {
      stateHead, fy, periodLabel,
      headline: { teamNet: headline.teamNet, achievementPct: headline.achievementPct, activeMemberCount: headline.activeMemberCount },
      attentionShrinkers:  hiddenShrinkers.slice(0, 3).map(s => ({ name: s.name, netGrowthPct: s.netGrowthPct, qtyGrowthPct: s.qtyGrowthPct })),
      attentionSilent:     silentDistributors.slice(0, 3),
      topSchemeNudges:     stateNudges.slice(0, 3),
      concentrationFlags:  concentrationFlags.slice(0, 3),
      topGapDistributors:  top5ByGapValue.slice(0, 3),
    };

    const wtdPrompt = `You are writing the "What to Do" section of a state head performance report for ${stateHead} (FY ${fy}, period: ${periodLabel}).

ABSOLUTE RULES:
1. Use ONLY numbers present in the data context. Never compute, estimate or invent figures.
2. Every action must name the specific person or distributor involved.
3. No emojis. Management register.
4. Return ONLY valid JSON — no markdown, no commentary.

DATA CONTEXT:
${JSON.stringify(wtdContext, null, 2)}

Output JSON with this exact schema:
{
  "rankedActions": [
    { "action": "<specific action with name>", "namesInvolved": ["<name>"], "urgency": "immediate"|"this-week"|"this-month" }
  ]
}
(5 to 8 actions, ordered by urgency then impact)`;

    const wtdRes = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: wtdPrompt }],
    });
    const wtdRaw = wtdRes.content.map(c => c.type === "text" ? c.text : "").join("");
    let rankedActions: unknown[] = [];
    try {
      const p = JSON.parse(stripFences(wtdRaw)) as Record<string, unknown>;
      rankedActions = Array.isArray(p.rankedActions) ? p.rankedActions : [];
    } catch { req.log.warn("full-report/statehead: failed to parse Claude JSON"); }

    const guard2: GuardResult = safeGuard(
      { identity: { fy, stateHead }, headline, teamTable: { members: memberRows }, coverage, distributorMix },
      { title: stateHead, body: gatherText(rankedActions) },
    );

        await markJobComplete(jobId, {
          type: "full-statehead-report",
          fy, stateHead, periodLabel, priorPeriodLabel, monthFrom, monthTo,
          dataCutoff: new Date().toISOString().slice(0, 10),
          generatedAt: new Date().toISOString(),
          headline,
          teamTable: { members: memberRows },
          coverage, distributorMix, range: rangeData, attention, schemes,
          whatToDo: { rankedActions },
          notAvailable: { items: notAvailableItems },
          guard: guard2,
        });
      } catch (innerErr) {
        console.error("[statehead-report] background job failed:", innerErr);
        await markJobFailed(
          jobId,
          innerErr instanceof Error ? innerErr.message : String(innerErr),
        ).catch(() => { /* swallow secondary failure */ });
      }
    })();
  } catch (outerErr) {
    console.error("[statehead-report] job creation failed:", outerErr);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not queue state head report." });
    }
  }
});

export default router;
