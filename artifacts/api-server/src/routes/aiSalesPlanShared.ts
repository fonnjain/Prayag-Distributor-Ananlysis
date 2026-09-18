/**
 * Prompt 105 Section B.  This route is deliberately a read-only, source
 * labelled surface.  It does not use the AI plan tables (which are a
 * different, writeable product).
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { getOpenResolutionHolds } from "../lib/resolution/holdResolver.js";
import registry from "../config/prompt68-category-registry.json";
import top80Snapshots from "../config/prompt105-top80-snapshots.json";
import { prompt105Top80IndiaMetrics, prompt105Top80StateMetrics, prompt105Top80StateUniverseSizes } from "../config/prompt105Top80Metrics.js";

const router = Router();
const MIN_PEERS = 5;
const FY = /^\d{4}-\d{2}$/;
const basisNames = new Set(["same-distributor", "same-state", "national"]);
const num = (v: unknown) => Number(v ?? 0) || 0;
const VALID_RET_ID = /^RET#\d+$/i;
const VALID_DIST_ID = /^DIST#\d+$/i;
export const isValidRetId = (value: unknown) => typeof value === "string" && VALID_RET_ID.test(value.trim());
export const isValidDistId = (value: unknown) => typeof value === "string" && VALID_DIST_ID.test(value.trim());
export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
export function targetAnchoredQuintile(targetValue: number, peerValues: number[]) {
  const all = [targetValue, ...peerValues].sort((a, b) => b - a);
  const rank = all.findIndex((v) => v === targetValue);
  const quintile = Math.min(4, Math.floor(rank * 5 / all.length));
  const peers = peerValues.filter((v) => Math.min(4, Math.floor(all.indexOf(v) * 5 / all.length)) === quintile);
  return { quintile, peerCount: peers.length, available: peers.length >= MIN_PEERS };
}
export function historyFlag(priorFull: number, currentLike: number, priorLike: number, eligible: boolean) {
  if (!eligible) return null;
  if (priorFull > 0 && currentLike === 0) return "STOPPED";
  if (priorLike > 0 && currentLike <= priorLike * .7) return "DOWN30";
  if (priorLike > 0 && currentLike >= priorLike * 1.3) return "UP30";
  return null;
}
export function lookupFrozenStateKey(state: string, keys: string[]) {
  return keys.find((key) => key.toLowerCase() === state.trim().toLowerCase()) ?? null;
}
export function completeLikeMonthNames(completeMonths: string[]) {
  return new Set(completeMonths.map((m) => m.replace(/[-\s]\d{2,4}$/, "").toLowerCase()));
}
const meta = (source: string, period: string, matched: number, total: number, filters: Record<string, unknown> = {}) => ({
  source, period, filters, coverage: { matched, total, pct: total ? matched / total * 100 : null },
});
const unavailable = (reason: string, source: string, period: string, filters: Record<string, unknown> = {}) => ({
  availability: "unavailable", value: null, reason, basis: meta(source, period, 0, 0, filters),
});

type Retailer = { id: string; distributor: string | null; cp_code?: string | null; state: string | null; value: number };

async function peerSet(retailer: string, fy: string, basis: string, state?: string) {
  const target = await pool.query<any>(
    `SELECT dealer_id id,
            ARRAY_AGG(DISTINCT cp_code) FILTER (WHERE cp_code ~ '^DIST#[0-9]+$') cp_codes,
            ARRAY_AGG(DISTINCT cp_name) FILTER (WHERE NULLIF(BTRIM(cp_name),'') IS NOT NULL) distributors,
            ARRAY_AGG(DISTINCT state) FILTER (WHERE NULLIF(BTRIM(state),'') IS NOT NULL) states,
            COALESCE(SUM(basic_order_value),0)::float value
       FROM secondary_order_line
      WHERE fiscal_year=$1 AND dealer_id=$2
      GROUP BY dealer_id`,
    [fy, retailer],
  );
  if (!target.rows[0]) return { error: "Requested RET# is not present in secondary_order_line." };
  const targetRow = target.rows[0];
  const t = {
    ...targetRow,
    value: Number(targetRow.value ?? 0),
    cpCodes: (targetRow.cp_codes ?? []).filter(isValidDistId),
    distributors: (targetRow.distributors ?? []).filter(Boolean),
    states: (targetRow.states ?? []).filter(Boolean),
    cp_code: targetRow.cp_codes?.find(isValidDistId) ?? null,
    distributor: targetRow.distributors?.[0] ?? null,
    state: targetRow.states?.[0] ?? null,
  };
  if (basis === "same-state" && !state && t.states.length !== 1) return { error: "Requested same-state cohort is ambiguous; provide canonical state." };
  const params: unknown[] = [fy, retailer];
  const match = basis === "same-distributor"
    ? (t.cpCodes.length ? "cp_code=ANY($3::text[])" : "cp_name=ANY($3::text[])")
    : basis === "same-state" ? "state=$3" : "TRUE";
  if (basis !== "national") {
    params.push(basis === "same-distributor" ? (t.cpCodes.length ? t.cpCodes : t.distributors) : (state ?? t.states[0]));
  }
  const rows = await pool.query<any>(
    `WITH matched_ids AS (
       SELECT DISTINCT dealer_id
         FROM secondary_order_line
        WHERE fiscal_year=$1 AND ${match}
     )
     SELECT sol.dealer_id id,
            ARRAY_AGG(DISTINCT sol.cp_code) FILTER (WHERE sol.cp_code ~ '^DIST#[0-9]+$') cp_codes,
            ARRAY_AGG(DISTINCT sol.cp_name) FILTER (WHERE NULLIF(BTRIM(sol.cp_name),'') IS NOT NULL) distributors,
            ARRAY_AGG(DISTINCT sol.state) FILTER (WHERE NULLIF(BTRIM(sol.state),'') IS NOT NULL) states,
            COALESCE(SUM(sol.basic_order_value),0)::float value
       FROM secondary_order_line sol
       JOIN matched_ids matched ON matched.dealer_id=sol.dealer_id
      WHERE sol.fiscal_year=$1
      GROUP BY sol.dealer_id
     HAVING sol.dealer_id<>$2`,
    params,
  );
  const raw = rows.rows.filter((r) => r.id).map((r) => ({ ...r, cp_code: r.cp_codes?.[0] ?? null, distributor: r.distributors?.[0] ?? null, state: r.states?.[0] ?? null }));
  // A broad cohort is made useful by retaining the target's annual-value
  // quintile. Ties are deterministic, and IDs are never name-merged.
  let refined = raw;
  let quintile: number | null = null;
  if (raw.length > 40) {
    const sorted = [t, ...raw].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    const anchored = targetAnchoredQuintile(t.value, raw.map((r) => r.value));
    quintile = anchored.quintile;
    refined = sorted.filter((r) => r.id !== retailer && Math.min(4, Math.floor(sorted.indexOf(r) * 5 / sorted.length)) === quintile);
  }
  return { target: t, raw, refined, quintile };
}

async function penetration(peers: Retailer[], fy: string, periods: string[]) {
  if (!peers.length) return [];
  const ids = peers.map((p) => p.id);
  const q = await pool.query(
    `WITH identity AS (
       SELECT DISTINCT fiscal_year, dealer_id
         FROM secondary_order_line
        WHERE fiscal_year=$1 AND dealer_id=ANY($2::text[])
     ), per_peer AS (
       SELECT identity.dealer_id, sku.item_code,
              SUM(sku.qty)::double precision qty, SUM(sku.net_amount)::double precision value
         FROM secondary_sku_line sku
         JOIN identity ON identity.fiscal_year=sku.fy
          AND identity.dealer_id=COALESCE(
            CASE WHEN BTRIM(sku.dealer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.dealer_id) END,
            CASE WHEN BTRIM(sku.retailer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer_id) END,
            CASE WHEN BTRIM(sku.retailer) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer) END
          )
        WHERE sku.fy=$1
          AND ($3::text[] IS NULL OR month_label=ANY($3::text[]))
         GROUP BY identity.dealer_id, sku.item_code
     )
     SELECT item_code code, COUNT(*)::int buyers,
            percentile_cont(.5) WITHIN GROUP (ORDER BY qty) median_qty,
            percentile_cont(.5) WITHIN GROUP (ORDER BY value) median_value
       FROM per_peer GROUP BY item_code ORDER BY item_code`,
    [fy, ids, periods.length ? periods : null],
  );
  return q.rows.map((r) => ({ code: r.code, buyingRetailers: Number(r.buyers), eligibleRetailers: peers.length,
    penetrationPct: peers.length ? Number(r.buyers) / peers.length * 100 : 0,
    medianQty: r.median_qty == null ? null : Number(r.median_qty),
    medianValue: r.median_value == null ? null : Number(r.median_value) }));
}

async function secondaryCoverage(fy: string) {
  const frozen = await pool.query<{ month_label: string; frozen: boolean }>(
    `SELECT month_label, BOOL_AND(frozen_at IS NOT NULL) frozen FROM secondary_sku_line WHERE fy=$1 GROUP BY month_label`, [fy]);
  const result = await pool.query<{ month_no: number; through: string | null; completeness: string | null }>(
    `SELECT EXTRACT(MONTH FROM (order_datetime AT TIME ZONE 'Asia/Kolkata'))::int AS month_no,
            MAX((order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text through,
            CASE WHEN BOOL_AND(LOWER(period_completeness)='complete') THEN 'complete'
                 WHEN COUNT(*) > 0 THEN 'partial' ELSE 'unavailable' END completeness
       FROM secondary_order_line WHERE fiscal_year=$1 GROUP BY 1 ORDER BY 1`, [fy],
  );
  const rows = result.rows;
  const loaded = rows.filter((r) => r.completeness !== "unavailable").map((r) => ({ month: Number(r.month_no), through: r.through, state: r.completeness }));
  // This is intentionally an observation of the order register, not a date
  // based guess. An absent month remains unavailable even if the calendar has
  // advanced beyond it.
  const months = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  const labels = months.map((m, i) => `${m}-${String((Number(fy.slice(0, 4)) + (i >= 9 ? 1 : 0)) % 100).padStart(2, "0")}`);
  const orderByLabel = new Map(loaded.map((r) => {
    const idx = Number(r.month) >= 4 ? Number(r.month) - 4 : Number(r.month) + 8;
    return [`${months[idx]}-${String((Number(fy.slice(0, 4)) + (idx >= 9 ? 1 : 0)) % 100).padStart(2, "0")}`, r];
  }));
  const skuByLabel = new Map(frozen.rows.map((r) => [r.month_label, r.frozen]));
  const completeMonths = labels.filter((label) => skuByLabel.get(label) === true && orderByLabel.get(label)?.state === "complete");
  const partialMonths = labels.filter((label) => skuByLabel.has(label) && !completeMonths.includes(label))
    .map((month) => ({ month, through: orderByLabel.get(month)?.through ?? null }));
  return { source: "secondary_sku_line frozen_at + secondary_order_line through-date", loaded, completeMonths,
    partialMonths,
    unavailableMonths: labels.filter((label) => !skuByLabel.has(label) && !loaded.some((r) => {
      const month = label.slice(0, 3);
      return Number(r.month) === months.indexOf(month) + 4 || (months.indexOf(month) >= 9 && Number(r.month) === months.indexOf(month) - 8);
    })) };
}

async function top80Demand(state: string | undefined) {
  if (!state) return unavailable("state is required for state-vs-India demand", "sale_line_current", "2026-27");
  const active = top80Snapshots.snapshots.find((s) => s.active && s.membership?.length);
  if (!active) return unavailable("no active exact snapshot", "prompt105-top80-snapshots.json", "unknown");
  const all = prompt105Top80StateMetrics as Record<string, Array<{code:string;amount:number;qty:number;rank:number}>>;
  const india = prompt105Top80IndiaMetrics;
  const metricState = lookupFrozenStateKey(state, Object.keys(all));
  if (!metricState) return unavailable(`unknown state '${state}'; no frozen metric vocabulary entry`, "prompt105Top80Metrics.ts", active.period?.through ?? "2026-09-17", { state });
  const stateRows = all[metricState] ?? [];
  const byState = new Map(stateRows.map((r) => [r.code, r]));
  const byIndia = new Map<string, { amount: number; qty: number; rank: number }>(india.map((r) => [r.code as string, r]));
  const membership: string[] = (active.membership ?? []) as string[];
  const rows = membership.map((code) => {
    const s = byState.get(code), i = byIndia.get(code);
    return { code, stateAmount: s?.amount ?? 0, stateQty: s?.qty ?? 0, indiaAmount: i?.amount ?? 0, indiaQty: i?.qty ?? 0, frozenStateRank: s?.rank ?? null, frozenIndiaRank: i?.rank ?? null };
  });
  const stateUniverseSize = prompt105Top80StateUniverseSizes[metricState] ?? Math.max(0, ...stateRows.map((r) => r.rank));
  const sr = new Map(rows.map((r) => [r.code, r.frozenStateRank ?? stateUniverseSize + 1]));
  const ir = new Map(rows.map((r) => [r.code, r.frozenIndiaRank]));
  return { availability: "value", value: {
    snapshotId: active.snapshotId, frozenAt: active.frozenAt, sourceDate: active.sourceDate, source: active.source,
    period: active.period, stateRequested: state, stateMetricKey: metricState, codeCount: active.codeCount, rankingUniverse: "all sale_line_current codes at frozen snapshot date", rows: rows.sort((a, b) => b.stateAmount - a.stateAmount || a.code.localeCompare(b.code)).map((r) => ({
      ...r, stateRank: sr.get(r.code), indiaRank: ir.get(r.code),
      divergence: (sr.get(r.code)! <= 80 && ir.get(r.code)! > 80) ? "strong-here-weak-nationally" :
        (ir.get(r.code)! <= 80 && sr.get(r.code)! > 80) ? "strong-nationally-weak-here" : null,
    })),
  }, basis: meta("frozen prompt105Top80Metrics.ts (production snapshot)", active.period?.through ?? "2026-09-17", rows.length, active.codeCount) };
}

async function customerComparison(retailer: string, completeMonths: string[]) {
  const q = await pool.query(
    `WITH identity AS (
       SELECT DISTINCT fiscal_year, dealer_id
         FROM secondary_order_line
        WHERE dealer_id=$1 AND fiscal_year IN ('2025-26','2026-27')
     )
     SELECT sku.item_code code, sku.fy, sku.month_label,
            SUM(sku.qty)::float qty, SUM(sku.net_amount)::float value
       FROM secondary_sku_line sku
       JOIN identity ON identity.fiscal_year=sku.fy
        AND identity.dealer_id=COALESCE(
          CASE WHEN BTRIM(sku.dealer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.dealer_id) END,
          CASE WHEN BTRIM(sku.retailer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer_id) END,
          CASE WHEN BTRIM(sku.retailer) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer) END
        )
      GROUP BY sku.item_code, sku.fy, sku.month_label`, [retailer]);
  const by = new Map<string, Record<string, { qty: number; value: number; months: number }>>();
  const loadedCurrent = new Set<string>(completeMonths);
  for (const r of q.rows) {
    const x = by.get(r.code) ?? {};
    const old = x[r.fy] ?? { qty: 0, value: 0, months: 0 };
    x[r.fy] = { qty: old.qty + (Number(r.qty) || 0), value: old.value + (Number(r.value) || 0), months: old.months + 1 };
    if (r.fy === "2026-27") loadedCurrent.add(String(r.month_label));
    by.set(r.code, x);
  }
  const likeNames = completeLikeMonthNames([...loadedCurrent]);
  const detail = new Map<string, Map<string, { qty: number; value: number }>>();
  for (const r of q.rows) {
    const k = `${r.code}|${r.fy}`, m = String(r.month_label).replace(/[-\s]\d{2,4}$/, "").toLowerCase();
    const x = detail.get(k) ?? new Map(); const old = x.get(m) ?? { qty: 0, value: 0 };
    x.set(m, { qty: old.qty + Number(r.qty || 0), value: old.value + Number(r.value || 0) }); detail.set(k, x);
  }
  const priorSkuCount = by.size ? [...by.entries()].filter(([, x]) => !!x["2025-26"]).length : 0;
  const priorMonthCount = new Set(q.rows.filter((r) => r.fy === "2025-26").map((r) => r.month_label)).size;
  const eligible = priorSkuCount >= 10 && priorMonthCount >= 3;
  const items = [...by.entries()].map(([code, x]) => {
    const prior = x["2025-26"] ?? { qty: 0, value: 0, months: 0 }, current = x["2026-27"] ?? { qty: 0, value: 0, months: 0 };
    const pLike = [...(detail.get(`${code}|2025-26`) ?? [])].filter(([m]) => likeNames.has(m)).reduce((a, [,v]) => ({ qty: a.qty + v.qty, value: a.value + v.value }), { qty: 0, value: 0 });
    const cLike = [...(detail.get(`${code}|2026-27`) ?? [])].filter(([m]) => likeNames.has(m)).reduce((a, [,v]) => ({ qty: a.qty + v.qty, value: a.value + v.value }), { qty: 0, value: 0 });
    const limited = !eligible;
    return { code, fy2025_26: prior, fy2026_27: current, qtyChange: current.qty - prior.qty, valueChange: current.value - prior.value,
      likeMonths: { prior: pLike, current: cLike }, flagBasis: "same available fiscal month names; full-year values remain separate",
      flag: historyFlag(prior.qty, cLike.qty, pLike.qty, !limited) };
  });
  const population = await pool.query<{ eligible: string; limited: string }>(
    `WITH identity AS (
       SELECT DISTINCT dealer_id
         FROM secondary_order_line
        WHERE fiscal_year='2025-26'
     ), r AS (
       SELECT identity.dealer_id id,
              COUNT(DISTINCT sku.item_code)::int skus, COUNT(DISTINCT sku.month_label)::int months
         FROM secondary_sku_line sku
         JOIN identity ON identity.dealer_id=COALESCE(
           CASE WHEN BTRIM(sku.dealer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.dealer_id) END,
           CASE WHEN BTRIM(sku.retailer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer_id) END,
           CASE WHEN BTRIM(sku.retailer) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer) END
         )
        WHERE sku.fy='2025-26'
        GROUP BY identity.dealer_id
     ) SELECT COUNT(*) FILTER (WHERE skus >= 10 AND months >= 3)::int eligible,
              COUNT(*) FILTER (WHERE skus < 10 OR months < 3)::int limited FROM r`,
    [],
  );
  return { items, history: { retailerSkuCount: by.size, priorSkuCount, priorMonthCount, eligible, isLimited: !eligible, eligibleRetailers: Number(population.rows[0]?.eligible ?? 0), limitedHistoryRetailers: Number(population.rows[0]?.limited ?? 0), minimum: { skus: 10, months: 3 }, availabilityPeriods: [...loadedCurrent].sort() } };
}

const assignments = (registry as { version: number; assignments: Array<{ item_code: string; subcategory: string }> }).assignments;
const categories = [...new Set(assignments.map((a) => a.subcategory).filter(Boolean))].sort();

/** Lightweight Tab 1 selector data. The database does the filtering and
 * limiting: this endpoint never materialises the full retailer population. */
