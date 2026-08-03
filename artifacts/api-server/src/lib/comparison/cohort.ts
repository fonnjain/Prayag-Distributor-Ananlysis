// Phase C3 Mode D — Cohorts. A cohort is a RULE, not a hand-picked list, so it
// re-evaluates as data changes. NO NEW COMPUTATION of underlying figures — every
// rule reuses an existing loader (deep-dive Data tab, distributor deep dive,
// at-risk analytics, seasonality, member sheet map) or the frozen registers,
// and reports per cohort: the population count, the measure, and the difference
// WITH ITS SAMPLE SIZE. A difference between cohorts of 3 and 800 is not a finding.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { fyForDate } from "../mgmt/targetEngine.js";
import { loadDeepDiveData } from "../mgmt/deepDiveData.js";
import { loadDistributorDeepDiveResilient } from "../mgmt/distributorDeepDive.js";
import { getMemberFileId } from "../mgmt/memberSheet.js";
import { getAtRisk } from "../customers/analytics.js";
import { getSeasonality } from "../sku/skuK4.js";
import { PROJECT_HEAD_CANON } from "../sku/catalogue.js";
import { logger } from "../logger.js";

const MIN_CORRELATION_SAMPLE = 5;

export type CohortRule =
  | "assignment"        // retailers WITH an assigned distributor vs WITHOUT
  | "achievementBand"   // members above vs below a stated achievement band
  | "distributorTier"   // distributors by tier A/B/C
  | "customerStatus"    // customers retained / reactivated / lapsed / dormant
  | "segmentSeason"     // segments in season this quarter vs out of season
  | "sheetMapped";      // members with a mapped working sheet vs without

export type CohortRequest = {
  rule: CohortRule;
  /** achievementBand: the split, e.g. 0.5 = 50%. */
  band?: number;
  fy?: string;
  channel?: "territory" | "project" | "all";
  today?: string;
};

export type CohortGroup = {
  name: string;
  population: number;
  value: number | null;
  valueLabel: string;
  note?: string;
};

export type CohortResponse = {
  blocked: false;
  basis: {
    rule: CohortRule;
    ruleDetail: string;
    fy: string;
    channel: string;
    channelLabel: string;
    /** Both readings, always — the data cannot distinguish some causes. */
    readings: string[];
  };
  cohorts: CohortGroup[];
  /** Pairwise difference for two-cohort rules — never without both populations. */
  difference?: { value: number | null; label: string; sampleNote: string };
  correlation?: { r: number | null; n: number; suppressed: boolean; note: string };
  /** C4: server-computed suggested actions built only from the figures above. */
  suggestions?: CohortSuggestion[];
  notes: string[];
};

export type CohortSuggestion = {
  rank: number;
  kind: "cohort-gap";
  action: string;
  /** The exact figures the suggestion rests on. */
  evidence: string;
  /** The rule's readings ALWAYS travel with the suggestion — the data often
   *  cannot distinguish cause from effect. */
  caveats: string[];
};

export class CohortError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function channelLabel(channel: "territory" | "project" | "all"): string {
  if (channel === "territory") return "TERRITORY ONLY — project & institutional (Non-territory / Project / Govt) business is EXCLUDED. Do not compare these figures against all-channel totals from other pages.";
  if (channel === "project") return "PROJECT / INSTITUTIONAL CHANNEL ONLY — territory business is excluded.";
  return "ALL CHANNELS — territory plus project/institutional blended.";
}

function channelFilter(channel: "territory" | "project" | "all") {
  if (channel === "territory") return sql`(head_canon IS NULL OR head_canon != ${PROJECT_HEAD_CANON})`;
  if (channel === "project") return sql`head_canon = ${PROJECT_HEAD_CANON}`;
  return sql`TRUE`;
}

async function all<T = any>(q: any): Promise<T[]> {
  const res = await db.execute(q);
  return ((res as any).rows ?? res) as T[];
}

function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : 0;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Aggregate the per-head distributor deep dive across every state head.
 *  Members and distributors are deduped by normKey (a member appears under one
 *  head; a distributor may not — first occurrence wins, count noted). */
