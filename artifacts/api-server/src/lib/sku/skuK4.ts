/**
 * SKU Deep Dive — Phase K4: discounts, seasonality, breadth trend,
 * first-order codes, lost codes, and explicit blocked-capability flags.
 *
 * ── Discount: TWO measures, never conflated ──
 *   PRIMARY  — discount off MRP = (mrp × qty − amount) / (mrp × qty), from
 *              sale_line joined to item_master (rate-list MRP). All four FYs.
 *   SECONDARY — the registers' explicit Discount column beside Sub Total,
 *              from secondary_sku_line. Closed years only. Retailer-level.
 *   The API returns them under separate keys (`primary` / `secondary`) each
 *   carrying its own `measureLabel`; the UI must never merge the columns.
 *
 * ── Project exclusion ──
 *   FY2024-25 and FY2025-26 sale_line rows have NO head attribution (their
 *   register sheets carry no STATE HEAD column). Territory exclusion for
 *   those years uses the customer bridge: any customer ever attributed to
 *   'Non-territory / Project / Govt' in an FY that HAS head data (2023-24,
 *   2026-27) is treated as project in the unattributed years too. Responses
 *   carry `projectExclusion` metadata describing the basis.
 *
 * ── Seasonality basis ──
 *   Month distribution per segment is computed over ALL channels (project
 *   included) because demand timing is a market pattern and two of the three
 *   closed years cannot be split by channel. The response says so.
 *
 * ── Blocked, never approximated ──
 *   margin per code   — cost_master is empty; MRP discount is NOT margin.
 *   live-year retailer — no FY2026-27 secondary register exists.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "./catalogue.js";
import { SKU_SHEET_IDS, secondarySkuFyHasData, getSecondarySkuFyPeriodLabel } from "../secondary/skuLoader.js";
import { logger } from "../logger.js";
import { deriveSaleLineClosedFys, currentOpenFy } from "../fyAnchors.js";

// Closed-FY list is derived at runtime from sale_line_current ingest stats
// (all fully-ingested calendar-closed FYs, ascending), with a grace window
// after FY close and a loud failure if the newly closed FY is not ingested
// in time. Never hardcode it here.
const getClosedFys = deriveSaleLineClosedFys;
const FY_MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;
const QUARTER_OF_MONTH = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4] as const;
const QUARTER_LABEL: Record<number, string> = {
  1: "Q1 (Apr–Jun)",
  2: "Q2 (Jul–Sep)",
  3: "Q3 (Oct–Dec)",
  4: "Q4 (Jan–Mar)",
};

const TTL_MS = 60 * 60 * 1000;
const _cache = new Map<string, { ts: number; v: unknown }>();
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return Promise.resolve(hit.v as T);
  return fn().then((v) => {
    _cache.set(key, { ts: Date.now(), v });
    return v;
  });
}

/** Clear all K4 caches (call after a secondary backfill or register reload). */
export function clearK4Cache(): void {
  _cache.clear();
  _projCustomers = null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Project customer bridge ──────────────────────────────────────────────────

export type ProjectExclusionMeta = {
  basis: string;
  bridgedCustomers: number;
  note: string;
};

let _projCustomers: { ts: number; set: Set<string> } | null = null;

/** Customers ever attributed to the project channel in ANY FY with head data. */
export async function getProjectCustomerSet(): Promise<Set<string>> {
  if (_projCustomers && Date.now() - _projCustomers.ts < TTL_MS) {
    return _projCustomers.set;
  }
  const rows = await db.execute(sql`
    SELECT DISTINCT upper(trim(customer)) AS c
    FROM sale_line_current
    WHERE head_canon = ${PROJECT_HEAD_CANON} AND customer IS NOT NULL
  `);
  const set = new Set<string>((rows.rows as { c: string }[]).map((r) => r.c));
  _projCustomers = { ts: Date.now(), set };
  return set;
}

export function projectExclusionMeta(set: Set<string>): ProjectExclusionMeta {
  return {
    basis: "customer bridge",
    bridgedCustomers: set.size,
    note:
      "FY2024-25/FY2025-26 registers carry no state-head column, so rows cannot be " +
      "attributed directly. Customers ever seen in the project channel in an " +
      "attributed FY (2023-24, 2026-27) are excluded as project throughout.",
  };
}

/**
 * SQL fragment: exclude project rows. FY-conditional at ROW level:
 *   head attributed  → trust the head (bridge NOT applied; a bridged customer's
 *                      genuinely territory-attributed rows stay in),
 *   head absent      → customer bridge decides.
 */
export function territoryFilterSql(projSet: Set<string>) {
  const names = [...projSet];
  const bridgeNotIn =
    names.length === 0
      ? sql`TRUE`
      : sql`upper(trim(coalesce(customer,''))) NOT IN (${sql.join(
          names.map((n) => sql`${n}`),
          sql`, `,
        )})`;
  return sql`((head_canon IS NOT NULL AND head_canon != ${PROJECT_HEAD_CANON})
    OR (head_canon IS NULL AND ${bridgeNotIn}))`;
}

/** Complement of territoryFilterSql: project rows only. Empty-bridge safe. */
function projectFilterSql(projSet: Set<string>) {
  const names = [...projSet];
  const bridgeIn =
    names.length === 0
      ? sql`FALSE`
      : sql`upper(trim(coalesce(customer,''))) IN (${sql.join(
          names.map((n) => sql`${n}`),
          sql`, `,
        )})`;
  return sql`(head_canon = ${PROJECT_HEAD_CANON}
    OR (head_canon IS NULL AND ${bridgeIn}))`;
}

// ── 1. Effective discount by code ────────────────────────────────────────────

export type DiscountCodeRow = {
  code: string;
  segment: string;
  customers: number;
  net: number;
  /** Weighted average effective discount (0–1). */
  avgDiscount: number;
  minDiscount: number;
  maxDiscount: number;
  /** max − min across customers — THE finding. */
  spread: number;
  lowCustomer: string | null;
  highCustomer: string | null;
};

export type PrimaryDiscountResult = {
  measureLabel: string;
  fy: string;
  channel: "territory" | "project";
  codes: DiscountCodeRow[];
  widestGaps: DiscountCodeRow[];
  mrpCoverage: { rowsWithMrp: number; rowsTotal: number };
  projectExclusion: ProjectExclusionMeta;
};

export async function getPrimaryDiscountByCode(
  fy: string,
  channel: "territory" | "project",
  monthLabels: string[] | null,
): Promise<PrimaryDiscountResult> {
  const key = `pdisc:${fy}:${channel}:${monthLabels?.join(",") ?? "all"}`;
  return cached(key, async () => {
    const projSet = await getProjectCustomerSet();
    const chanFilter =
      channel === "project" ? projectFilterSql(projSet) : territoryFilterSql(projSet);
    const monthFilter =
      monthLabels && monthLabels.length > 0
        ? sql`AND month_label IN (${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)})`
        : sql``;

    // Per customer-per-code effective discount, then per-code stats.
    const rows = await db.execute(sql`
      WITH cust AS (
        SELECT sl.code,
               coalesce(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
               upper(trim(coalesce(sl.customer,'?'))) AS customer,
               sum(sl.amount::float8) AS net,
               sum(im.mrp::float8 * sl.qty::float8) AS mrp_value
        FROM sale_line_current sl
        JOIN item_master im ON im.code = sl.code AND im.mrp IS NOT NULL AND im.mrp::float8 > 0
        WHERE sl.fy = ${fy} AND sl.qty::float8 > 0 AND sl.amount::float8 > 0
          AND ${chanFilter} ${monthFilter}
        GROUP BY 1, 2, 3
        HAVING sum(im.mrp::float8 * sl.qty::float8) > 0
      ), cd AS (
        SELECT *, greatest(0, least(1, 1 - net / mrp_value)) AS disc FROM cust
      )
      SELECT code, max(segment) AS segment,
             count(*)::int AS customers,
             sum(net) AS net,
             sum(disc * net) / nullif(sum(net), 0) AS avg_disc,
             min(disc) AS min_disc, max(disc) AS max_disc,
             (array_agg(customer ORDER BY disc ASC))[1] AS low_customer,
             (array_agg(customer ORDER BY disc DESC))[1] AS high_customer
      FROM cd GROUP BY code
    `);

    const cov = await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE im.mrp IS NOT NULL AND im.mrp::float8 > 0)::int AS with_mrp
      FROM sale_line_current sl LEFT JOIN item_master im ON im.code = sl.code
      WHERE sl.fy = ${fy} AND ${chanFilter} ${monthFilter}
    `);
    const covRow = cov.rows[0] as { total: number; with_mrp: number };

    const codes: DiscountCodeRow[] = (rows.rows as Record<string, unknown>[])
      .map((r) => ({
        code: String(r.code),
        segment: String(r.segment),
        customers: num(r.customers),
        net: num(r.net),
        avgDiscount: num(r.avg_disc),
        minDiscount: num(r.min_disc),
        maxDiscount: num(r.max_disc),
        spread: num(r.max_disc) - num(r.min_disc),
        lowCustomer: r.low_customer ? String(r.low_customer) : null,
        highCustomer: r.high_customer ? String(r.high_customer) : null,
      }))
      .sort((a, b) => b.net - a.net);

    const widestGaps = codes
      .filter((c) => c.customers >= 3)
      .sort((a, b) => b.spread - a.spread)
      .slice(0, 25);

    return {
      measureLabel:
        "Discount off MRP (rate-list MRP; what the distributor pays against list price). NOT margin.",
      fy,
      channel,
      codes: codes.slice(0, 500),
      widestGaps,
      mrpCoverage: { rowsWithMrp: covRow.with_mrp, rowsTotal: covRow.total },
      projectExclusion: projectExclusionMeta(projSet),
    };
  });
}

export type SecondaryDiscountResult = {
  measureLabel: string;
  fy: string;
  available: boolean;
  reason?: string;
  codes: DiscountCodeRow[];
  widestGaps: DiscountCodeRow[];
  verification: {
    sampled: boolean;
    lineUid?: string;
    gross?: number;
    discountAmount?: number;
    net?: number;
    holds?: boolean;
    note: string;
  };
};

export async function getSecondaryDiscountByCode(
  fy: string,
): Promise<SecondaryDiscountResult> {
  const label =
    "Register Discount column (retailer-level, beside Sub Total). A DIFFERENT measure from the primary MRP discount.";
  // Gate on data presence, not on the sheet registry: FY2026-27 was loaded
  // from the PSCode_3 xlsx drop (no Google Sheet exists for it).
  if (!(fy in SKU_SHEET_IDS) && !(await secondarySkuFyHasData(fy))) {
    return {
      measureLabel: label,
      fy,
      available: false,
      reason: `No FY${fy} secondary SKU register is loaded — retailer-level discount is not computable until one is ingested.`,
      codes: [],
      widestGaps: [],
      verification: { sampled: false, note: "not available" },
    };
  }
  return cached(`sdisc:${fy}`, async () => {
    // Population reconciliation FIRST: the register Discount column is a
    // percentage; gross × (1 − disc%) must equal Sub Total. If less than 99%
    // of lines reconcile within ₹1, the secondary measure is withheld rather
    // than served on a broken basis.
    const recon = await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (
               WHERE abs(gross_amount::float8 * (1 - discount_pct::float8 / 100)
                         - net_amount::float8) < 1
             )::int AS holds
      FROM secondary_sku_line
      WHERE fy = ${fy} AND gross_amount IS NOT NULL AND net_amount IS NOT NULL
        AND discount_pct IS NOT NULL AND gross_amount::float8 > 0
    `);
    const rc = recon.rows[0] as { total: number; holds: number };
    if (rc.total === 0) {
      return {
        measureLabel: label,
        fy,
        available: false,
        reason: `secondary_sku_line has no rows for FY${fy} — run the secondary SKU backfill first.`,
        codes: [],
        widestGaps: [],
        verification: { sampled: false, note: "no data" },
      };
    }
    const holdPct = rc.holds / rc.total;
    if (holdPct < 0.99) {
      return {
        measureLabel: label,
        fy,
        available: false,
        reason: `Register discount failed reconciliation: only ${(holdPct * 100).toFixed(1)}% of ${rc.total} lines satisfy gross × (1 − disc%) = Sub Total. Withheld rather than served on a broken basis.`,
        codes: [],
        widestGaps: [],
        verification: { sampled: false, note: "population reconciliation failed" },
      };
    }

    // Aggregate the ACTUAL register Discount column (percentage), weighted by
    // gross: per customer disc = Σ(gross × disc%) / Σ gross.
    const rows = await db.execute(sql`
      WITH cust AS (
        SELECT item_code AS code,
               coalesce(segment_canon, segment_raw, 'Unmapped') AS segment,
               upper(trim(coalesce(retailer,'?'))) AS customer,
               sum(net_amount::float8) AS net,
               sum(gross_amount::float8) AS gross,
               sum(gross_amount::float8 * discount_pct::float8 / 100) AS disc_value
        FROM secondary_sku_line
        WHERE fy = ${fy} AND net_amount IS NOT NULL AND gross_amount IS NOT NULL
          AND discount_pct IS NOT NULL AND gross_amount::float8 > 0
        GROUP BY 1, 2, 3
      ), cd AS (
        SELECT *, greatest(0, least(1, disc_value / gross)) AS disc FROM cust
      )
      SELECT code, max(segment) AS segment, count(*)::int AS customers,
             sum(net) AS net,
             sum(disc * net) / nullif(sum(net), 0) AS avg_disc,
             min(disc) AS min_disc, max(disc) AS max_disc,
             (array_agg(customer ORDER BY disc ASC, customer ASC))[1] AS low_customer,
             (array_agg(customer ORDER BY disc DESC, customer ASC))[1] AS high_customer
      FROM cd GROUP BY code
    `);

    // Deterministic sampled order for the on-screen verification strip:
    // the largest discounted line (stable ordering).
    const sample = await db.execute(sql`
      SELECT line_uid, gross_amount::float8 AS gross, net_amount::float8 AS net,
             discount_pct::float8 AS disc
      FROM secondary_sku_line
      WHERE fy = ${fy} AND gross_amount IS NOT NULL AND net_amount IS NOT NULL
        AND discount_pct IS NOT NULL AND discount_pct::float8 > 0
      ORDER BY gross_amount::float8 DESC, line_uid ASC
      LIMIT 1
    `);
    let verification: SecondaryDiscountResult["verification"] = {
      sampled: false,
      note: `population check: ${rc.holds} of ${rc.total} lines reconcile (${(holdPct * 100).toFixed(2)}%)`,
    };
    if (sample.rows.length > 0) {
      const s = sample.rows[0] as { line_uid: string; gross: number; net: number; disc: number };
      const holds = Math.abs(s.gross * (1 - s.disc / 100) - s.net) < 1;
      verification = {
        sampled: true,
        lineUid: s.line_uid,
        gross: s.gross,
        discountAmount: s.gross * (s.disc / 100),
        net: s.net,
        holds,
        note: `Discount column is a percentage: gross − (gross × ${s.disc}%) = Sub Total ${holds ? "✓" : "✗"}. Population: ${(holdPct * 100).toFixed(2)}% of ${rc.total} lines reconcile within ₹1.`,
      };
    }

    const codes: DiscountCodeRow[] = (rows.rows as Record<string, unknown>[])
      .map((r) => ({
        code: String(r.code),
        segment: String(r.segment),
        customers: num(r.customers),
        net: num(r.net),
        avgDiscount: num(r.avg_disc),
        minDiscount: num(r.min_disc),
        maxDiscount: num(r.max_disc),
        spread: num(r.max_disc) - num(r.min_disc),
        lowCustomer: r.low_customer ? String(r.low_customer) : null,
        highCustomer: r.high_customer ? String(r.high_customer) : null,
      }))
      .sort((a, b) => b.net - a.net);

    return {
      measureLabel: label,
      fy,
      available: true,
      codes: codes.slice(0, 500),
      widestGaps: codes.filter((c) => c.customers >= 3).sort((a, b) => b.spread - a.spread).slice(0, 25),
      verification,
    };
  });
}

