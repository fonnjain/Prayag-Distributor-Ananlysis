// Master Growth Report — POST /api/ai/full-report/growth
//
// Scope: company-wide | one state head | one state
//
// HARD RULES (enforced in this file):
//  - Every figure comes from the query layer. Claude writes prose ONLY.
//  - Claude never produces a number, a name, a rank or a total.
//  - If a section has no data, it is rendered with a reason line — never
//    let Claude fill the gap with plausible-sounding text.
//  - Any recommendation that cannot name at least one entity is dropped.
//  - Project / non-territory business is excluded from all opportunity figures.
//  - Totals shown as RANGE: half the assumption to the full assumption.
//  - Deduplication: CLOSE > RECOVER > ACTIVATE > WIDEN (enforced in code).

import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  loadDistributorDeepDive,
  toPriorYearMonths,
  type DistributorDeepDiveResult,
  type DistributorGroup,
} from "../lib/mgmt/distributorDeepDive.js";
import { computeNudgeList, type NudgeRow, type NudgeResult } from "../lib/schemes/nudge.js";
import { getBlockedCustomers } from "../lib/schemes/dues.js";
import { fiscalMonthsToLabels } from "../lib/mgmt/primaryPeriod.js";
import { assembleRows } from "../lib/mgmt/report.js";
import { runNumericGuard, type GuardResult } from "../lib/mgmt/numericGuard.js";
import { isFrozen } from "../lib/customers/registerSync.js";

const router: IRouter = Router();
const MODEL = "claude-sonnet-4-6";
const PROJECT_HEAD = "Non-territory / Project / Govt";
const FY_PATTERN = /^\d{4}-\d{2}$/;

// ── Growth report snapshot cache ──────────────────────────────────────────────
// Open-FY results are cached for 15 minutes — the same window as the member-
// sheet cache, so a re-request within that window can never see newer data.
// Closed-FY results are stored permanently (no TTL) because the underlying
// registers are frozen and can never change.
// The cache is invalidated by invalidateGrowthReportCache(), called whenever
// invalidateMgmtDataCache() runs (re-sync, dashboard xlsx upload, etc.).

const GROWTH_CACHE_TTL_MS = 15 * 60_000;
const GROWTH_CACHE_PREFIX = "growth-report|";

type GrowthCacheEntry = { payload: Record<string, unknown>; until: number | null };
const growthCache = new Map<string, GrowthCacheEntry>();

function growthCacheKey(
  fy: string, scope: string, stateHead: string, state: string,
  monthFrom: number, monthTo: number,
  dormantRevival: number, atRiskRecovery: number, rangeUptake: number,
): string {
  return `${GROWTH_CACHE_PREFIX}${fy}|${scope}|${stateHead}|${state}|${monthFrom}|${monthTo}|${dormantRevival}|${atRiskRecovery}|${rangeUptake}`;
}

/** Drop cached growth report payloads.
 *  Called whenever a register re-sync / dashboard upload invalidates mgmt caches. */