async function loadCompanyWideDistributorData(fy: string) {
  const registry = await loadDeepDiveData(fy, undefined, undefined, { skipExtras: true });
  const heads = registry.stateHeads ?? [];
  const perMember: Awaited<ReturnType<typeof loadDistributorDeepDiveResilient>>["perMember"] = [];
  const distributors: Awaited<ReturnType<typeof loadDistributorDeepDiveResilient>>["distributors"] = [];
  const seenMember = new Set<string>();
  const seenDist = new Set<string>();
  const headsFailed: string[] = [];
  let headsCovered = 0;
  for (const head of heads) {
    try {
      const dd = await loadDistributorDeepDiveResilient(fy, head);
      if (dd.error && dd.perMember.length === 0 && dd.distributors.length === 0) { headsFailed.push(head); continue; }
      headsCovered++;
      for (const m of dd.perMember) {
        const k = m.normKey;
        if (seenMember.has(k)) continue;
        seenMember.add(k); perMember.push(m);
      }
      for (const g of dd.distributors) {
        if (seenDist.has(g.normKey)) continue;
        seenDist.add(g.normKey); distributors.push(g);
      }
    } catch (err) {
      logger.warn({ err, head, fy }, "cohort: state head deep dive failed");
      headsFailed.push(head);
    }
  }
  return { perMember, distributors, headsCovered, headsFailed };
}

export async function runCohort(req: CohortRequest): Promise<CohortResponse> {
  const res = await runCohortInner(req);
  return { ...res, ...(buildCohortSuggestions(res) ?? {}) };
}

/** C4: turn a finished cohort result into at most two suggested actions.
 *  Uses ONLY figures already in the response; readings are mandatory caveats. */
function buildCohortSuggestions(res: CohortResponse): { suggestions: CohortSuggestion[] } | null {
  const suggestions: CohortSuggestion[] = [];
  const valued = res.cohorts.filter((c) => c.value != null);
  if (valued.length >= 2) {
    const sorted = [...valued].sort((a, b) => a.value! - b.value!);
    const weak = sorted[0], strong = sorted[sorted.length - 1];
    const gapText = res.difference && res.difference.value != null
      ? `gap ${res.difference.value} — ${res.difference.label}; ${res.difference.sampleNote}`
      : `populations ${weak.population.toLocaleString("en-IN")} vs ${strong.population.toLocaleString("en-IN")}`;
    suggestions.push({
      rank: 1, kind: "cohort-gap",
      action: `Focus effort on the '${weak.name}' cohort — it trails '${strong.name}' on ${weak.valueLabel}.`,
      evidence: `${weak.name}: ${weak.value} vs ${strong.name}: ${strong.value} (${weak.valueLabel}); ${gapText}.`,
      caveats: [...res.basis.readings],
    });
  }
  if (res.correlation && !res.correlation.suppressed && res.correlation.r != null) {
    suggestions.push({
      rank: suggestions.length + 1, kind: "cohort-gap",
      action: Math.abs(res.correlation.r) < 0.3
        ? `Treat the cohort gap as directional, not proof — the member-level correlation is weak.`
        : `The member-level correlation supports acting on this split.`,
      evidence: `r = ${res.correlation.r}, n = ${res.correlation.n}. ${res.correlation.note}`,
      caveats: [...res.basis.readings],
    });
  }
  return suggestions.length ? { suggestions } : null;
}