// ── 2. Seasonality per segment ───────────────────────────────────────────────

export type SegmentSeasonality = {
  segment: string;
  totalNet: number;
  /** Share of pooled 3-yr net per fiscal month, Apr..Mar (0–1 each, sums ≈ 1). */
  monthShare: number[];
  quarterShare: [number, number, number, number];
  peakQuarter: number;
  peakQuarterLabel: string;
  peakMonth: string;
  /** In how many of the 3 closed years the pooled peak quarter was also that year's peak. */
  yearsConsistent: number;
};

export type SeasonalityResult = {
  basis: string;
  fys: string[];
  segments: SegmentSeasonality[];
};

export async function getSeasonality(
  channel: "all" | "territory" = "all",
  head?: string,
): Promise<SeasonalityResult> {
  return cached(`seasonality:${channel}:${head ?? ""}`, async () => {
    const CLOSED_FYS = await getClosedFys();
    const chanFilter =
      channel === "territory" ? territoryFilterSql(await getProjectCustomerSet()) : sql`TRUE`;
    // Optional state-head scope: sale_line.head_canon carries the state head.
    const headFilter = head ? sql`AND head_canon = ${head}` : sql``;
    const rows = await db.execute(sql`
      SELECT coalesce(group_canon, group_raw, 'Unmapped') AS segment,
             fy, substring(month_label, 1, 3) AS m, sum(amount::float8) AS net
      FROM sale_line_current
      WHERE fy IN (${sql.join(CLOSED_FYS.map((f) => sql`${f}`), sql`, `)})
        AND month_label IS NOT NULL AND ${chanFilter} ${headFilter}
      GROUP BY 1, 2, 3
    `);

    type Agg = { pooled: number[]; byFy: Map<string, number[]>; total: number };
    const bySeg = new Map<string, Agg>();
    for (const r of rows.rows as { segment: string; fy: string; m: string; net: number }[]) {
      const mi = FY_MONTHS.indexOf(r.m as (typeof FY_MONTHS)[number]);
      if (mi < 0) continue;
      let a = bySeg.get(r.segment);
      if (!a) {
        a = { pooled: new Array(12).fill(0), byFy: new Map(), total: 0 };
        bySeg.set(r.segment, a);
      }
      a.pooled[mi] += num(r.net);
      a.total += num(r.net);
      let fyArr = a.byFy.get(r.fy);
      if (!fyArr) {
        fyArr = new Array(12).fill(0);
        a.byFy.set(r.fy, fyArr);
      }
      fyArr[mi] += num(r.net);
    }

    const quarterOf = (arr: number[]): [number, number, number, number] => {
      const q: [number, number, number, number] = [0, 0, 0, 0];
      arr.forEach((v, i) => (q[QUARTER_OF_MONTH[i] - 1] += v));
      return q;
    };

    const segments: SegmentSeasonality[] = [...bySeg.entries()]
      .filter(([, a]) => a.total > 0)
      .map(([segment, a]) => {
        const monthShare = a.pooled.map((v) => v / a.total);
        const qAbs = quarterOf(a.pooled);
        const quarterShare = qAbs.map((v) => v / a.total) as [number, number, number, number];
        const peakQuarter = qAbs.indexOf(Math.max(...qAbs)) + 1;
        const peakMonth = FY_MONTHS[a.pooled.indexOf(Math.max(...a.pooled))];
        let yearsConsistent = 0;
        for (const fyArr of a.byFy.values()) {
          const fq = quarterOf(fyArr);
          if (fq.indexOf(Math.max(...fq)) + 1 === peakQuarter) yearsConsistent++;
        }
        return {
          segment,
          totalNet: a.total,
          monthShare,
          quarterShare,
          peakQuarter,
          peakQuarterLabel: QUARTER_LABEL[peakQuarter],
          peakMonth,
          yearsConsistent,
        };
      })
      .sort((x, y) => y.totalNet - x.totalNet);

    return {
      basis: head
        ? `Scoped to ${head} — territory-only curves. sale_line carries head attribution ` +
          "only for FY2023-24 among closed years, so these curves are single-year " +
          "evidence; compare against the pooled company-wide pattern."
        : channel === "territory"
          ? "Territory only — project rows excluded (direct head where attributed; the " +
            "project-customer bridge for FY2024-25/25-26 rows, which carry no head)."
          : "All channels including project — demand timing is a market pattern, and " +
            "FY2024-25/FY2025-26 rows carry no direct head attribution (a per-channel " +
            "split there relies on the project-customer bridge).",
      fys: CLOSED_FYS,
      segments,
    };
  });
}