export function invalidateGrowthReportCache(fy?: string): void {
  if (!fy) { growthCache.clear(); return; }
  const prefix = `${GROWTH_CACHE_PREFIX}${fy}|`;
  for (const k of growthCache.keys()) if (k.startsWith(prefix)) growthCache.delete(k);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function t2(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
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
function deltaPct(cur: number | null, prior: number | null): number | null {
  if (cur == null || prior == null || prior === 0) return null;
  return t2(((cur - prior) / prior) * 100);
}
function prevFy(fy: string): string {
  const s = parseInt(fy.split("-")[0]!, 10) - 1;
  return `${s}-${String(s + 1).slice(-2)}`;
}
const FULL_MONTH_NAMES = [
  "April", "May", "June", "July", "August", "September",
  "October", "November", "December", "January", "February", "March",
];
function buildPeriodLabel(fy: string, from: number, to: number): string {
  const fyStart = parseInt(fy.split("-")[0]!, 10);
  if (from === 1 && to === 12) return `Full FY ${fy}`;
  const f = FULL_MONTH_NAMES[from - 1]!;
  const t = FULL_MONTH_NAMES[to - 1]!;
  const fromY = from <= 9 ? fyStart : fyStart + 1;
  const toY   = to   <= 9 ? fyStart : fyStart + 1;
  if (f === t && fromY === toY) return `${f} ${fromY} (1 month)`;
  if (fromY === toY) return `${f} to ${t} ${fromY} (${to - from + 1} months)`;
  return `${f} ${fromY} to ${t} ${toY} (${to - from + 1} months)`;
}
function fiscalMonthToQuarter(m: number): "Q1"|"Q2"|"Q3"|"Q4" {
  if (m <= 3) return "Q1"; if (m <= 6) return "Q2"; if (m <= 9) return "Q3"; return "Q4";
}
function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

// ── SQL queries ───────────────────────────────────────────────────────────────

type CustomerStateRow = {
  customer: string;
  head_canon: string | null;
  state_canon: string | null;
  cur_net: string | null;
  prior_net: string | null;
  cur_codes: string | null;
  prior_codes: string | null;
};

/** Compare current vs prior like-months, scoped. Project channel excluded. */
async function queryCustomerStates(
  fy: string,
  labels: string[],
  priorLabels: string[],
  headFilter: string | null,
  stateFilter: string | null,
): Promise<CustomerStateRow[]> {
  if (labels.length === 0 && priorLabels.length === 0) return [];
  const allLabels = [...new Set([...labels, ...priorLabels])];
  const labelFrag  = sql.join(allLabels.map(l => sql`${l}`), sql`, `);
  const curFrag    = sql.join(labels.length  > 0 ? labels.map(l => sql`${l}`)       : [sql`NULL`], sql`, `);
  const priorFrag  = sql.join(priorLabels.length > 0 ? priorLabels.map(l => sql`${l}`) : [sql`NULL`], sql`, `);
  const py = prevFy(fy);
  const headClause  = headFilter  ? sql`AND sl.head_canon = ${headFilter}`  : sql``;
  const stateClause = stateFilter ? sql`AND sl.state_canon = ${stateFilter}` : sql``;

  const res = await db.execute<CustomerStateRow>(sql`
    WITH all_rows AS (
      SELECT customer, head_canon, state_canon, month_label, amount::float8 as amt,
             code, fy
      FROM   sale_line
      WHERE  version_status = 'current'
        AND  month_label IN (${labelFrag})
        AND  (head_canon IS NULL OR head_canon NOT ILIKE ${'%project%'})
        AND  head_canon != ${PROJECT_HEAD}
        ${headClause}
        ${stateClause}
    ),
    cur AS (
      SELECT customer,
             MAX(head_canon)  as head_canon,
             MAX(state_canon) as state_canon,
             SUM(amt)                              as cur_net,
             COUNT(DISTINCT code)                  as cur_codes
      FROM   all_rows
      WHERE  month_label IN (${curFrag}) AND fy = ${fy}
      GROUP BY customer
    ),
    prior AS (
      SELECT customer,
             SUM(amt)         as prior_net,
             COUNT(DISTINCT code) as prior_codes
      FROM   all_rows
      WHERE  month_label IN (${priorFrag}) AND fy = ${py}
      GROUP BY customer
    )
    SELECT
      COALESCE(c.customer, p.customer)               as customer,
      c.head_canon,
      c.state_canon,
      c.cur_net::text                                as cur_net,
      p.prior_net::text                              as prior_net,
      c.cur_codes::text                              as cur_codes,
      p.prior_codes::text                            as prior_codes
    FROM   cur c
    FULL OUTER JOIN prior p USING (customer)
    WHERE  COALESCE(c.cur_net, 0) + COALESCE(p.prior_net, 0) > 0
    ORDER  BY COALESCE(p.prior_net, 0) DESC
  `);
  return res.rows;
}

type LostCodeRow = { segment: string; codes_lost: string; prior_net: string };
async function queryLostCodes(
  fy: string,
  labels: string[],
  priorLabels: string[],
  headFilter: string | null,
  stateFilter: string | null,
): Promise<LostCodeRow[]> {
  if (labels.length === 0 || priorLabels.length === 0) return [];
  const py = prevFy(fy);
  const curFrag   = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const priorFrag = sql.join(priorLabels.map(l => sql`${l}`), sql`, `);
  const headClause  = headFilter  ? sql`AND head_canon = ${headFilter}`  : sql``;
  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;
  const res = await db.execute<LostCodeRow>(sql`
    WITH cur_codes AS (
      SELECT DISTINCT code FROM sale_line
      WHERE version_status='current' AND fy=${fy}
        AND month_label IN (${curFrag})
        AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause}
        AND code IS NOT NULL AND code != ''
    ),
    prior_codes AS (
      SELECT code,
             COALESCE(group_canon, group_raw, 'Unmapped') as segment,
             SUM(amount::float8) as prior_net
      FROM sale_line
      WHERE version_status='current' AND fy=${py}
        AND month_label IN (${priorFrag})
        AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause}
        AND code IS NOT NULL AND code != ''
      GROUP BY code, COALESCE(group_canon, group_raw, 'Unmapped')
    )
    SELECT p.segment,
           COUNT(DISTINCT p.code)::text as codes_lost,
           SUM(p.prior_net)::text       as prior_net
    FROM   prior_codes p
    LEFT   JOIN cur_codes c USING (code)
    WHERE  c.code IS NULL
    GROUP  BY p.segment
    ORDER  BY SUM(p.prior_net) DESC
  `);
  return res.rows;
}

type NarrowerRow = { customer: string; cur_codes: string; prior_codes: string; code_drop: string; prior_net: string };
async function queryNarrowers(
  fy: string,
  labels: string[],
  priorLabels: string[],
  headFilter: string | null,
  stateFilter: string | null,
): Promise<NarrowerRow[]> {
  if (labels.length === 0 || priorLabels.length === 0) return [];
  const py = prevFy(fy);
  const curFrag   = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const priorFrag = sql.join(priorLabels.map(l => sql`${l}`), sql`, `);
  const headClause  = headFilter  ? sql`AND head_canon = ${headFilter}`  : sql``;
  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;
  const res = await db.execute<NarrowerRow>(sql`
    WITH cur AS (
      SELECT customer, COUNT(DISTINCT code)::int as cur_codes
      FROM sale_line WHERE version_status='current' AND fy=${fy}
        AND month_label IN (${curFrag}) AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause} AND code IS NOT NULL AND code != ''
      GROUP BY customer
    ),
    prior AS (
      SELECT customer, COUNT(DISTINCT code)::int as prior_codes,
             SUM(amount::float8) as prior_net
      FROM sale_line WHERE version_status='current' AND fy=${py}
        AND month_label IN (${priorFrag}) AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause} AND code IS NOT NULL AND code != ''
      GROUP BY customer
    )
    SELECT c.customer,
           c.cur_codes::text, p.prior_codes::text,
           (p.prior_codes - c.cur_codes)::text as code_drop,
           p.prior_net::text as prior_net
    FROM cur c JOIN prior p USING (customer)
    WHERE p.prior_codes > c.cur_codes AND p.prior_codes >= 3
    ORDER BY (p.prior_codes - c.cur_codes) DESC
    LIMIT 20
  `);
  return res.rows;
}

type MedianRow = { median_net: string; active_count: string };
async function queryMedianActiveCustomer(
  fy: string,
  labels: string[],
  headFilter: string | null,
  stateFilter: string | null,
): Promise<MedianRow> {
  if (labels.length === 0) return { median_net: "0", active_count: "0" };
  const labelFrag  = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const headClause  = headFilter  ? sql`AND head_canon = ${headFilter}`  : sql``;
  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;
  const res = await db.execute<MedianRow>(sql`
    WITH cust_net AS (
      SELECT customer, SUM(amount::float8) as net
      FROM sale_line WHERE version_status='current' AND fy=${fy}
        AND month_label IN (${labelFrag}) AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause}
      GROUP BY customer HAVING SUM(amount::float8) > 0
    )
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net)::text as median_net,
      COUNT(*)::text as active_count
    FROM cust_net
  `);
  return res.rows[0] ?? { median_net: "0", active_count: "0" };
}

type ProjectGapRow = { customer: string; total_net: string; project_net: string; project_pct: string };
async function queryProjectGaps(
  fy: string,
  labels: string[],
): Promise<ProjectGapRow[]> {
  if (labels.length === 0) return [];
  const labelFrag = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const res = await db.execute<ProjectGapRow>(sql`
    WITH by_customer AS (
      SELECT customer,
             SUM(amount::float8)                                                                          as total_net,
             SUM(CASE WHEN head_canon = ${PROJECT_HEAD} THEN amount::float8 ELSE 0 END)                  as project_net
      FROM   sale_line
      WHERE  version_status = 'current' AND fy = ${fy}
        AND  month_label IN (${labelFrag})
        AND  customer IS NOT NULL AND customer != ''
      GROUP  BY customer
      HAVING SUM(CASE WHEN head_canon = ${PROJECT_HEAD} THEN amount::float8 ELSE 0 END) > 0
    )
    SELECT customer,
           total_net::text, project_net::text,
           (project_net * 100.0 / NULLIF(total_net, 0))::text as project_pct
    FROM   by_customer
    WHERE  project_net * 100.0 / NULLIF(total_net, 0) > 50
    ORDER  BY project_net DESC
    LIMIT  10
  `);
  return res.rows;
}

// ── Secondary SKU line availability check ─────────────────────────────────────
//
// Returns true when secondary_sku_line has at least one row for the given FY
// (and optional state), regardless of whether any opportunity queries return rows.
// This is intentionally separate from the opportunity queries so that "no
// qualifying distributor" and "data not loaded" produce different messages.

async function querySecondarySkuLineExists(
  fy: string,
  stateFilter?: string | null,
): Promise<boolean> {
  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;
  const res = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM   secondary_sku_line
    WHERE  fy = ${fy}
      ${stateClause}
    LIMIT 1
  `);
  return parseInt(res.rows[0]?.n ?? "0") > 0;
}

// ── Company-scope distributor activation (SQL-only, no Sheets deep dive) ──────
//
// Counts all distinct retailers that appeared for each distributor across the
// whole FY, and active retailers (net_amount > 0) in the requested period.
// Source: secondary_sku_line (item-code level register, has distributor column).
// Returns top-20 lowest-activation distributors (< 40%), sorted by dormant count.

type DistActivationRow = {
  distributor: string;
  retailer_count: string;
  active_count: string;
};

async function queryDistributorActivationCompany(
  fy: string,
  labels: string[],
  stateFilter?: string | null,
): Promise<DistActivationRow[]> {
  // secondary_sku_line only covers closed FYs — return empty for FYs with no data
  const check = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM secondary_sku_line WHERE fy = ${fy} LIMIT 1
  `);
  if (parseInt(check.rows[0]?.n ?? "0") === 0) return [];

  const periodFrag = labels.length > 0
    ? sql`AND month_label IN (${sql.join(labels.map(l => sql`${l}`), sql`, `)})`
    : sql``;
  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;

  const res = await db.execute<DistActivationRow>(sql`
    WITH all_ret AS (
      SELECT distributor,
             COALESCE(NULLIF(TRIM(retailer_id), ''), LOWER(TRIM(retailer))) AS rkey
      FROM   secondary_sku_line
      WHERE  fy = ${fy}
        AND  distributor IS NOT NULL AND TRIM(distributor) != ''
        AND  retailer    IS NOT NULL AND TRIM(retailer)    != ''
        ${stateClause}
    ),
    active_ret AS (
      SELECT distributor,
             COALESCE(NULLIF(TRIM(retailer_id), ''), LOWER(TRIM(retailer))) AS rkey
      FROM   secondary_sku_line
      WHERE  fy = ${fy}
        AND  distributor IS NOT NULL AND TRIM(distributor) != ''
        AND  retailer    IS NOT NULL AND TRIM(retailer)    != ''
        AND  net_amount  > 0
        ${periodFrag}
        ${stateClause}
    )
    SELECT a.distributor,
           COUNT(DISTINCT a.rkey)::text  AS retailer_count,
           COUNT(DISTINCT ac.rkey)::text AS active_count
    FROM   all_ret a
    LEFT   JOIN active_ret ac USING (distributor, rkey)
    GROUP  BY a.distributor
    HAVING COUNT(DISTINCT a.rkey) >= 3
    ORDER  BY (COUNT(DISTINCT ac.rkey)::float / NULLIF(COUNT(DISTINCT a.rkey), 0)) ASC
    LIMIT  50
  `);
  return res.rows;
}

// ── Company-scope distributor range gap (SQL-only) ────────────────────────────
//
// Counts distinct segment_canon values per distributor in secondary_sku_line,
// computes the peer median, and returns distributors below the median.
// Returns top-20 with the largest gap vs peer median.

type DistRangeGapRow = {
  distributor: string;
  distinct_segments: string;
  peer_median: string;
  gap: string;
};

async function queryDistributorRangeGapCompany(
  fy: string,
  stateFilter?: string | null,
): Promise<DistRangeGapRow[]> {
  const check = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM secondary_sku_line WHERE fy = ${fy} LIMIT 1
  `);
  if (parseInt(check.rows[0]?.n ?? "0") === 0) return [];

  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;

  const res = await db.execute<DistRangeGapRow>(sql`
    WITH dist_segs AS (
      SELECT distributor,
             COUNT(DISTINCT segment_canon) AS distinct_segments
      FROM   secondary_sku_line
      WHERE  fy          = ${fy}
        AND  distributor IS NOT NULL AND TRIM(distributor) != ''
        AND  segment_canon IS NOT NULL AND TRIM(segment_canon) != ''
        AND  TRIM(segment_canon) != 'Unmapped'
        AND  net_amount  > 0
        ${stateClause}
      GROUP  BY distributor
      HAVING COUNT(DISTINCT segment_canon) >= 1
    ),
    peer AS (
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY distinct_segments) AS median_segs
      FROM   dist_segs
    )
    SELECT d.distributor,
           d.distinct_segments::text                                   AS distinct_segments,
           p.median_segs::text                                          AS peer_median,
           (p.median_segs - d.distinct_segments)::text                 AS gap
    FROM   dist_segs d, peer p
    WHERE  p.median_segs > d.distinct_segments
    ORDER  BY (p.median_segs - d.distinct_segments) DESC
    LIMIT  20
  `);
  return res.rows;
}

type ShrinkerRow = { customer: string; net: string; prior_net: string; qty: string; prior_qty: string };
async function queryShrinkers(
  fy: string,
  labels: string[],
  py: string,
  priorLabels: string[],
  headFilter: string | null,
  stateFilter: string | null,
): Promise<ShrinkerRow[]> {
  if (labels.length === 0 || priorLabels.length === 0) return [];
  const labelFrag  = sql.join(labels.map(l => sql`${l}`), sql`, `);
  const priorFrag  = sql.join(priorLabels.map(l => sql`${l}`), sql`, `);
  const headClause  = headFilter  ? sql`AND head_canon = ${headFilter}`  : sql``;
  const stateClause = stateFilter ? sql`AND state_canon = ${stateFilter}` : sql``;
  const res = await db.execute<ShrinkerRow>(sql`
    WITH cur AS (
      SELECT customer, SUM(amount::float8) as net, SUM(qty::float8) as qty
      FROM   sale_line
      WHERE  version_status='current' AND fy=${fy}
        AND  month_label IN (${labelFrag}) AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause}
      GROUP  BY customer HAVING SUM(amount::float8) > 0
    ),
    prior AS (
      SELECT customer, SUM(amount::float8) as net, SUM(qty::float8) as qty
      FROM   sale_line
      WHERE  version_status='current' AND fy=${py}
        AND  month_label IN (${priorFrag}) AND head_canon != ${PROJECT_HEAD}
        ${headClause} ${stateClause}
      GROUP  BY customer HAVING SUM(amount::float8) > 0
    )
    SELECT c.customer,
           c.net::text as net, p.net::text as prior_net,
           c.qty::text as qty, p.qty::text as prior_qty
    FROM   cur c JOIN prior p USING (customer)
    WHERE  c.net > p.net                    -- value up
      AND  (p.qty = 0 OR c.qty / NULLIF(p.qty, 0) < 0.95)  -- qty flat or down
    ORDER  BY (c.net - p.net) / NULLIF(p.net, 0) DESC
    LIMIT  20
  `);
  return res.rows;
}

// ── Claude narrative call ─────────────────────────────────────────────────────

async function generateNarrative(
  scope: string,
  fy: string,
  periodLabel: string,
  sections: Record<string, unknown>,
  ledgerRows: Array<{ lever: string; entityName: string; valueHigh: number | null }>,
): Promise<{ sectionNarratives: Record<string, string>; ledgerWhatToDo: string[] }> {
  const prompt = `You are writing narrative prose for a Master Growth Report for ${scope} (FY ${fy}, ${periodLabel}).