router.get("/ai-sales-plan/options", async (req, res): Promise<void> => {
  const fy = String(req.query.fy ?? "2026-27").trim();
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const member = typeof req.query.member === "string" ? req.query.member.trim() : "";
  const cap = 100;
  if (!FY.test(fy)) { res.status(400).json({ error: "fy must be YYYY-YY" }); return; }
  if (q.length > 120 || member.length > 120) { res.status(400).json({ error: "q and member must be at most 120 characters" }); return; }
  try {
    const params: unknown[] = [fy];
    const conditions = ["fiscal_year=$1", "dealer_id ~ '^RET#[0-9]+$'"];
    if (member) { params.push(member); conditions.push(`sales_user_name=$${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(dealer_id ILIKE $${params.length}
        OR COALESCE(customer_name,'') ILIKE $${params.length})`);
    }
    params.push(cap + 1);
    const retailers = await pool.query(
      `SELECT dealer_id id,
              MAX(customer_name) display, MAX(sales_user_name) member,
              MAX(state) state,
              MAX(cp_code) FILTER (WHERE cp_code ~ '^DIST#[0-9]+$') dist_id,
              MAX(cp_name) distributor,
              COUNT(*) OVER()::int total_count
         FROM secondary_order_line WHERE ${conditions.join(" AND ")}
        GROUP BY 1 ORDER BY 2 NULLS LAST, 1 LIMIT $${params.length}`, params);
    const rows = retailers.rows.slice(0, cap).map((r) => ({
      id: r.id, retailer: r.display ?? r.id, member: r.member ?? null,
      state: r.state ?? null, distributor: r.dist_id ?? r.distributor ?? null,
      distributorId: r.dist_id ?? null,
    }));

    // The order source supplies the recorded sales-user name beside RET#.
    // Filtering stays exact and never merges similar names.
    const memberParams: unknown[] = [fy];
    const memberWhere = ["fiscal_year=$1", "NULLIF(BTRIM(sales_user_name),'') IS NOT NULL"];
    if (q) { memberParams.push(`%${q}%`); memberWhere.push(`sales_user_name ILIKE $${memberParams.length}`); }
    if (member) { memberParams.push(member); memberWhere.push(`sales_user_name=$${memberParams.length}`); }
    memberParams.push(cap + 1);
    const members = await pool.query(
      `SELECT sales_user_name id,
              sales_user_name display, COUNT(DISTINCT dealer_id)::int retailer_count,
              COUNT(*) OVER()::int total_count
         FROM secondary_order_line WHERE ${memberWhere.join(" AND ")}
        GROUP BY 1 ORDER BY 2 NULLS LAST, 1 LIMIT $${memberParams.length}`, memberParams);
    const memberRows = members.rows.slice(0, cap).map((r) => ({ id: r.id, member: r.display ?? r.id, retailerCount: Number(r.retailer_count) }));
    const totalRetailers = Number(retailers.rows[0]?.total_count ?? rows.length);
    const totalMembers = Number(members.rows[0]?.total_count ?? memberRows.length);
    const coverage = { source: "secondary_order_line (dealer_id RET#; valid cp_code DIST# with cp_name fallback; sales_user_name; state)", period: fy,
      requested: { q: q || null, member: member || null }, cap, retailer: { returned: rows.length, truncated: retailers.rows.length > cap },
      member: { returned: memberRows.length, truncated: members.rows.length > cap },
      totals: { retailers: totalRetailers, members: totalMembers } };
    res.json({ fy, q: q || null, member: member || null, members: memberRows, retailers: rows, source: coverage.source, coverage, counts: { members: totalMembers, retailers: totalRetailers } });
  } catch (err) {
    req.log.error({ err, fy }, "sales-plan options failed");
    res.status(500).json({ error: "Could not load sales-plan selector options." });
  }
});