/** segment → peak quarter map, for push-card badges. */
export async function getPeakQuarterMap(): Promise<
  Map<string, { peakQuarter: number; peakQuarterLabel: string; quarterShare: number }>
> {
  const s = await getSeasonality();
  const m = new Map<string, { peakQuarter: number; peakQuarterLabel: string; quarterShare: number }>();
  for (const seg of s.segments) {
    m.set(seg.segment, {
      peakQuarter: seg.peakQuarter,
      peakQuarterLabel: seg.peakQuarterLabel,
      quarterShare: seg.quarterShare[seg.peakQuarter - 1],
    });
  }
  return m;
}

// ── Push-list discount flag ──────────────────────────────────────────────────

export type DiscountNormFlag = {
  code: string;
  currentAvgDiscount: number;
  normAvgDiscount: number;
  aboveNormPts: number;
};

/**
 * For a set of codes: current-FY avg MRP discount vs the code's own 3-closed-yr
 * norm. Flags codes whose current discount runs ≥5 pts above their own norm —
 * "a margin question before it is a volume opportunity".
 */
export async function getDiscountNormFlags(
  fy: string,
  codes: string[],
  monthLabels?: string[] | null,
): Promise<Map<string, DiscountNormFlag>> {
  const out = new Map<string, DiscountNormFlag>();
  if (codes.length === 0) return out;
  const CLOSED_FYS = await getClosedFys();
  const projSet = await getProjectCustomerSet();
  const terr = territoryFilterSql(projSet);
  const codeList = sql.join(codes.map((c) => sql`${c}`), sql`, `);
  // Current side honours the caller's period (same basis as the push list);
  // the norm is the code's own closed-years, full-year, territory discount.
  const curPeriod =
    monthLabels && monthLabels.length > 0
      ? sql`AND sl.month_label IN (${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)})`
      : sql``;
  const rows = await db.execute(sql`
    WITH base AS (
      SELECT sl.code, sl.fy,
             sum(sl.amount::float8) AS net,
             sum(im.mrp::float8 * sl.qty::float8) AS mrp_value
      FROM sale_line_current sl
      JOIN item_master im ON im.code = sl.code AND im.mrp::float8 > 0
      WHERE sl.code IN (${codeList}) AND sl.qty::float8 > 0 AND sl.amount::float8 > 0
        AND ${terr}
        AND ((sl.fy = ${fy} ${curPeriod})
             OR (sl.fy != ${fy} AND sl.fy IN (${sql.join(CLOSED_FYS.map((f) => sql`${f}`), sql`, `)})))
      GROUP BY 1, 2
      HAVING sum(im.mrp::float8 * sl.qty::float8) > 0
    )
    SELECT code,
      sum(CASE WHEN fy = ${fy} THEN mrp_value - net END)
        / nullif(sum(CASE WHEN fy = ${fy} THEN mrp_value END), 0) AS cur_disc,
      sum(CASE WHEN fy != ${fy} THEN mrp_value - net END)
        / nullif(sum(CASE WHEN fy != ${fy} THEN mrp_value END), 0) AS norm_disc
    FROM base GROUP BY code
  `);
  for (const r of rows.rows as { code: string; cur_disc: number | null; norm_disc: number | null }[]) {
    if (r.cur_disc == null || r.norm_disc == null) continue;
    const aboveNormPts = (num(r.cur_disc) - num(r.norm_disc)) * 100;
    if (aboveNormPts >= 5) {
      out.set(r.code, {
        code: r.code,
        currentAvgDiscount: num(r.cur_disc),
        normAvgDiscount: num(r.norm_disc),
        aboveNormPts,
      });
    }
  }
  return out;
}