async function runCohortInner(req: CohortRequest): Promise<CohortResponse> {
  const today = req.today ? new Date(req.today) : new Date();
  const currentFy = fyForDate(today);
  const fy = req.fy ?? currentFy;
  const channel = req.channel ?? "territory";
  const notes: string[] = [];

  // Rules built from the working sheets / deep-dive data cannot be filtered by
  // channel — the sheets are territory-scope by construction. Claiming a
  // Project or All-channel basis for them would mislabel the figures.
  const SHEET_SCOPED_RULES: CohortRule[] = ["assignment", "achievementBand", "distributorTier", "sheetMapped"];
  if (SHEET_SCOPED_RULES.includes(req.rule) && channel !== "territory") {
    throw new CohortError(
      `rule '${req.rule}' is built from the working sheets, which carry territory business only — it cannot be scoped to channel '${channel}'. Use channel 'territory'.`,
      400,
    );
  }

  const base = (rule: CohortRule, ruleDetail: string, readings: string[]): CohortResponse["basis"] =>
    ({ rule, ruleDetail, fy, channel,
       channelLabel: SHEET_SCOPED_RULES.includes(rule)
         ? "WORKING-SHEET DATA — territory business only by construction (the member working sheets carry no project/institutional lines)."
         : channelLabel(channel),
       readings });

  switch (req.rule) {
    // ── The assignment cohort — the one to get right ─────────────────────────
    case "assignment": {
      // The distributor deep dive builds per state head — company-wide means
      // aggregating over every head, never a single-head figure passed off as national.
      const { perMember, distributors, headsCovered, headsFailed } = await loadCompanyWideDistributorData(fy);
      void distributors;
      if (perMember.length === 0) throw new CohortError("distributor deep dive returned no members for any state head", 503);
      if (headsFailed.length) notes.push(`${headsFailed.length} state head(s) could not be loaded this build: ${headsFailed.join(", ")} — figures cover the ${headsCovered} loaded heads`);
      const active = perMember.filter((m) => !m.isLeft && m.totalRetailers > 0);
      // Company-wide retailer-level activity, weighted by each member's counts.
      let namedTotal = 0, namedActive = 0, noneTotal = 0, noneActive = 0;
      for (const m of active) {
        namedTotal += m.namedCount;
        if (m.namedActivePct != null) namedActive += (m.namedActivePct / 100) * m.namedCount;
        noneTotal += m.noneCount;
        if (m.noneActivePct != null) noneActive += (m.noneActivePct / 100) * m.noneCount;
      }
      const withPct = namedTotal > 0 ? r1((namedActive / namedTotal) * 100) : null;
      const withoutPct = noneTotal > 0 ? r1((noneActive / noneTotal) * 100) : null;
      // Member-level correlation at full scale: unassigned share vs achievement.
      const pts = active
        .filter((m) => m.noneSharePct != null && m.achievementTotal != null)
        .map((m) => [m.noneSharePct!, m.achievementTotal!] as [number, number]);
      const n = pts.length;
      const r = n >= MIN_CORRELATION_SAMPLE ? pearson(pts) : null;
      return {
        blocked: false,
        basis: base("assignment",
          `retailers WITH a named distributor vs WITHOUT ('--'), across all member working sheets, FY${fy}. Value = % of retailers active. Correlation = member-level Pearson r between unassigned share and achievement.`,
          [
            "Reading 1: a retailer with no distributor may have no route to order — assignment drives activity.",
            "Reading 2: '--' may be written when a retailer goes dormant — activity drives assignment. The data cannot distinguish them.",
          ]),
        cohorts: [
          { name: "With assigned distributor", population: namedTotal, value: withPct, valueLabel: "% of retailers active" },
          { name: "Without ('--')", population: noneTotal, value: withoutPct, valueLabel: "% of retailers active" },
        ],
        difference: {
          value: withPct != null && withoutPct != null ? r1(withPct - withoutPct) : null,
          label: "percentage-point gap in active share",
          sampleNote: `populations ${namedTotal.toLocaleString("en-IN")} with vs ${noneTotal.toLocaleString("en-IN")} without, across ${active.length} members`,
        },
        correlation: {
          r, n, suppressed: n < MIN_CORRELATION_SAMPLE,
          note: n < MIN_CORRELATION_SAMPLE
            ? `correlation suppressed: sample n=${n} below minimum ${MIN_CORRELATION_SAMPLE}`
            : `Pearson r between a member's unassigned-retailer share and their achievement, across ${n} active members — reported as measured, whatever its strength`,
        },
        notes,
      };
    }

    // ── Members above vs below an achievement band ───────────────────────────
    case "achievementBand": {
      const band = req.band ?? 0.5;
      if (!(band > 0 && band < 5)) throw new CohortError("band must be a ratio, e.g. 0.5 for 50%");
      const dd = await loadDeepDiveData(fy, undefined, undefined, { skipExtras: true });
      const members = dd.members.filter((m) => !m.isLeft);
      // Data-tab achievementTotal is a PERCENT (57.5 = 57.5%), not a ratio.
      const bandPct = band * 100;
      const withAch = members.filter((m) => m.achievementTotal != null);
      const above = withAch.filter((m) => m.achievementTotal! >= bandPct);
      const below = withAch.filter((m) => m.achievementTotal! < bandPct);
      const mean = (xs: number[]) => (xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
      const unrated = members.length - withAch.length;
      if (unrated > 0) notes.push(`${unrated} member(s) have no computable achievement (no target recorded) — in neither cohort, never counted as 0%`);
      return {
        blocked: false,
        basis: base("achievementBand",
          `active members split at achievement ${(band * 100).toFixed(0)}% (Data-tab recomputed (OB+NP+DD)/target ×100, FY${fy} to date). Members without a target are excluded, never treated as 0%.`,
          ["Achievement is against target-to-date — a low figure can mean a slow start OR an over-ambitious target. Both readings stand."]),
        cohorts: [
          { name: `At or above ${(band * 100).toFixed(0)}%`, population: above.length, value: mean(above.map((m) => m.achievementTotal!)), valueLabel: "mean achievement (%)" },
          { name: `Below ${(band * 100).toFixed(0)}%`, population: below.length, value: mean(below.map((m) => m.achievementTotal!)), valueLabel: "mean achievement (%)" },
        ],
        difference: {
          value: null, label: "split by construction — the difference is the band itself, not a finding",
          sampleNote: `populations ${above.length} above vs ${below.length} below (${unrated} unrated excluded)`,
        },
        notes,
      };
    }

    // ── Members with vs without a mapped working sheet ───────────────────────
    case "sheetMapped": {
      const dd = await loadDeepDiveData(fy, undefined, undefined, { skipExtras: true });
      const members = dd.members.filter((m) => !m.isLeft);
      const mapped = members.filter((m) => getMemberFileId(m.normKey));
      const unmapped = members.filter((m) => !getMemberFileId(m.normKey));
      const mean = (ms: typeof members) => {
        const xs = ms.map((m) => m.achievementTotal).filter((v): v is number => v != null);
        return xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
      };
      return {
        blocked: false,
        basis: base("sheetMapped",
          `active members with a mapped working sheet (member_sheet_map) vs without, FY${fy}. Value = mean achievement among those with a target.`,
          ["A mapped sheet enables retailer-level analysis; it does not itself cause performance. Mapping tends to follow onboarding order, not merit."]),
        cohorts: [
          { name: "Working sheet mapped", population: mapped.length, value: mean(mapped), valueLabel: "mean achievement (%)" },
          { name: "No mapped sheet", population: unmapped.length, value: mean(unmapped), valueLabel: "mean achievement (%)" },
        ],
        difference: {
          value: mean(mapped) != null && mean(unmapped) != null ? r3(mean(mapped)! - mean(unmapped)!) : null,
          label: "difference in mean achievement",
          sampleNote: `populations ${mapped.length} mapped vs ${unmapped.length} unmapped`,
        },
        notes,
      };
    }

    // ── Distributors by tier ─────────────────────────────────────────────────
    case "distributorTier": {
      const { distributors, headsFailed } = await loadCompanyWideDistributorData(fy);
      if (distributors.length === 0) throw new CohortError("distributor deep dive returned no distributors for any state head", 503);
      if (headsFailed.length) notes.push(`${headsFailed.length} state head(s) could not be loaded this build: ${headsFailed.join(", ")}`);
      const withTier = distributors.filter((g) => g.investment?.tier);
      const groups: CohortGroup[] = (["A", "B", "C"] as const).map((t) => {
        const gs = withTier.filter((g) => g.investment!.tier.tier === t);
        const ob = gs.reduce((a, g) => a + (g.orderBooking ?? 0), 0);
        return {
          name: `Tier ${t}`, population: gs.length,
          value: gs.length ? Math.round(ob) : null,
          valueLabel: "total secondary OB (₹)",
          note: gs.length ? undefined : "no distributors in this tier",
        };
      });
      const untiered = distributors.length - withTier.length;
      if (untiered > 0) notes.push(`${untiered} distributor(s) have no tier (investment data unavailable) — listed in no cohort, never guessed`);
      return {
        blocked: false,
        basis: base("distributorTier",
          `distributors by D4 tier (scored on NET, growth, active ratio, discounts), FY${fy}. Value = total secondary OB attributed via member sheets.`,
          ["Tier follows revenue by construction — a gap between tiers restates the tiering rule, it does not discover one."]),
        cohorts: groups,
        notes,
      };
    }

    // ── Customers retained / reactivated / lapsed / dormant ─────────────────
    case "customerStatus": {
      const priorFy = ((f: string) => { const a = parseInt(f.slice(0, 4), 10); return `${a - 1}-${String(a).slice(2)}`; })(fy);
      const rows = await all<{ customer: string; cur: number; prior: number; older: number; cursum: number }>(sql`
        SELECT customer,
               max(CASE WHEN fy = ${fy} THEN 1 ELSE 0 END) AS cur,
               max(CASE WHEN fy = ${priorFy} THEN 1 ELSE 0 END) AS prior,
               max(CASE WHEN fy < ${priorFy} THEN 1 ELSE 0 END) AS older,
               sum(CASE WHEN fy = ${fy} THEN amount::float8 ELSE 0 END) AS cursum
        FROM sale_line_current
        WHERE ${channelFilter(channel)}
        GROUP BY customer`);
      const buckets = {
        retained: rows.filter((r) => Number(r.cur) === 1 && Number(r.prior) === 1),
        reactivated: rows.filter((r) => Number(r.cur) === 1 && Number(r.prior) === 0 && Number(r.older) === 1),
        new: rows.filter((r) => Number(r.cur) === 1 && Number(r.prior) === 0 && Number(r.older) === 0),
        lapsed: rows.filter((r) => Number(r.cur) === 0 && Number(r.prior) === 1),
        dormant: rows.filter((r) => Number(r.cur) === 0 && Number(r.prior) === 0),
      };
      let atRiskCount: number | null = null;
      try { atRiskCount = (await getAtRisk({})).length; } catch (err) { logger.warn({ err }, "cohort: at-risk unavailable"); }
      const g = (name: string, rs: typeof rows, note?: string): CohortGroup => ({
        name, population: rs.length,
        value: Math.round(rs.reduce((a, r) => a + Number(r.cursum), 0)),
        valueLabel: `FY${fy} primary sale (₹)`,
        ...(note ? { note } : {}),
      });
      if (atRiskCount != null) notes.push(`${atRiskCount} currently-buying customers are additionally flagged at-risk by the median-gap model (overdue vs their own cycle) — a subset of the buckets above, not a sixth bucket`);
      return {
        blocked: false,
        basis: base("customerStatus",
          `primary customers by purchase history: retained (bought FY${priorFy} and FY${fy}), reactivated (bought FY${fy} after skipping FY${priorFy}), new (first seen FY${fy}), lapsed (bought FY${priorFy}, not FY${fy}), dormant (older history only). Value = FY${fy} primary sale.`,
          [
            "Reading 1: a lapsed customer stopped buying.",
            "Reading 2: the live FY register is still filling — a customer may simply not have ordered YET this year. Lapsed vs slow cannot be distinguished mid-year.",
          ]),
        cohorts: [
          g("Retained", buckets.retained),
          g("Reactivated", buckets.reactivated),
          g("New this FY", buckets.new),
          g("Lapsed", buckets.lapsed, `₹ is FY${fy} sale, so 0 by construction — the population count is the figure`),
          g("Dormant (older history only)", buckets.dormant, "no purchase in either recent FY"),
        ],
        notes,
      };
    }

    // ── Segments in vs out of season this quarter ────────────────────────────
    case "segmentSeason": {
      const season = await getSeasonality("territory");
      const fm = ((today.getMonth() + 12 - 3) % 12) + 1;               // fiscal month 1..12
      const q = Math.ceil(fm / 3);                                     // fiscal quarter 1..4
      const qFrom = (q - 1) * 3 + 1, qTo = q * 3;
      const inSeason: string[] = [], outSeason: string[] = [];
      const shareBySeg = new Map<string, number>();
      for (const s of season.segments) {
        let share = 0;
        for (let m = qFrom; m <= qTo; m++) share += s.monthShare[m - 1] ?? 0;
        shareBySeg.set(s.segment, share);
        (share > 0.25 ? inSeason : outSeason).push(s.segment);
      }
      const labels: string[] = [];
      for (let m = qFrom; m <= qTo; m++) {
        const fyStart = parseInt(fy.split("-")[0], 10);
        const cal = ((m + 2) % 12) + 1;
        const yr = m <= 9 ? fyStart : fyStart + 1;
        labels.push(`${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][cal - 1]}-${String(yr).slice(2)}`);
      }
      const seg = async (names: string[]) => {
        if (!names.length) return { v: 0, n: 0 };
        const rows = await all<{ v: number }>(sql`
          SELECT coalesce(sum(amount::float8),0) AS v FROM sale_line_current
          WHERE fy = ${fy} AND month_label IN (${sql.join(labels.map((l) => sql`${l}`), sql`, `)})
            AND ${channelFilter(channel)}
            AND coalesce(group_canon, group_raw, 'Uncategorized') IN (${sql.join(names.map((x) => sql`${x}`), sql`, `)})`);
        return { v: Number(rows[0]?.v ?? 0), n: names.length };
      };
      const [inR, outR] = await Promise.all([seg(inSeason), seg(outSeason)]);
      return {
        blocked: false,
        basis: base("segmentSeason",
          `segments whose historical Q${q} share exceeds a flat quarter (25%) are 'in season'; seasonality from the frozen multi-year curves. Value = Q${q} FY${fy} NET.`,
          ["In-season revenue leads by construction — the useful read is an in-season segment UNDERPERFORMING its own season, which this split alone does not show."]),
        cohorts: [
          { name: `In season (Q${q})`, population: inR.n, value: Math.round(inR.v), valueLabel: `Q${q} FY${fy} NET (₹)`, note: inSeason.slice(0, 12).join(", ") || undefined },
          { name: "Out of season", population: outR.n, value: Math.round(outR.v), valueLabel: `Q${q} FY${fy} NET (₹)`, note: outSeason.slice(0, 12).join(", ") || undefined },
        ],
        notes,
      };
    }

    default:
      throw new CohortError(`unknown cohort rule '${(req as any).rule}'. Valid: assignment, achievementBand, distributorTier, customerStatus, segmentSeason, sheetMapped`);
  }
}