router.get("/ai-sales-plan/shared-compute", async (req, res): Promise<void> => {
  const retailer = String(req.query.retailer ?? "").trim();
  const fy = String(req.query.fy ?? "2026-27").trim();
  const basis = String(req.query.peerBasis ?? "same-distributor").trim();
  const state = typeof req.query.state === "string" ? req.query.state.trim() : undefined;
  const requested = String(req.query.computations ?? "peerSet,penetration,adjacency,top80,customerSku").split(",").map((s) => s.trim()).filter(Boolean);
  const topOnly = requested.length > 0 && requested.every((r) => ["top80", "demand"].includes(r.toLowerCase()));
  if (!FY.test(fy) || !basisNames.has(basis)) { res.status(400).json({ error: "fy or peerBasis is invalid" }); return; }
  if (topOnly && !retailer) {
    if (!state) { res.status(400).json({ error: "state is required when top80/demand is requested without a retailer" }); return; }
    try {
      const [top80, holds] = await Promise.all([top80Demand(state), getOpenResolutionHolds()]);
      res.json({
        retailer: null, fy, requestedComputations: requested, source: "read-only frozen top80 shared computation",
        period: "2026-27 through 2026-09-17", coverage: { state: state, rankingUniverse: "active snapshot membership (564 codes)", computation: "frozen prompt105Top80Metrics.ts; no database query" },
        holds: holds.map((h) => ({ id: h.id, code: h.code, title: h.title, scope: h.scope, reason: h.reason })),
        computations: { top80 },
      });
    } catch (err) {
      req.log.error({ err }, "global top80 computation failed");
      res.status(500).json({ error: "Could not load frozen top80 demand." });
    }
    return;
  }
  if (!isValidRetId(retailer)) { res.status(400).json({ error: "a valid retailer RET# is required for retailer-dependent computations" }); return; }
  try {
    const peers = await peerSet(retailer, fy, basis, state);
    if ("error" in peers) { res.status(404).json({ error: peers.error }); return; }
    const selected = peers.refined;
    const peerBasis = {
      availability: selected.length >= MIN_PEERS ? "value" : "unavailable",
      value: selected.length >= MIN_PEERS ? selected.map((p) => p.id) : null,
      reason: selected.length < MIN_PEERS ? `Peer cohort has ${selected.length}; minimum is ${MIN_PEERS}.` : undefined,
      rawSize: peers.raw.length, refinedSize: selected.length, basis, excludedSelf: retailer,
      refinement: peers.raw.length > 40 ? "annual-value-quintile" : "none",
      quintile: peers.quintile,
      basisMetadata: meta("secondary_order_line dealer_id + valid cp_code/cp_name identity; basic_order_value quintile", fy, peers.raw.length, peers.raw.length, { basis }),
    };
    const periods = typeof req.query.periods === "string" ? req.query.periods.split(",").map((x) => x.trim()).filter(Boolean) : [];
    const need = (name: string) => requested.some((r) => r.toLowerCase() === name.toLowerCase());
    const [penetrationRows, holds, orderCoverage] = await Promise.all([
      need("penetration") && selected.length >= MIN_PEERS ? penetration(selected, fy, periods) : Promise.resolve([]),
      getOpenResolutionHolds(), secondaryCoverage(fy),
    ]);
    const customer = need("customerSku") ? await customerComparison(retailer, orderCoverage.completeMonths) : null;
    const customerCodes = need("adjacency") ? await pool.query<{ item_code: string }>(
      `WITH identity AS (
         SELECT DISTINCT fiscal_year, dealer_id
           FROM secondary_order_line WHERE fiscal_year=$1 AND dealer_id=$2
       )
       SELECT DISTINCT sku.item_code
         FROM secondary_sku_line sku
         JOIN identity ON identity.fiscal_year=sku.fy
          AND identity.dealer_id=COALESCE(
            CASE WHEN BTRIM(sku.dealer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.dealer_id) END,
            CASE WHEN BTRIM(sku.retailer_id) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer_id) END,
            CASE WHEN BTRIM(sku.retailer) ~ '^RET#[0-9]+$' THEN BTRIM(sku.retailer) END
          )`, [fy, retailer]) : { rows: [] };
    const codeSet = new Set(customerCodes.rows.map((r) => r.item_code));
    const touched = categories.filter((c) => assignments.some((a) => a.subcategory === c && codeSet.has(a.item_code)));
    const computations = {
      peerSet: peerBasis,
      penetration: selected.length < MIN_PEERS ? unavailable("minimum peer size not met", "secondary_sku_line", fy, { basis }) : {
        availability: "value", value: penetrationRows, basis: meta("secondary_sku_line.qty + net_amount joined to secondary_order_line.dealer_id", periods.join(",") || fy, selected.length, selected.length, { peerBasis: basis }),
      },
      adjacency: need("adjacency") ? { availability: "value", value: { touched, absent: categories.filter((c) => !touched.includes(c)), registryVersion: registry.version, registryCoverage: `${assignments.length} assignments / ${categories.length} categories`, unmappedCodes: [...codeSet].filter((c) => !assignments.some((a) => a.item_code === c)), categoryLevelOnly: true, pipeFittingsSplit: "unavailable — registry has no code-level split" }, basis: meta("config/prompt68-category-registry.json", fy, codeSet.size, codeSet.size) } : unavailable("not requested", "config/prompt68-category-registry.json", fy),
      top80: need("top80") || need("demand") ? await top80Demand(state) : unavailable("not requested", "frozen metrics", fy),
      customerSku: customer ? { availability: "value", value: customer.items, history: customer.history, basis: meta("secondary_sku_line.qty + net_amount joined to secondary_order_line.dealer_id", "FY2025-26 full year vs FY2026-27 loaded SKU months", 1, 1) } : unavailable("not requested", "secondary_sku_line", fy),
    };
    const aliases: Record<string, string> = { peer: "peerSet", peers: "peerSet", penetration: "penetration", "customer-sku": "customerSku", adjacency: "adjacency", category: "adjacency", top80: "top80", demand: "top80" };
    const selectedComputations = Object.fromEntries(Object.entries(computations).filter(([key]) => requested.some((r) => (aliases[r.toLowerCase()] ?? r) === key)));
    res.json({ retailer, fy, requestedComputations: requested, source: "read-only split-source computations", period: fy, coverage: {
      identity: {
        source: "secondary_order_line",
        fields: { retailer: "dealer_id", distributor: "valid cp_code, otherwise cp_name", member: "sales_user_name", state: "state" },
        period: fy === "2026-27" ? "April-August 2026" : fy,
        valueBasis: "basic_order_value",
      },
      skuHistory: {
        source: "secondary_sku_line",
        fields: { item: "item_code", quantity: "qty", value: "net_amount" },
        period: "FY2025-26 full year and FY2026-27 loaded SKU months",
        identityJoin: "validated RET# matched to secondary_order_line.dealer_id",
      },
      secondaryOrderCoverage: orderCoverage,
      periodStates: fy === "2025-26"
        ? { fiscalYear: "FY25-26", complete: true, completeMonths: orderCoverage.completeMonths, partialMonths: [], unavailableMonths: [] }
        : { fiscalYear: "FY26-27", complete: false, completeMonths: orderCoverage.completeMonths, partialMonths: orderCoverage.partialMonths, unavailableMonths: orderCoverage.unavailableMonths },
    }, holds: holds.map((h) => ({ id: h.id, code: h.code, title: h.title, scope: h.scope, reason: h.reason })), computations: selectedComputations });
  } catch (err) {
    req.log.error({ err }, "shared sales-plan computation failed");
    res.status(500).json({ error: "Could not compute shared sales-plan data." });
  }
});

export default router;