// ── 3. Breadth trend ─────────────────────────────────────────────────────────

export type BreadthTrendCustomer = {
  customer: string;
  perFy: { fy: string; codes: number; segments: number; net: number }[];
  /** Prior-FY net of codes bought in prior FY but not in the latest FY. */
  droppedValue: number;
  droppedCodes: number;
  latestFy: string;
  priorFy: string;
};

export type BreadthTrendResult = {
  fys: string[];
  compared: { latestFy: string; priorFy: string };
  narrowers: BreadthTrendCustomer[];
  projectExclusion: ProjectExclusionMeta;
};

export async function getBreadthTrend(
  latestFy: string,
  priorFy: string,
  monthNames?: string[] | null,
): Promise<BreadthTrendResult> {
  // Like-months restriction: applied to EVERY FY (month_label is 'Apr-26'
  // style, so match on the name part) so breadth is compared Q1-vs-Q1 etc.
  const mn = monthNames && monthNames.length > 0 && monthNames.length < 12 ? monthNames : null;
  const mFilter = mn
    ? sql`AND split_part(month_label, '-', 1) IN (${sql.join(mn.map((m) => sql`${m}`), sql`, `)})`
    : sql``;
  return cached(`breadth:${latestFy}:${priorFy}:${mn ? mn.join(",") : "all"}`, async () => {
    const CLOSED_FYS = await getClosedFys();
    const projSet = await getProjectCustomerSet();
    const terr = territoryFilterSql(projSet);

    const perFyRows = await db.execute(sql`
      SELECT upper(trim(coalesce(customer,'?'))) AS customer, fy,
             count(DISTINCT code)::int AS codes,
             count(DISTINCT coalesce(group_canon, group_raw, 'Unmapped'))::int AS segments,
             sum(amount::float8) AS net
      FROM sale_line_current
      WHERE ${terr} ${mFilter}
      GROUP BY 1, 2
    `);

    const dropRows = await db.execute(sql`
      WITH prior AS (
        SELECT upper(trim(coalesce(customer,'?'))) AS customer, code, sum(amount::float8) AS net
        FROM sale_line_current WHERE fy = ${priorFy} AND ${terr} ${mFilter} GROUP BY 1, 2
      ), latest AS (
        SELECT DISTINCT upper(trim(coalesce(customer,'?'))) AS customer, code
        FROM sale_line_current WHERE fy = ${latestFy} AND ${terr} ${mFilter}
      ), still_active AS (
        SELECT DISTINCT customer FROM latest
      )
      SELECT p.customer, count(*)::int AS dropped_codes, sum(p.net) AS dropped_value
      FROM prior p
      JOIN still_active sa ON sa.customer = p.customer
      LEFT JOIN latest l ON l.customer = p.customer AND l.code = p.code
      WHERE l.code IS NULL AND p.net > 0
      GROUP BY 1
    `);

    const perFyMap = new Map<string, BreadthTrendCustomer["perFy"]>();
    for (const r of perFyRows.rows as Record<string, unknown>[]) {
      const c = String(r.customer);
      const arr = perFyMap.get(c) ?? [];
      arr.push({ fy: String(r.fy), codes: num(r.codes), segments: num(r.segments), net: num(r.net) });
      perFyMap.set(c, arr);
    }

    const narrowers: BreadthTrendCustomer[] = (dropRows.rows as Record<string, unknown>[])
      .map((r) => ({
        customer: String(r.customer),
        perFy: (perFyMap.get(String(r.customer)) ?? []).sort((a, b) => a.fy.localeCompare(b.fy)),
        droppedValue: num(r.dropped_value),
        droppedCodes: num(r.dropped_codes),
        latestFy,
        priorFy,
      }))
      .sort((a, b) => b.droppedValue - a.droppedValue)
      .slice(0, 50);

    return {
      fys: [...CLOSED_FYS, currentOpenFy()],
      compared: { latestFy, priorFy },
      narrowers,
      projectExclusion: projectExclusionMeta(projSet),
    };
  });
}