ABSOLUTE RULES — READ FIRST, VIOLATE ANY = RESTART:
1. You write PROSE ONLY. You never produce a number, a name, a rank, or a total.
   Every figure in this report was computed by the query layer and passed to you.
   Your job is to write the interpretation, not the data.
2. Management register only. No emojis. No hyperbole.
3. Every action you suggest must remain at the level of "pursue the dormant accounts in this segment" 
   not "reach out to [specific name]" — names come from the data tables, not your prose.
4. If a section has no data (marked notAvailable), write ONLY the reason sentence. Do not speculate.
5. Return ONLY valid JSON — no markdown fences, no commentary before or after.

SECTION DATA:
${JSON.stringify(sections, null, 2)}

TOP LEDGER ROWS (write one "what to do" sentence for each — maximum 15 words, action-oriented prose):
${JSON.stringify(ledgerRows.slice(0, 20).map((r, i) => ({ idx: i, lever: r.lever, entityType: "entity" })), null, 2)}

OUTPUT JSON SCHEMA:
{
  "sectionNarratives": {
    "executiveSummary": "<2-3 sentence interpretation of the opportunity landscape>",
    "activate": "<2-3 sentence interpretation of the activation opportunity>",
    "widen": "<2-3 sentence interpretation of the range gap>",
    "recover": "<2-3 sentence interpretation of the recovery opportunity>",
    "protect": "<2-3 sentence interpretation of the protection risks>",
    "close": "<2-3 sentence interpretation of the scheme close opportunity>",
    "whereNotToLook": "<1-2 sentence interpretation of the exclusions>",
    "capacityCheck": "<1-2 sentence interpretation of the capacity fit>",
    "assumptionsAndLimits": "<1 sentence on what the assumptions imply>"
  },
  "ledgerWhatToDo": [
    "<action prose for row 0>",
    "<action prose for row 1>"
  ]
}`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.content.map(c => c.type === "text" ? c.text : "").join("");
    const parsed = JSON.parse(stripFences(raw)) as {
      sectionNarratives?: Record<string, string>;
      ledgerWhatToDo?: string[];
    };
    return {
      sectionNarratives: parsed.sectionNarratives ?? {},
      ledgerWhatToDo: parsed.ledgerWhatToDo ?? [],
    };
  } catch {
    return { sectionNarratives: {}, ledgerWhatToDo: [] };
  }
}

// ── Ledger builder ────────────────────────────────────────────────────────────

type LedgerRow = {
  rank: number;
  lever: "CLOSE" | "RECOVER" | "ACTIVATE" | "WIDEN";
  entityType: string;
  entityName: string;
  whatToDo: string;
  valueLow: number | null;
  valueHigh: number | null;
  effort: "Low" | "Medium" | "High";
  confidence: "High" | "Medium" | "Low";
  conversionAssumption?: number;
  basisNote?: string;
};

// ── ROUTE ─────────────────────────────────────────────────────────────────────

router.post("/ai/full-report/growth", async (req: Request, res: Response): Promise<void> => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fy       = typeof b.fy === "string" && FY_PATTERN.test(b.fy.trim()) ? b.fy.trim() : "2026-27";
  const scope    = typeof b.scope === "string" && ["company","statehead","state"].includes(b.scope) ? b.scope as "company"|"statehead"|"state" : "company";
  const stateHead = typeof b.stateHead === "string" ? b.stateHead.trim() : "";
  const state     = typeof b.state    === "string" ? b.state.trim()     : "";
  const monthFrom = Math.max(1, Math.min(12, Number(b.monthFrom ?? 1)));
  const monthTo   = Math.max(monthFrom, Math.min(12, Number(b.monthTo ?? 12)));

  // Conversion assumptions (user-adjustable, bounded)
  const dormantRevival = Math.max(0.05, Math.min(0.75, Number(b.dormantRevivalPct ?? 0.25)));
  const atRiskRecovery = Math.max(0.05, Math.min(0.75, Number(b.atRiskRecoveryPct ?? 0.35)));
  const rangeUptake    = Math.max(0.05, Math.min(0.75, Number(b.rangeUptakePct    ?? 0.40)));

  if (scope === "statehead" && !stateHead) {
    res.status(400).json({ error: "stateHead is required when scope is statehead" });
    return;
  }
  if (scope === "state" && !state) {
    res.status(400).json({ error: "state is required when scope is state" });
    return;
  }

  const forceFresh = b.forceFresh === true || b.forceFresh === "true";

  const scopeLabel = scope === "company" ? "All India" :
    scope === "statehead" ? stateHead :
    state;

  const py          = prevFy(fy);
  const labels      = fiscalMonthsToLabels(fy, monthFrom, monthTo);
  const priorLabels = toPriorYearMonths(labels);
  const periodLabel      = buildPeriodLabel(fy, monthFrom, monthTo);
  const priorPeriodLabel = buildPeriodLabel(py, monthFrom, monthTo);
  const quarter          = fiscalMonthToQuarter(monthTo);

  const headFilter  = scope === "statehead" ? stateHead : null;
  const stateFilter = scope === "state"     ? state     : null;

  // ── Cache check ───────────────────────────────────────────────────────────
  const cacheKey = growthCacheKey(fy, scope, stateHead, state, monthFrom, monthTo, dormantRevival, atRiskRecovery, rangeUptake);
  if (!forceFresh) {
    const hit = growthCache.get(cacheKey);
    if (hit && (hit.until === null || Date.now() < hit.until)) {
      res.json({ ...hit.payload, cachedAt: hit.payload.generatedAt });
      return;
    }
  }

  try {
    // ── Load data in parallel ─────────────────────────────────────────────────
    const [
      customerStateRows,
      lostCodeRows,
      narrowerRows,
      medianRow,
      shrinkerRows,
      projectGapRows,
      blockedResult,
    ] = await Promise.all([
      queryCustomerStates(fy, labels, priorLabels, headFilter, stateFilter),
      queryLostCodes(fy, labels, priorLabels, headFilter, stateFilter),
      queryNarrowers(fy, labels, priorLabels, headFilter, stateFilter),
      queryMedianActiveCustomer(fy, labels, headFilter, stateFilter),
      queryShrinkers(fy, labels, py, priorLabels, headFilter, stateFilter),
      queryProjectGaps(fy, labels),
      getBlockedCustomers().catch((): { blocked: Set<string>; available: boolean } => ({ blocked: new Set(), available: false })),
    ]);

    // Scheme nudges (uses head filter internally)
    const schemeResult: NudgeResult | null = await computeNudgeList(
      fy, quarter, blockedResult.blocked, blockedResult.available, 0.05,
      scope === "statehead" ? stateHead : undefined,
    ).catch((): NudgeResult | null => null);

    // State-head scoped distributor deep dive (statehead scope only — too expensive company-wide)
    let deepDive: DistributorDeepDiveResult | null = null;
    if (scope === "statehead" && stateHead) {
      deepDive = await loadDistributorDeepDive(fy, stateHead).catch(() => null);
    }

    // Company- and state-scope distributor data (SQL-only path — runs in parallel with other queries)
    let companyActivationRows: DistActivationRow[] = [];
    let companyRangeGapRows: DistRangeGapRow[] = [];
    // stateSecondaryHasData: independent availability signal — true when secondary_sku_line has
    // rows for this FY+state regardless of whether any opportunity query returns results.
    let stateSecondaryHasData = false;
    if (scope === "company" || scope === "state") {
      [companyActivationRows, companyRangeGapRows, stateSecondaryHasData] = await Promise.all([
        queryDistributorActivationCompany(fy, labels, stateFilter).catch((): DistActivationRow[] => []),
        queryDistributorRangeGapCompany(fy, stateFilter).catch((): DistRangeGapRow[] => []),
        scope === "state"
          ? querySecondarySkuLineExists(fy, stateFilter).catch((): boolean => false)
          : Promise.resolve(false),
      ]);
    }

    // Team rows (for capacity check)
    const rowsResult = await assembleRows({
      fy, states: [], regions: [], monthFrom, monthTo, lowPerfPct: 0,
      ...(scope === "statehead" && stateHead ? { stateHead } : {}),
    }).catch(() => null);

    // ── §7 CLOSE — scheme nudges ──────────────────────────────────────────────
    const allNudges = (schemeResult?.nudges ?? [] as NudgeRow[])
      .filter((n: NudgeRow) => n.status === "NUDGE" || n.status === "TRIP_ZONE")
      .sort((a: NudgeRow, b: NudgeRow) => (b.extraEarn ?? 0) - (a.extraEarn ?? 0));

    const blockedNudges = (schemeResult?.nudges ?? [] as NudgeRow[])
      .filter((n: NudgeRow) => blockedResult.blocked.has(n.customer));

    const nudgeAt8pctPlus = allNudges.filter(n => (n.extraRoi ?? 0) >= 0.08);
    const nudge5to8pct    = allNudges.filter(n => (n.extraRoi ?? 0) >= 0.05 && (n.extraRoi ?? 0) < 0.08);

    const closeEntities   = new Set(allNudges.map(n => n.customer.toUpperCase()));
    const totalCloseValue = allNudges.reduce((s, n) => s + (n.extraEarn ?? 0), 0);

    const close = {
      periodLabel,
      quarter,
      deadline:         schemeResult?.deadline ?? null,
      daysToDeadline:   schemeResult?.deadline
        ? Math.max(0, Math.ceil((new Date(schemeResult.deadline).getTime() - Date.now()) / 86_400_000))
        : null,
      nudges: allNudges.slice(0, 20).map(n => ({
        customer:    n.customer,
        extraEarn:   n.extraEarn != null ? t2(n.extraEarn) : null,
        extraRoi:    n.extraRoi  != null ? t2(n.extraRoi * 100) : null,
        gap:         t2(n.gap) ?? 0,
        billedSoFar: t2(n.billedSoFar),
        isBlocked:   blockedResult.blocked.has(n.customer),
      })),
      totalExtraEarnAt8pct:  nudgeAt8pctPlus.length > 0 ? t2(nudgeAt8pctPlus.reduce((s,n)=>s+(n.extraEarn??0),0)) : null,
      totalExtraEarnAt5to8:  nudge5to8pct.length    > 0 ? t2(nudge5to8pct.reduce((s,n)=>s+(n.extraEarn??0),0))    : null,
      blockedAccounts: blockedNudges.slice(0, 5).map(n => ({
        customer: n.customer,
        schemeValue: t2(n.extraEarn),
      })),
      blockedNote: blockedResult.available
        ? "Blocked accounts are excluded from the Extra Earn total and listed separately as a collections opportunity."
        : "Collections data not available — blocked account exclusion not applied.",
      notAvailable: allNudges.length === 0,
      notAvailableReason: "Scheme nudge data not available for this scope in the current quarter.",
    };

    // ── §5 RECOVER — at-risk customers ────────────────────────────────────────
    // At-risk: had prior-year purchases but current year is null or < 50% of prior
    const atRiskRows = customerStateRows.filter(r => {
      const cur   = parseFloat(r.cur_net ?? "0") || 0;
      const prior = parseFloat(r.prior_net ?? "0") || 0;
      return prior > 0 && (cur === 0 || cur < prior * 0.5);
    });

    // Split by silence duration (proxy: 0 cur = silent; partial = reducing)
    const silentAll  = atRiskRows.filter(r => !r.cur_net || parseFloat(r.cur_net) <= 0);
    const reducingAll = atRiskRows.filter(r => r.cur_net && parseFloat(r.cur_net) > 0);

    const totalRecoverPriorValue = atRiskRows.reduce((s, r) => s + (parseFloat(r.prior_net ?? "0") || 0), 0);
    const recoveryValueHigh = totalRecoverPriorValue * atRiskRecovery;
    const recoveryValueLow  = recoveryValueHigh / 2;

    // Segment the silent by probable silence duration (we use prior_net as proxy for priority)
    const silentBySize = silentAll.sort((a,b)=>(parseFloat(b.prior_net??"0")-(parseFloat(a.prior_net??"0")))).slice(0, 30);
    const lostCodes = lostCodeRows.map(r => ({
      segment: r.segment,
      codesLost: parseInt(r.codes_lost) || 0,
      priorNet: t2safe(r.prior_net),
    }));

    // Entities counted in RECOVER = at-risk customers NOT already in CLOSE
    const recoverEntities = atRiskRows
      .filter(r => !closeEntities.has(r.customer.toUpperCase()))
      .map(r => r.customer);
    const recoverEntitySet = new Set(recoverEntities.map(e => e.toUpperCase()));

    const recover = {
      periodLabel, priorPeriodLabel,
      basisBreakNote: "FY2024-25 vs FY2025-26 comparison: one customer (₹35.73 Cr) reclassified from unattributed to project in FY2025-26; if the scope includes that customer, YoY figures carry a structural basis break. The customer is excluded from territory figures by the project-channel filter.",
      atRiskCount:     atRiskRows.length,
      atRiskPriorValue: t2(totalRecoverPriorValue),
      afterDedupCount:  recoverEntities.length,
      dedupNote:        atRiskRows.length - recoverEntities.length > 0
        ? `${atRiskRows.length - recoverEntities.length} at-risk account(s) already counted in CLOSE (higher precedence).`
        : null,
      recoveryAssumption: atRiskRecovery,
      valueHigh: t2(recoveryValueHigh),
      valueLow:  t2(recoveryValueLow),
      silentCount:   silentAll.length,
      reducingCount: reducingAll.length,
      top30AtRisk: silentBySize.slice(0, 30).map(r => ({
        customer:     r.customer,
        priorNet:     t2safe(r.prior_net),
        curNet:       t2safe(r.cur_net),
        isSilent:     !r.cur_net || parseFloat(r.cur_net) <= 0,
        netChangePct: deltaPct(t2safe(r.cur_net), t2safe(r.prior_net)),
      })),
      lostCodes,
      notAvailable: atRiskRows.length === 0 && priorLabels.length === 0,
      notAvailableReason: "Prior-year comparison data not available for this period.",
    };

    // ── §3 ACTIVATE — dormant retailers ──────────────────────────────────────
    // Dormant: no current-year purchase, no prior-year purchase (never/new), OR
    //          purely at the distributor level: low activation < 40%
    const dormantRows = customerStateRows.filter(r => {
      const cur = parseFloat(r.cur_net ?? "0") || 0;
      return cur === 0;
    });

    const medianNet = parseFloat(medianRow.median_net) || 0;
    const activeCount = parseInt(medianRow.active_count) || 0;

    // Distributor-level activation
    // statehead scope: loaded from the Sheets-based deep dive
    // company scope:   loaded from secondary_sku_line via queryDistributorActivationCompany
    type ActivationDist = { name: string; retailerCount: number; activeCount: number; dormantCount: number; activationPct: number; dormantValueLow: number | null; dormantValueHigh: number | null };
    const lowActivationDists: ActivationDist[] = [];
    const quarterlyMedian = medianNet / Math.max(1, labels.length / 3);

    if (deepDive) {
      for (const d of deepDive.distributors as DistributorGroup[]) {
        if (!d.retailerCount || d.retailerCount === 0) continue;
        const actPct = (d.activeCount / d.retailerCount) * 100;
        if (actPct < 40) {
          const dormant = d.retailerCount - d.activeCount;
          // Size: dormant_count × median active retailer quarterly order × revival_assumption
          const valueHigh = dormant * quarterlyMedian * dormantRevival;
          lowActivationDists.push({
            name: d.name,
            retailerCount: d.retailerCount,
            activeCount: d.activeCount,
            dormantCount: dormant,
            activationPct: t2(actPct) ?? actPct,
            dormantValueLow:  t2(valueHigh / 2),
            dormantValueHigh: t2(valueHigh),
          });
        }
      }
      lowActivationDists.sort((a, b) => b.dormantCount - a.dormantCount);
    } else if ((scope === "company" || scope === "state") && companyActivationRows.length > 0) {
      for (const r of companyActivationRows) {
        const total  = parseInt(r.retailer_count) || 0;
        const active = parseInt(r.active_count)   || 0;
        if (total === 0) continue;
        const actPct = (active / total) * 100;
        if (actPct < 40) {
          const dormant  = total - active;
          const valueHigh = dormant * quarterlyMedian * dormantRevival;
          lowActivationDists.push({
            name: r.distributor,
            retailerCount: total,
            activeCount:   active,
            dormantCount:  dormant,
            activationPct: t2(actPct) ?? actPct,
            dormantValueLow:  t2(valueHigh / 2),
            dormantValueHigh: t2(valueHigh),
          });
        }
      }
      // already ordered by activation % ASC from SQL; stable sort keeps that
      lowActivationDists.sort((a, b) => b.dormantCount - a.dormantCount);
    }

    // Entities counted in ACTIVATE = dormant customers NOT in CLOSE or RECOVER
    const activateEntities = dormantRows
      .filter(r => !closeEntities.has(r.customer.toUpperCase()) && !recoverEntitySet.has(r.customer.toUpperCase()));
    const activateEntitySet = new Set(activateEntities.map(r => r.customer.toUpperCase()));

    const totalDormantValue = activateEntities.reduce((s, r) => s + (parseFloat(r.prior_net ?? "0") || 0), 0);
    // For pure dormant sizing: dormant_count × median × revival; range = half to full
    const activateValueHigh = activateEntities.length * medianNet * dormantRevival;
    const activateValueLow  = activateValueHigh / 2;

    const activate = {
      periodLabel,
      dormantRevivalAssumption: dormantRevival,
      medianActiveCustomerValue: t2(medianNet),
      medianSource: "median of active customers' primary sales in scope (proxy for quarterly order magnitude)",
      medianNote: "Median used — never mean. A single large customer distorts the mean significantly.",
      totalDormantCount: dormantRows.length,
      afterDedupCount: activateEntities.length,
      dedupNote: dormantRows.length - activateEntities.length > 0
        ? `${dormantRows.length - activateEntities.length} dormant account(s) already counted in CLOSE or RECOVER.`
        : null,
      valueHigh: t2(activateValueHigh),
      valueLow:  t2(activateValueLow),
      lowActivationDistributors: lowActivationDists.slice(0, 20),
      distributorNote: scope === "state" && !stateSecondaryHasData
        ? "Distributor activation data not available for this state in the secondary register for this FY."
        : scope === "state"
        ? "Source: secondary item-code register filtered to this state. Activation = active retailers in selected period ÷ all retailers seen this FY. Distributor names are as recorded in the secondary register."
        : scope === "company" && companyActivationRows.length === 0
        ? "Distributor activation data not available for this FY — secondary register not yet loaded for company scope."
        : scope === "company"
        ? "Source: secondary item-code register (FY to date). Activation = active retailers in selected period ÷ all retailers seen this FY. Distributor names are as recorded in the secondary register."
        : null,
      unassignedRetailers: deepDive ? {
        total: deepDive.noneAssigned?.retailerCount ?? null,
        assignmentGap: deepDive.whitespace?.totalAssignmentGapRetailers ?? null,
        coverageGap: deepDive.whitespace?.totalCoverageGapRetailers ?? null,
        assignmentNote: "Assignment gap: distributor exists but retailer not mapped (fix this week). Coverage gap: no distributor in district (strategic appointment).",
        topGapDistricts: (deepDive.whitespace?.districtStats ?? [])
          .filter((d: { noneCount: number }) => d.noneCount > 0)
          .sort((a: { noneCount: number }, b: { noneCount: number }) => b.noneCount - a.noneCount)
          .slice(0, 10)
          .map((d: { district: string; noneCount: number }) => ({ district: d.district, count: d.noneCount })),
      } : null,
      notAvailable: activateEntities.length === 0 && lowActivationDists.length === 0,
      notAvailableReason: "No dormant accounts identified in scope for this period.",
    };

    // ── §4 WIDEN — range gap ──────────────────────────────────────────────────
    type WidenDist = { name: string; distinctBrands: number | null; broadSegments: number | null; rangeGapNote: string; valueHigh: number | null; valueLow: number | null };
    const widenDists: WidenDist[] = [];

    if (deepDive) {
      // State-head scope: use Sheets-based deep dive (brand_canon from secondary_register_line)
      const allSpread = (deepDive.distributors as DistributorGroup[])
        .filter(d => d.skuSpread?.distinctBrands != null)
        .map(d => d.skuSpread!.distinctBrands!)
        .sort((a, b) => a - b);

      const peerMedianBrands = allSpread.length > 0
        ? allSpread[Math.floor(allSpread.length / 2)]
        : null;

      for (const d of (deepDive.distributors as DistributorGroup[]).slice(0, 20)) {
        const brands = d.skuSpread?.distinctBrands ?? null;
        const gap = brands != null && peerMedianBrands != null ? peerMedianBrands - brands : null;
        if (gap == null || gap <= 0) continue;
        // Size: gap_codes × peer_median_quarterly_per_code × uptake
        const perCodeQuarterly = peerMedianBrands && peerMedianBrands > 0
          ? (medianNet / Math.max(1, labels.length / 3)) / peerMedianBrands
          : 0;
        const valueHigh = gap * perCodeQuarterly * rangeUptake;
        widenDists.push({
          name: d.name,
          distinctBrands: brands,
          broadSegments: d.skuSpread?.broadSegmentsCovered ?? null,
          rangeGapNote: `peer median: ${peerMedianBrands} brands; gap: ${gap} brands`,
          valueHigh: t2(valueHigh),
          valueLow:  t2(valueHigh / 2),
        });
      }
    } else if ((scope === "company" || scope === "state") && companyRangeGapRows.length > 0) {
      // Company/state scope: use SQL-only path from secondary_sku_line (segment_canon as brand proxy)
      const peerMedian = parseFloat(companyRangeGapRows[0]?.peer_median ?? "0") || 0;
      const perCodeQuarterly = peerMedian > 0
        ? (medianNet / Math.max(1, labels.length / 3)) / peerMedian
        : 0;
      for (const r of companyRangeGapRows) {
        const brands  = parseInt(r.distinct_segments) || 0;
        const gap     = parseFloat(r.gap) || 0;
        if (gap <= 0) continue;
        const valueHigh = gap * perCodeQuarterly * rangeUptake;
        widenDists.push({
          name: r.distributor,
          distinctBrands: brands,
          broadSegments: null,
          rangeGapNote: `peer median: ${Math.round(peerMedian)} segments; gap: ${Math.round(gap)} segments`,
          valueHigh: t2(valueHigh),
          valueLow:  t2(valueHigh / 2),
        });
      }
    }

    // Segment rollup for WIDEN (codes_lost already shows segment gap)
    const segmentRollup = lostCodeRows.slice(0, 10).map(r => ({
      segment: r.segment,
      codesLost: parseInt(r.codes_lost) || 0,
      priorNet: t2safe(r.prior_net),
    }));

    const totalWidenValueHigh = widenDists.reduce((s, d) => s + (d.valueHigh ?? 0), 0);

    const widenDataSource = scope === "statehead"
      ? "brand_canon from secondary register (Sheets-based deep dive)"
      : scope === "state"
      ? "segment_canon from secondary item-code register filtered to this state (SQL-only path)"
      : "segment_canon from secondary item-code register (SQL-only path)";

    const widen = {
      rangeUptakeAssumption: rangeUptake,
      peerNote: "Value uses primary sales peer median ÷ segment count as per-segment proxy. Peer median computed from all distributors in secondary register for this FY.",
      excludesProjectNote: "Territory figures only — project/non-territory channel excluded.",
      dataSourceNote: widenDists.length > 0 ? widenDataSource : null,
      top20Distributors: widenDists.slice(0, 20),
      valueHigh: t2(totalWidenValueHigh),
      valueLow:  t2(totalWidenValueHigh / 2),
      segmentRollup,
      notAvailable: widenDists.length === 0,
      notAvailableReason: widenDists.length > 0 ? null :
        scope === "state" && !stateSecondaryHasData
          ? "Secondary register data not available for this state in this FY — range gap cannot be computed."
          : scope === "state"
          ? "All distributors in this state meet or exceed the peer segment range — no range gap identified."
          : scope === "company"
          ? "Secondary register data not available for this FY — range gap cannot be computed company-wide."
          : "SKU spread data not available for this state head.",
    };

    // ── §6 PROTECT — value at risk (NOT added to total) ──────────────────────
    const hiddenShrinkers = shrinkerRows.map(r => ({
      name:         r.customer,
      net:          t2safe(r.net),
      priorNet:     t2safe(r.prior_net),
      netGrowthPct: deltaPct(t2safe(r.net), t2safe(r.prior_net)),
      qtyGrowthPct: deltaPct(t2safe(r.qty), t2safe(r.prior_qty)),
    }));

    const narrowers = narrowerRows.map(r => ({
      customer:   r.customer,
      curCodes:   parseInt(r.cur_codes) || 0,
      priorCodes: parseInt(r.prior_codes) || 0,
      codeDrop:   parseInt(r.code_drop) || 0,
      priorNet:   t2safe(r.prior_net),
    }));

    const silentDists = deepDive
      ? (deepDive.distributors as DistributorGroup[])
          .filter(d => d.flows?.daysSinceLastOrder != null && d.flows.daysSinceLastOrder > 42)
          .map(d => ({ name: d.name, daysSilent: d.flows!.daysSinceLastOrder!, lastOrderDate: d.flows?.lastInvoiceDate ?? null }))
          .sort((a, b) => b.daysSilent - a.daysSilent)
      : [];

    const concentrationFlags = deepDive
      ? (deepDive.distributors as DistributorGroup[])
          .filter(d => d.isConcentrationRisk && d.obSharePct != null)
          .map(d => ({ name: d.name, sharePct: t2(d.obSharePct) ?? d.obSharePct! }))
      : [];

    const protect = {
      protectNote: "PROTECT is value at risk, not upside. These figures are NEVER added to the opportunity total.",
      hiddenShrinkers,
      narrowers,
      silentDistributors: silentDists,
      concentrationFlags,
      distributorDataNote: scope !== "statehead"
        ? "Silent distributor and concentration data requires state-head scope."
        : null,
    };

    // ── §8 WHERE NOT TO LOOK ──────────────────────────────────────────────────
    const projectGaps = projectGapRows.map(r => ({
      customer:    r.customer,
      projectNet:  t2safe(r.project_net),
      projectPct:  t2safe(r.project_pct),
    }));

    // Concentrated gaps: count distinct customers per customer state row — look for
    // segments/heads where most value is in < 6 customers
    const concentratedGaps: { description: string; topCustomerCount: number; totalValue: number | null }[] = [];
    {
      const byHead = new Map<string, { customers: Set<string>; net: number }>();
      for (const r of customerStateRows) {
        const h = r.head_canon ?? "Unknown";
        if (!byHead.has(h)) byHead.set(h, { customers: new Set(), net: 0 });
        byHead.get(h)!.customers.add(r.customer);
        byHead.get(h)!.net += parseFloat(r.cur_net ?? "0") || 0;
      }
      for (const [head, v] of byHead) {
        if (v.customers.size > 0 && v.customers.size < 6 && v.net > 0) {
          concentratedGaps.push({ description: `${head}`, topCustomerCount: v.customers.size, totalValue: t2(v.net) });
        }
      }
    }

    const whereNotToLook = {
      projectGaps: projectGaps.slice(0, 5),
      projectGapNote: projectGaps.length === 0
        ? "No project-contaminated gaps identified in this scope."
        : `${projectGaps.length} customer(s) where >50% of value comes from project channel — excluded from opportunity figures.`,
      concentratedGaps: concentratedGaps.slice(0, 5),
      mandatoryNote: "This section is mandatory and was not suppressed. Remaining opportunity figures exclude these items.",
    };

    // ── §9 CAPACITY CHECK ─────────────────────────────────────────────────────
    const teamRows = rowsResult?.rows ?? [];
    const totalWorkingDaysActual = teamRows.reduce((s, r) => {
      const kd = (r as Record<string, unknown>).kpis as Record<string, unknown> | undefined;
      const wda = kd?.workingDaysActual;
      return s + (typeof wda === "number" ? wda : 0);
    }, 0);

    // Ledger rows that imply visits = RECOVER + ACTIVATE entries (each is a retailer/customer to visit)
    const ledgerVisitImplied = recoverEntities.length + activateEntities.length;
    const visitRate = totalWorkingDaysActual > 0 ? totalWorkingDaysActual / Math.max(1, labels.length / 3) : 0;
    const remainingDays = Math.max(0, Math.round(250 - totalWorkingDaysActual)); // rough FY capacity

    const capacityCheck = {
      teamMemberCount: teamRows.length,
      workingDaysActual: totalWorkingDaysActual > 0 ? t2(totalWorkingDaysActual) : null,
      workingDaysNote: "Actual working days from primary sales register (AG column in member sheets).",
      visitImpliedByLedger: ledgerVisitImplied,
      currentVisitRate: visitRate > 0 ? t2(visitRate) : null,
      capacityShortfall: visitRate > 0 && ledgerVisitImplied > remainingDays
        ? t2(ledgerVisitImplied - remainingDays)
        : null,
      capacityNote: visitRate === 0
        ? "Visit data not available for this scope."
        : ledgerVisitImplied > remainingDays
        ? "The ledger exceeds team visit capacity. The plan as sized cannot be executed in the remaining working days — prioritise by value descending."
        : "The ledger is within estimated team visit capacity for the remaining period.",
    };

    // ── §10 ASSUMPTIONS AND LIMITS ────────────────────────────────────────────
    const unavailableItems: { item: string; reason: string }[] = [
      { item: "Margin and cost-derived figures", reason: "No cost master exists in the system." },
      { item: "Credit risk per customer", reason: "Collections data is available only as a binary blocked/unblocked flag." },
      { item: "Stock levels", reason: "Inventory data is not ingested into this system." },
    ];
    if (scope === "state") {
      if (!stateSecondaryHasData) {
        unavailableItems.push({ item: "Distributor activation (state)", reason: "Secondary register not yet loaded for this state in this FY — activation data unavailable." });
        unavailableItems.push({ item: "Distributor range gap (state)", reason: "Secondary register not yet loaded for this state in this FY — range gap data unavailable." });
      }
      unavailableItems.push({ item: "Silent distributor and concentration flags", reason: "Requires state-head scope." });
    } else if (scope === "company") {
      if (companyActivationRows.length === 0) {
        unavailableItems.push({ item: "Distributor activation (company)", reason: "Secondary register not yet loaded for this FY — activation data unavailable." });
      }
      if (companyRangeGapRows.length === 0) {
        unavailableItems.push({ item: "Distributor range gap (company)", reason: "Secondary register not yet loaded for this FY — range gap data unavailable." });
      }
      unavailableItems.push({ item: "Silent distributor and concentration flags", reason: "Requires state-head scope — run per state head for distributor recency and concentration." });
    } else if (scope !== "statehead") {
      // defensive fallback for any future scope value
      unavailableItems.push({ item: "Distributor activation and SKU range by distributor", reason: "Requires state-head or company scope." });
      unavailableItems.push({ item: "Silent distributor and concentration flags", reason: "Requires state-head scope." });
    }
    if (!deepDive) {
      unavailableItems.push({ item: "Unassigned retailer geography", reason: "Distributor deep dive could not be loaded for this scope." });
    }
    if (priorLabels.length === 0) {
      unavailableItems.push({ item: "At-risk and lost-code analysis", reason: "Prior-year comparison not available — period may be too early in the fiscal year." });
    }

    const assumptionsAndLimits = {
      conversionAssumptions: [
        { label: "Dormant retailer revival", defaultValue: 0.25, currentValue: dormantRevival, drives: "ACTIVATE section value" },
        { label: "At-risk recovery", defaultValue: 0.35, currentValue: atRiskRecovery, drives: "RECOVER section value" },
        { label: "Range recommendation uptake", defaultValue: 0.40, currentValue: rangeUptake, drives: "WIDEN section value" },
      ],
      comparisonBasis: `Like-for-like months: ${periodLabel} vs ${priorPeriodLabel}. Primary sales register (sale_line). Project/non-territory channel excluded.`,
      basisBreakNote: "FY2024-25 vs FY2025-26 known basis break: one customer (~₹35.73 Cr) reclassified from unattributed to project channel between those two fiscal years. Any section comparing those years carries this disclosure. The customer is excluded from territory figures.",
      unavailableItems,
    };

    // ── Deduplication ─────────────────────────────────────────────────────────
    // CLOSE > RECOVER > ACTIVATE > WIDEN
    // WIDEN is distributor-level (different entity type) — not deduplicated against RECOVER/ACTIVATE
    const multiLeverExamples: Array<{ entity: string; claimedByLever: string; reason: string }> = [];

    // Customers appearing in both CLOSE and RECOVER/ACTIVATE
    for (const e of Array.from(closeEntities).slice(0, 5)) {
      if (recoverEntitySet.has(e) || activateEntitySet.has(e)) {
        const lever = recoverEntitySet.has(e) ? "RECOVER" : "ACTIVATE";
        multiLeverExamples.push({ entity: e, claimedByLever: "CLOSE", reason: `Appeared in ${lever} but claimed by CLOSE (higher precedence). Only scheme nudge value counted.` });
      }
    }
    for (const e of Array.from(recoverEntitySet).slice(0, 3)) {
      if (activateEntitySet.has(e)) {
        multiLeverExamples.push({ entity: e, claimedByLever: "RECOVER", reason: "Appeared in ACTIVATE but claimed by RECOVER (higher precedence). Prior-year recovery value counted." });
      }
    }

    const preDedupValue = totalCloseValue + recoveryValueHigh + activateValueHigh + totalWidenValueHigh;
    const postDedupValue = totalCloseValue +
      recoverEntities.reduce((s, c) => {
        const r = atRiskRows.find(x => x.customer.toUpperCase() === c.toUpperCase());
        return s + (parseFloat(r?.prior_net ?? "0") || 0) * atRiskRecovery;
      }, 0) +
      activateValueHigh +
      totalWidenValueHigh;

    const deduplication = {
      preDedupValue: t2(preDedupValue),
      postDedupValue: t2(postDedupValue),
      adjustmentValue: t2(preDedupValue - postDedupValue),
      multiLeverEntityCount: multiLeverExamples.length,
      examples: multiLeverExamples.slice(0, 5),
      precedenceRules: [
        "1. CLOSE (scheme arithmetic — no conversion assumption)",
        "2. RECOVER (specific prior purchase × recovery assumption)",
        "3. ACTIVATE (dormant — never a prior buyer in scope)",
        "4. WIDEN (distributor range gap — peer inference)",
      ],
      note: "A retailer or distributor may appear in more than one lever's narrative but is counted in only ONE lever's total.",
    };

    // ── §2 Opportunity Ledger ─────────────────────────────────────────────────
    const rawLedger: Omit<LedgerRow, "rank" | "whatToDo">[] = [];

    // CLOSE rows
    for (const n of allNudges) {
      rawLedger.push({
        lever: "CLOSE", entityType: "customer", entityName: n.customer,
        valueLow: n.extraEarn != null ? t2(n.extraEarn) : null,
        valueHigh: n.extraEarn != null ? t2(n.extraEarn) : null,
        effort: "Low", confidence: "High",
        basisNote: "Arithmetic — extra earn to reach next scheme tier. No conversion assumption.",
      });
    }

    // RECOVER rows (deduplicated against CLOSE)
    for (const r of atRiskRows.filter(r => !closeEntities.has(r.customer.toUpperCase())).slice(0, 30)) {
      const priorNet = parseFloat(r.prior_net ?? "0") || 0;
      rawLedger.push({
        lever: "RECOVER", entityType: "customer", entityName: r.customer,
        valueLow: t2(priorNet * atRiskRecovery / 2),
        valueHigh: t2(priorNet * atRiskRecovery),
        effort: "Medium", confidence: "Medium",
        conversionAssumption: atRiskRecovery,
        basisNote: `Prior-year value × ${Math.round(atRiskRecovery * 100)}% recovery assumption.`,
      });
    }

    // ACTIVATE rows (dormant distributors, deduplicated)
    for (const d of lowActivationDists.slice(0, 15)) {
      rawLedger.push({
        lever: "ACTIVATE", entityType: "distributor", entityName: d.name,
        valueLow: d.dormantValueLow,
        valueHigh: d.dormantValueHigh,
        effort: "Medium", confidence: "Low",
        conversionAssumption: dormantRevival,
        basisNote: `Dormant retailer count × median active retailer quarterly value × ${Math.round(dormantRevival * 100)}% revival assumption.`,
      });
    }

    // WIDEN rows
    for (const d of widenDists.slice(0, 15)) {
      rawLedger.push({
        lever: "WIDEN", entityType: "distributor", entityName: d.name,
        valueLow: d.valueLow,
        valueHigh: d.valueHigh,
        effort: "Medium", confidence: "Low",
        conversionAssumption: rangeUptake,
        basisNote: `Range gap codes × per-code peer median quarterly value × ${Math.round(rangeUptake * 100)}% uptake assumption.`,
      });
    }

    // Sort by valueHigh descending, cap at 40
    rawLedger.sort((a, b) => (b.valueHigh ?? 0) - (a.valueHigh ?? 0));
    const omittedRows = rawLedger.slice(40);
    const topRows = rawLedger.slice(0, 40);
    const omittedValue = omittedRows.reduce((s, r) => s + (r.valueHigh ?? 0), 0);

    // ── §1 Executive Summary ──────────────────────────────────────────────────
    // Levers ranked by post-dedup value
    const leverValues: Array<{ lever: string; value: number; entityCount: number }> = [
      { lever: "CLOSE",    value: totalCloseValue,     entityCount: allNudges.length },
      { lever: "RECOVER",  value: postDedupValue - totalCloseValue - activateValueHigh - totalWidenValueHigh, entityCount: recoverEntities.length },
      { lever: "ACTIVATE", value: activateValueHigh,   entityCount: activateEntities.length },
      { lever: "WIDEN",    value: totalWidenValueHigh, entityCount: widenDists.length },
    ].sort((a, b) => b.value - a.value);

    const largestOpportunityRow = topRows[0] ?? null;
    const largestRisk = hiddenShrinkers[0] ?? null;

    const executiveSummary = {
      scopeLabel, periodLabel, priorPeriodLabel,
      totalOpportunityLow:  t2(postDedupValue / 2),
      totalOpportunityHigh: t2(postDedupValue),
      preDedupTotal:        t2(preDedupValue),
      postDedupTotal:       t2(postDedupValue),
      deduplicationNote:    `Levers sum to ₹${t2(preDedupValue / 10_000_000) ?? "?"} Cr before deduplication; ₹${t2(postDedupValue / 10_000_000) ?? "?"} Cr after. An entity counted in CLOSE is not double-counted in RECOVER or ACTIVATE.`,
      leverRanking: leverValues,
      largestOpportunity: largestOpportunityRow ? {
        lever:      largestOpportunityRow.lever,
        entityName: largestOpportunityRow.entityName,
        valueHigh:  largestOpportunityRow.valueHigh,
      } : null,
      largestRisk: largestRisk ? {
        customer:    largestRisk.name,
        netGrowthPct: largestRisk.netGrowthPct,
        qtyGrowthPct: largestRisk.qtyGrowthPct,
      } : null,
      conversionNote: `Opportunity range uses half-to-full conversion assumption. Dormant revival: ${Math.round(dormantRevival*100)}%, At-risk recovery: ${Math.round(atRiskRecovery*100)}%, Range uptake: ${Math.round(rangeUptake*100)}%.`,
      excludesProjectNote: "All opportunity figures exclude project/non-territory channel.",
    };

    // ── Claude narrative ──────────────────────────────────────────────────────
    const sectionSummaries = {
      close: { nudgeCount: allNudges.length, totalExtraEarnAt8pct: close.totalExtraEarnAt8pct, daysToDeadline: close.daysToDeadline, notAvailable: close.notAvailable },
      recover: { atRiskCount: recover.atRiskCount, afterDedupCount: recover.afterDedupCount, valueHigh: recover.valueHigh, lostCodeCount: lostCodes.length },
      activate: { dormantCount: activate.totalDormantCount, afterDedupCount: activate.afterDedupCount, lowActivationDistributors: activate.lowActivationDistributors.length, valueHigh: activate.valueHigh },
      widen: { distributorsWithGap: widenDists.length, valueHigh: widen.valueHigh, notAvailable: widen.notAvailable },
      protect: { shrinkerCount: hiddenShrinkers.length, narrowerCount: narrowers.length, silentDistCount: silentDists.length, concentrationCount: concentrationFlags.length },
      executiveSummary: { totalHigh: executiveSummary.totalOpportunityHigh, leverRanking: leverValues.map(l => l.lever) },
      whereNotToLook: { projectGapCount: projectGaps.length, concentratedGapCount: concentratedGaps.length },
      capacityCheck: { ledgerVisitImplied, shortfall: capacityCheck.capacityShortfall, note: capacityCheck.capacityNote },
      assumptionsAndLimits: { unavailableCount: unavailableItems.length },
    };

    const { sectionNarratives, ledgerWhatToDo } = await generateNarrative(
      scopeLabel, fy, periodLabel, sectionSummaries,
      topRows.slice(0, 20).map(r => ({ lever: r.lever, entityName: r.entityName, valueHigh: r.valueHigh })),
    );

    // Build final ledger with what-to-do
    const ledger: LedgerRow[] = topRows.map((row, i) => ({
      ...row,
      rank: i + 1,
      whatToDo: ledgerWhatToDo[i] ?? `Pursue ${row.lever.toLowerCase()} opportunity for this entity.`,
    }));

    // ── Numeric guard ─────────────────────────────────────────────────────────
    const allNarrative = Object.values(sectionNarratives).join(" ");
    const growthPayload = {
      fy, scope: scopeLabel,
      totalOpportunityHigh: executiveSummary.totalOpportunityHigh,
      postDedupTotal: executiveSummary.postDedupTotal,
      totalExtraEarnAt8pct: close.totalExtraEarnAt8pct,
      atRiskPriorValue: recover.atRiskPriorValue,
      recoverValueHigh: recover.valueHigh,
      activateValueHigh: activate.valueHigh,
      widenValueHigh: widen.valueHigh,
    };
    const guard: GuardResult = runNumericGuard(
      { content: { title: scopeLabel, body: allNarrative } } as Parameters<typeof runNumericGuard>[0],
      growthPayload as unknown as Parameters<typeof runNumericGuard>[1],
    );

    const generatedAt = new Date().toISOString();
    const responsePayload: Record<string, unknown> = {
      type:             "full-growth-report",
      fy,
      scope,
      scopeLabel,
      stateHead:        scope === "statehead" ? stateHead : undefined,
      state:            scope === "state"     ? state     : undefined,
      periodLabel,
      priorPeriodLabel,
      monthFrom,
      monthTo,
      dataCutoff:       generatedAt.slice(0, 10),
      generatedAt,
      assumptions: {
        dormantRevival,
        atRiskRecovery,
        rangeUptake,
      },
      executiveSummary,
      opportunityLedger: {
        rows:         ledger,
        totalRows:    rawLedger.length,
        omittedCount: omittedRows.length,
        omittedValue: t2(omittedValue),
      },
      activate,
      widen,
      recover,
      protect,
      close,
      whereNotToLook,
      capacityCheck,
      assumptionsAndLimits,
      deduplication,
      narrative: sectionNarratives,
      guard,
    };

    // ── Store in cache ────────────────────────────────────────────────────────
    // Closed FYs are frozen (registers never change) — store permanently.
    // Open FYs: store for 15 minutes (aligns with member-sheet cache TTL).
    const frozen = isFrozen(fy);
    const until = frozen ? null : Date.now() + GROWTH_CACHE_TTL_MS;
    growthCache.set(cacheKey, { payload: responsePayload, until });

    res.json({ ...responsePayload, cachedAt: undefined });
  } catch (err) {
    req.log.error({ err }, "full-report/growth failed");
    res.status(500).json({ error: "Could not generate growth report." });
  }
});

export default router;