// ── 4. First-order codes ─────────────────────────────────────────────────────

export type FirstOrderResult = {
  fy: string;
  monthLabels: string[] | null;
  customers: {
    customer: string;
    codes: { code: string; segment: string; firstMonth: string; net: number }[];
    totalNet: number;
  }[];
  projectExclusion: ProjectExclusionMeta;
};

export async function getFirstOrderCodes(
  fy: string,
  monthLabels: string[] | null,
  customer: string | null,
): Promise<FirstOrderResult> {
  const projSet = await getProjectCustomerSet();
  const terr = territoryFilterSql(projSet);
  const monthFilter =
    monthLabels && monthLabels.length > 0
      ? sql`AND f.first_month IN (${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)})`
      : sql``;
  const custFilter = customer
    ? sql`AND f.customer = ${customer.toUpperCase().trim()}`
    : sql``;

  const rows = await db.execute(sql`
    WITH firsts AS (
      SELECT upper(trim(coalesce(customer,'?'))) AS customer, code,
             min(fy) AS first_fy,
             (array_agg(month_label ORDER BY fy, invoice_date NULLS LAST))[1] AS first_month,
             max(coalesce(group_canon, group_raw, 'Unmapped')) AS segment
      FROM sale_line_current
      WHERE ${terr}
      GROUP BY 1, 2
    ), period_net AS (
      SELECT upper(trim(coalesce(customer,'?'))) AS customer, code, sum(amount::float8) AS net
      FROM sale_line_current
      WHERE fy = ${fy} AND ${terr}
        ${
          monthLabels && monthLabels.length > 0
            ? sql`AND month_label IN (${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)})`
            : sql``
        }
      GROUP BY 1, 2
    )
    SELECT f.customer, f.code, f.segment, f.first_month, coalesce(pn.net, 0) AS net
    FROM firsts f
    JOIN period_net pn ON pn.customer = f.customer AND pn.code = f.code
    WHERE f.first_fy = ${fy} ${monthFilter} ${custFilter}
    ORDER BY pn.net DESC
    LIMIT 5000
  `);

  const byCust = new Map<string, FirstOrderResult["customers"][number]>();
  for (const r of rows.rows as Record<string, unknown>[]) {
    const c = String(r.customer);
    let e = byCust.get(c);
    if (!e) {
      e = { customer: c, codes: [], totalNet: 0 };
      byCust.set(c, e);
    }
    e.codes.push({
      code: String(r.code),
      segment: String(r.segment),
      firstMonth: String(r.first_month),
      net: num(r.net),
    });
    e.totalNet += num(r.net);
  }

  return {
    fy,
    monthLabels,
    customers: [...byCust.values()].sort((a, b) => b.totalNet - a.totalNet).slice(0, 100),
    projectExclusion: projectExclusionMeta(projSet),
  };
}

// ── 5. Lost codes ────────────────────────────────────────────────────────────

export type LostCodesResult = {
  fy: string;
  priorFy: string;
  /** Per customer-code, ranked by prior-year value. */
  lost: {
    customer: string;
    code: string;
    segment: string;
    priorNet: number;
    priorQty: number;
  }[];
  projectExclusion: ProjectExclusionMeta;
};

export async function getLostCodes(
  fy: string,
  priorFy: string,
  monthNames?: string[] | null,
): Promise<LostCodesResult> {
  const mn = monthNames && monthNames.length > 0 && monthNames.length < 12 ? monthNames : null;
  const mFilter = mn
    ? sql`AND split_part(month_label, '-', 1) IN (${sql.join(mn.map((m) => sql`${m}`), sql`, `)})`
    : sql``;
  return cached(`lost:${fy}:${priorFy}:${mn ? mn.join(",") : "all"}`, async () => {
    const projSet = await getProjectCustomerSet();
    const terr = territoryFilterSql(projSet);
    const rows = await db.execute(sql`
      WITH prior AS (
        SELECT upper(trim(coalesce(customer,'?'))) AS customer, code,
               max(coalesce(group_canon, group_raw, 'Unmapped')) AS segment,
               sum(amount::float8) AS net, sum(qty::float8) AS qty
        FROM sale_line_current WHERE fy = ${priorFy} AND ${terr} ${mFilter} GROUP BY 1, 2
      ), cur AS (
        SELECT DISTINCT upper(trim(coalesce(customer,'?'))) AS customer, code
        FROM sale_line_current WHERE fy = ${fy} AND ${terr} ${mFilter}
      ), still_active AS (SELECT DISTINCT customer FROM cur)
      SELECT p.customer, p.code, p.segment, p.net AS prior_net, p.qty AS prior_qty
      FROM prior p
      JOIN still_active sa ON sa.customer = p.customer
      LEFT JOIN cur c ON c.customer = p.customer AND c.code = p.code
      WHERE c.code IS NULL AND p.net > 0
      ORDER BY p.net DESC
      LIMIT 500
    `);
    return {
      fy,
      priorFy,
      lost: (rows.rows as Record<string, unknown>[]).map((r) => ({
        customer: String(r.customer),
        code: String(r.code),
        segment: String(r.segment),
        priorNet: num(r.prior_net),
        priorQty: num(r.prior_qty),
      })),
      projectExclusion: projectExclusionMeta(projSet),
    };
  });
}

// ── 6. Blocked capabilities ──────────────────────────────────────────────────

export type BlockedResult = {
  marginPerCode: { blocked: true; reason: string };
  liveYearRetailer: { blocked: boolean; reason: string };
};

export async function getBlockedCapabilities(): Promise<BlockedResult> {
  const cost = await db.execute(sql`SELECT count(*)::int AS n FROM cost_master`);
  const n = num((cost.rows[0] as { n: number }).n);
  return {
    marginPerCode: {
      blocked: true,
      reason:
        n === 0
          ? "No finished-goods cost master exists (cost_master is empty). MRP and purchase price are list prices, not costs — MRP discount is not margin and is never substituted."
          : `cost_master has ${n} rows but has not been verified as a genuine cost source.`,
    },
    liveYearRetailer: await (async () => {
      const openFy = currentOpenFy();
      const [has, periodLabel] = await Promise.all([
        secondarySkuFyHasData(openFy),
        getSecondarySkuFyPeriodLabel(openFy),
      ]);
      return has
        ? {
            blocked: false,
            reason:
              `FY${openFy} secondary register loaded from the PSCode_3 xlsx drop (${periodLabel ?? "partial period"}). ` +
              "Retailer SKU activity and secondary discount are computable for the covered months; " +
              "coverage extends only when a fresh export is loaded.",
          }
        : {
            blocked: true,
            reason:
              `No FY${openFy} secondary register exists — retailer SKU activity and secondary discount are not computable for the live year.`,
          };
    })(),
  };
}
