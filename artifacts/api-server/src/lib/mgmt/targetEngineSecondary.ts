// ── T2 — Engine targets per salesperson and State Head (SECONDARY basis) ─────
//
// The primary engine (targetEngine.ts) computes on sale_line — Prayag →
// distributor. Salespeople do not sell to distributors: they book SECONDARY
// business from retailers, the only measure that carries a salesperson name.
// This module rebuilds the three populations on the FY secondary register at
// RETAILER × ITEM CODE and computes each person's target BOTTOM-UP from their
// own history. The primary engine is untouched; the two bases are labelled
// and never blended — they are different populations and will not reconcile.
//
// Overrides share the engine_targets table with row keys
//   secmember|<nsk>   and   sechead|<nsk>
// so user edits survive regeneration exactly like the primary engine.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import {
  fyForDate, priorFy, loadOverrides, DEFAULT_WEIGHTS,
  type EngineWeights, type EngineOverride,
} from "./targetEngine.js";
import { loadMemberTargetSnapshots, type MemberTargetSnapshot } from "./deepDiveData.js";
import { canonItemGroup } from "../sku/catalogue.js";
import { getSeasonality } from "../sku/skuK4.js";
import { normSecKey, normName } from "./names.js";
import { fetchWorkbook } from "../sheets.js";
import { logger } from "../logger.js";

const RETAILER_DISTRIBUTOR_ROSTER = "1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc";

// Guard thresholds
const MIN_RETAILER_BASE = 10;    // below this a bottom-up target is meaningless → fallback median
const CACHE_TTL_MS = 30 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export type PersonFlag =
  | { kind: "left"; detail: string }
  | { kind: "fallback"; detail: string }
  | { kind: "newMember"; detail: string }
  | { kind: "proRated"; detail: string }
  | { kind: "thinBase"; detail: string }
  | { kind: "gainedTarget"; detail: string }
  | { kind: "noPool"; detail: string }
  | { kind: "sumMismatch"; detail: string };

export type PersonRow = {
  type: "member" | "head";
  name: string;
  key: string;                       // nsk
  stateHead: string;                 // for member rows; head rows repeat their own name
  state: string;
  // Baseline: the person's own secondary FY(baseline) business
  baseline: number;
  baselineRetailers: number;
  oldSkuPairs: number;
  /** Uncovered roster retailers attributed to this person (state pool × baseline share). */
  uncoveredAllocated: number;
  // Targets
  oldSkuTarget: number | null;
  newSkuTarget: number | null;
  newCustomerTarget: number | null;
  combined: number | null;
  engineProposed: number | null;     // shown when a user value differs
  source: "generated" | "user" | "none";
  // Comparison with the user-filled world
  userFilled: number | null;         // Data-tab monthly target × 12 (annualised)
  difference: number | null;         // combined − userFilled
  hadTarget: boolean;
  // Monthly split (12 shares summing to 1) from the person's own segment mix
  monthlySplit: number[] | null;
  splitBasis: string | null;
  fallbackBasis: string | null;
  flags: PersonFlag[];
  // Scaling (visible, never silent)
  scaledCombined?: number | null;
};

export type SecondaryEngineResult = {
  basis: "secondary";
  basisNote: string;
  fy: string;
  baselineFy: string;
  params: { increasePct: number; weights: EngineWeights };
  // Reconciliation of the baseline against the register
  baseline: {
    skuLineTotal: number;
    registerTotal: number;
    deltaPct: number;
    lines: number;
    attributedTotal: number;
    unattributedTotal: number;
    unattributedHeads: number;
  };
  populations: {
    oldSkuPairs: number;
    newSkuCandidatePairs: number;
    newCustomers: {
      registeredRetailers: number;
      declaredCoverage: number;
      idVerifiedCoverage: number;
      uncoveredRetailers: number;
      note: string;
      byState: { state: string; registered: number; declaredCoverage: number; uncovered: number; membersCovering: number }[];
      unattributedStates: number;
    };
  };
  zeroTargetMoved: { count: number; names: string[]; totalGenerated: number };
  leftMembersExcluded: string[];
  impliedCompanyTotal: number;
  scaling: { requested: number | null; factor: number | null } ;
  rows: PersonRow[];
};

// ── Baseline aggregation from secondary_sku_line ─────────────────────────────

type MemberBaseline = {
  headCanon: string;
  total: number;
  retailers: number;
  pairs: number;
  codes: number;
  bySegment: Map<string, number>;   // canonical segment → net
};

async function loadBaselines(baselineFy: string): Promise<Map<string, MemberBaseline>> {
  const rows = await db.execute(sql`
    SELECT s.head_canon, coalesce(im.item_group, '') AS item_group,
           sum(s.net_amount::float8) AS net,
           count(DISTINCT s.retailer) AS retailers,
           count(DISTINCT (s.retailer, s.item_code)) AS pairs,
           count(DISTINCT s.item_code) AS codes
    FROM secondary_sku_line s
    LEFT JOIN item_master im ON im.code = s.item_code
    WHERE s.fy = ${baselineFy} AND s.head_canon IS NOT NULL
    GROUP BY 1, 2`);
  const list = ((rows as any).rows ?? rows) as {
    head_canon: string; item_group: string; net: string; retailers: string; pairs: string; codes: string;
  }[];
  // Per-head totals need a second pass because retailer/pair counts must be
  // computed across ALL segments, not summed per segment (they would double-count).
  const totals = await db.execute(sql`
    SELECT head_canon,
           sum(net_amount::float8) AS net,
           count(DISTINCT retailer) AS retailers,
           count(DISTINCT (retailer, item_code)) AS pairs,
           count(DISTINCT item_code) AS codes
    FROM secondary_sku_line
    WHERE fy = ${baselineFy} AND head_canon IS NOT NULL
    GROUP BY 1`);
  const tlist = ((totals as any).rows ?? totals) as {
    head_canon: string; net: string; retailers: string; pairs: string; codes: string;
  }[];
  const out = new Map<string, MemberBaseline>();
  for (const t of tlist) {
    out.set(normSecKey(t.head_canon), {
      headCanon: t.head_canon,
      total: Number(t.net),
      retailers: Number(t.retailers),
      pairs: Number(t.pairs),
      codes: Number(t.codes),
      bySegment: new Map(),
    });
  }
  for (const r of list) {
    const mb = out.get(normSecKey(r.head_canon));
    if (!mb) continue;
    const seg = canonItemGroup(r.item_group) ?? "Unmapped";
    mb.bySegment.set(seg, (mb.bySegment.get(seg) ?? 0) + Number(r.net));
  }
  return out;
}

// ── Registered retailer roster (Retailer-Distributor Data → Retailer tab) ────

type RosterCoverage = {
  registered: number;
  /** Strict RET# ID match against the secondary lines — a verified lower bound only. */
  idVerifiedCovered: number;
  registeredByState: Map<string, number>;
};

let _rosterCache: { at: number; data: RosterCoverage } | null = null;

async function loadRosterCoverage(baselineFy: string): Promise<RosterCoverage> {
  if (_rosterCache && Date.now() - _rosterCache.at < CACHE_TTL_MS) return _rosterCache.data;
  const wb = await fetchWorkbook(RETAILER_DISTRIBUTOR_ROSTER, (t: string) => /^retailer$/i.test(t.trim()));
  const sheet = (wb as ExcelJS.Workbook).getWorksheet("Retailer");
  if (!sheet) throw new Error("Retailer-Distributor workbook is missing the 'Retailer' tab");

  // secondary_sku_line.retailer stores the roster's RET# ID — match on the ID.
  const coveredRes = await db.execute(sql`
    SELECT DISTINCT retailer FROM secondary_sku_line WHERE fy = ${baselineFy} AND retailer IS NOT NULL`);
  const coveredIds = new Set(
    (((coveredRes as any).rows ?? coveredRes) as { retailer: string }[]).map((r) => r.retailer.trim().toUpperCase()),
  );

  let registered = 0, idVerifiedCovered = 0;
  const registeredByState = new Map<string, number>();
  sheet.eachRow((row, r) => {
    if (r < 2) return;
    const id = String(row.getCell(1).value ?? "").trim().toUpperCase();
    if (!id.startsWith("RET#")) return;
    registered++;
    const state = String(row.getCell(10).value ?? "").trim().toUpperCase() || "UNKNOWN";
    registeredByState.set(state, (registeredByState.get(state) ?? 0) + 1);
    if (coveredIds.has(id)) idVerifiedCovered++;
  });
  const data = { registered, idVerifiedCovered, registeredByState };
  _rosterCache = { at: Date.now(), data };
  return data;
}

// ── Seasonality per person's own segment mix ─────────────────────────────────

async function buildSegmentCurves(): Promise<Map<string, number[]>> {
  const season = await getSeasonality("territory");
  const map = new Map<string, number[]>();
  for (const s of season.segments) {
    if (Array.isArray(s.monthShare) && s.monthShare.length === 12) {
      map.set(normName(s.segment), s.monthShare);
    }
  }
  return map;
}

const FLAT_CURVE = Array(12).fill(1 / 12);

function personCurve(
  bySegment: Map<string, number>,
  curves: Map<string, number[]>,
): { split: number[]; basis: string } {
  let total = 0, matched = 0;
  const acc = Array(12).fill(0);
  for (const [seg, v] of bySegment) {
    total += v;
    const curve = curves.get(normName(seg));
    if (curve) {
      matched += v;
      for (let i = 0; i < 12; i++) acc[i] += v * curve[i];
    }
  }
  if (total <= 0 || matched <= 0) return { split: [...FLAT_CURVE], basis: "flat (no segment history matched a curve)" };
  // Unmatched mass follows a flat curve.
  const unmatched = total - matched;
  for (let i = 0; i < 12; i++) acc[i] += unmatched / 12;
  const sum = acc.reduce((a, b) => a + b, 0);
  const split = acc.map((v) => v / sum);
  const pct = Math.round((matched / total) * 100);
  return { split, basis: `own segment mix (${pct}% of baseline matched to segment curves)` };
}

// ── Main compute ─────────────────────────────────────────────────────────────

export async function computeSecondaryEngineTargets(opts: {
  fy?: string;
  today?: Date;
  scaleTo?: number | null;
}): Promise<SecondaryEngineResult> {
  const today = opts.today ?? new Date();
  const fy = opts.fy ?? fyForDate(today);
  const baselineFy = priorFy(fy);

  const [overrides, snapshots, baselines, curves] = await Promise.all([
    loadOverrides(fy),
    loadMemberTargetSnapshots(fy),
    loadBaselines(baselineFy),
    buildSegmentCurves().catch((err) => {
      logger.warn({ err }, "secondary engine: seasonality unavailable — flat curves");
      return new Map<string, number[]>();
    }),
  ]);
  if (!snapshots) throw new Error("member roster unavailable (Data tab not loaded)");

  const savedParams = overrides.get("params")?.value as any;
  const increasePct: number = savedParams?.increasePct ?? 25;
  const weights: EngineWeights = savedParams?.weights ?? DEFAULT_WEIGHTS;
  const inc = increasePct / 100;

  // ── Register reconciliation ──
  const regRes = await db.execute(sql`
    SELECT coalesce(sum(net_amount::float8),0) AS v, count(*)::int AS n
    FROM secondary_register_line WHERE fy = ${baselineFy}`);
  const reg = (((regRes as any).rows ?? regRes) as any[])[0];
  const registerTotal = Number(reg.v);
  const skuRes = await db.execute(sql`
    SELECT coalesce(sum(net_amount::float8),0) AS v, count(*)::int AS n
    FROM secondary_sku_line WHERE fy = ${baselineFy}`);
  const sku = (((skuRes as any).rows ?? skuRes) as any[])[0];
  const skuLineTotal = Number(sku.v);

  // ── Attribution: baseline head_canon → roster member via normSecKey ──
  const snapByKey = new Map(snapshots.map((s) => [s.normKey, s]));
  let attributedTotal = 0, unattributedTotal = 0, unattributedHeads = 0;
  const baselineByMember = new Map<string, MemberBaseline>();
  for (const [key, mb] of baselines) {
    if (snapByKey.has(key)) {
      baselineByMember.set(key, mb);
      attributedTotal += mb.total;
    } else {
      unattributedTotal += mb.total;
      unattributedHeads++;
    }
  }

  // ── New-customer pool (already quantified — attribute by state) ──
  const roster = await loadRosterCoverage(baselineFy).catch((err) => {
    logger.warn({ err }, "secondary engine: retailer roster unavailable");
    return null;
  });
  const activeSnaps = snapshots.filter((s) => !s.isLeft);
  const membersByState = new Map<string, MemberTargetSnapshot[]>();
  for (const s of activeSnaps) {
    const st = (s.state || "UNKNOWN").toUpperCase();
    if (!membersByState.has(st)) membersByState.set(st, []);
    membersByState.get(st)!.push(s);
  }
  // Uncovered pool per the spec's own quantification: registered retailers per
  // state MINUS the declared coverage (Data-tab retailer counts) of that
  // state's active members. The strict RET#-ID match is kept as a verified
  // lower bound of coverage only — most secondary lines carry names, not IDs.
  const uncoveredShare = new Map<string, number>();
  const byStateReport: { state: string; registered: number; declaredCoverage: number; uncovered: number; membersCovering: number }[] = [];
  let unattributedStates = 0;
  let declaredCoverageTotal = 0;
  let uncoveredTotal = 0;
  if (roster) {
    for (const s of activeSnaps) declaredCoverageTotal += s.totalRetailers ?? 0;
    for (const [state, registeredCount] of roster.registeredByState) {
      const members = membersByState.get(state) ?? [];
      const declared = members.reduce((a, m) => a + (m.totalRetailers ?? 0), 0);
      const uncovered = Math.max(0, registeredCount - declared);
      uncoveredTotal += uncovered;
      byStateReport.push({ state, registered: registeredCount, declaredCoverage: declared, uncovered, membersCovering: members.length });
      if (members.length === 0) { if (uncovered > 0) unattributedStates++; continue; }
      if (uncovered === 0) continue;
      const baseSum = members.reduce((a, m) => a + (baselineByMember.get(m.normKey)?.total ?? 0), 0);
      for (const m of members) {
        const share = baseSum > 0
          ? (baselineByMember.get(m.normKey)?.total ?? 0) / baseSum
          : 1 / members.length;
        uncoveredShare.set(m.normKey, (uncoveredShare.get(m.normKey) ?? 0) + uncovered * share);
      }
    }
    byStateReport.sort((a, b) => b.uncovered - a.uncovered);
  }

  // ── Company codes count (new-SKU candidate space) ──
  const codesRes = await db.execute(sql`
    SELECT count(DISTINCT item_code)::int AS n FROM secondary_sku_line WHERE fy = ${baselineFy}`);
  const companyCodes = Number(((((codesRes as any).rows ?? codesRes) as any[])[0]).n);

  // ── Bottom-up member rows ──
  const wOld = weights.oldSku / 100, wNew = weights.newSku / 100, wCust = weights.newCustomers / 100;
  const memberRows: PersonRow[] = [];
  const leftExcluded: string[] = [];

  // Peer medians for fallbacks: bottom-up combined of members with a sound base.
  const soundCombined: { state: string; combined: number }[] = [];
  for (const s of activeSnaps) {
    const mb = baselineByMember.get(s.normKey);
    if (mb && mb.retailers >= MIN_RETAILER_BASE && mb.total > 0) {
      soundCombined.push({ state: (s.state || "UNKNOWN").toUpperCase(), combined: mb.total * (1 + inc) });
    }
  }
  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const nationalMedian = median(soundCombined.map((x) => x.combined));
  const workingDaysList = activeSnaps.map((s) => s.workingDaysActual).filter((w): w is number => w != null && w > 0);
  const medianWorkingDays = median(workingDaysList) ?? null;
  const maxElapsed = Math.max(0, ...activeSnaps.map((s) => s.elapsedMonths ?? 0));

  let totalOldPairs = 0, totalNewCandidates = 0;
  const zeroMoved: string[] = []; let zeroMovedTotal = 0;

  // Fallback chain — guaranteed nonzero as long as anyone in the company has a
  // baseline: state median (≥3 sound peers) → national median → per-capita
  // share of the attributed company baseline.
  const perCapita = activeSnaps.length > 0 ? (attributedTotal * (1 + inc)) / activeSnaps.length : 0;
  const fallbackTarget = (state: string, reason: string): { value: number; basis: string } => {
    const peers = soundCombined.filter((x) => x.state === state).map((x) => x.combined);
    if (peers.length >= 3) {
      const m = median(peers);
      if (m != null && m > 0) return { value: m, basis: `state median (${peers.length} peers in ${state}) — ${reason}` };
    }
    if (nationalMedian != null && nationalMedian > 0) {
      return { value: nationalMedian, basis: `national median (${soundCombined.length} peers) — ${reason}` };
    }
    return { value: perCapita, basis: `per-capita share of the company baseline — ${reason}` };
  };

  for (const s of snapshots) {
    const mb = baselineByMember.get(s.normKey) ?? null;
    const flags: PersonFlag[] = [];
    const state = (s.state || "UNKNOWN").toUpperCase();

    // Guard (c): LEFT members get no target. History preserved on the row.
    if (s.isLeft) {
      leftExcluded.push(s.name);
      memberRows.push({
        type: "member", name: s.name, key: s.normKey, stateHead: s.stateHead, state,
        baseline: mb?.total ?? 0, baselineRetailers: mb?.retailers ?? 0, oldSkuPairs: mb?.pairs ?? 0,
        uncoveredAllocated: 0,
        oldSkuTarget: null, newSkuTarget: null, newCustomerTarget: null, combined: null,
        engineProposed: null, source: "none", userFilled: null, difference: null,
        hadTarget: (s.totalTargetToDate ?? 0) > 0,
        monthlySplit: null, splitBasis: null, fallbackBasis: null,
        flags: [{ kind: "left", detail: "left the company — no target generated; history preserved" }],
      });
      continue;
    }

    let combined: number;
    let fallbackBasis: string | null = null;

    if (mb && mb.total > 0 && mb.retailers >= MIN_RETAILER_BASE) {
      // Bottom-up from the member's own retailer × code history.
      combined = mb.total * (1 + inc);
    } else if (mb && mb.total > 0) {
      // Guard (b): a base of 1–9 retailers is not a distribution — peer median.
      const fb = fallbackTarget(state, `own base of ${mb.retailers} retailer(s) is too thin`);
      combined = fb.value;
      fallbackBasis = fb.basis;
      flags.push({ kind: "fallback", detail: fallbackBasis });
      flags.push({ kind: "thinBase", detail: `${mb.retailers} retailer(s), ₹${(mb.total / 1e5).toFixed(1)} L baseline` });
    } else {
      // Guard (d): new member with no FY baseline — peer median, never zero.
      const fb = fallbackTarget(state, `no FY${baselineFy} history`);
      combined = fb.value;
      fallbackBasis = fb.basis;
      flags.push({ kind: "newMember", detail: `no FY${baselineFy} secondary history` });
      flags.push({ kind: "fallback", detail: fallbackBasis });
    }

    // Guard (e): pro-rate a first-year target by expected tenure.
    if (fallbackBasis && maxElapsed > 0 && s.elapsedMonths != null && s.elapsedMonths < maxElapsed) {
      const expectedMonths = Math.max(1, 12 - (maxElapsed - s.elapsedMonths));
      combined = combined * (expectedMonths / 12);
      flags.push({ kind: "proRated", detail: `pro-rated to ${expectedMonths}/12 months (joined ~${maxElapsed - s.elapsedMonths} month(s) into the year)` });
    } else if (fallbackBasis && s.workingDaysActual != null && medianWorkingDays && s.workingDaysActual < medianWorkingDays / 2) {
      const factor = Math.max(0.25, s.workingDaysActual / medianWorkingDays);
      combined = combined * factor;
      flags.push({ kind: "proRated", detail: `pro-rated ×${factor.toFixed(2)} (${s.workingDaysActual} working days vs peer median ${Math.round(medianWorkingDays)})` });
    }

    // Populations
    totalOldPairs += mb?.pairs ?? 0;
    if (mb) totalNewCandidates += mb.retailers * companyCodes - mb.pairs;

    // Guard (a): zero-target members who now receive a generated figure.
    const hadTarget = (s.totalTargetToDate ?? 0) > 0;
    if (!hadTarget && combined > 0) {
      zeroMoved.push(s.name);
      zeroMovedTotal += combined;
      flags.push({ kind: "gainedTarget", detail: "had no target recorded — now receives a generated figure from own history" });
    }

    // Overrides — the EFFECTIVE combined drives the route split, so an edited
    // figure reflows into old-SKU / new-SKU / new-customer (and head sums).
    const ov = overrides.get(`secmember|${s.normKey}`);
    const userValue = ov ? Number((ov.value as any)?.combined ?? ov.value) : null;
    const effective = userValue ?? combined;

    // Route split of the effective figure: baseline stays inside the old-SKU
    // route; growth splits by the weights. A member with NO uncovered
    // retailers allocated in their state gets no new-customer route — that
    // weight moves to new-SKU, and the row says so.
    const uncoveredAllocated = Math.round(uncoveredShare.get(s.normKey) ?? 0);
    let mwOld = wOld, mwNew = wNew, mwCust = wCust;
    if (uncoveredAllocated === 0 && wCust > 0) {
      mwNew = wNew + wCust; mwCust = 0;
      flags.push({ kind: "noPool", detail: "no uncovered retailers in their state to win — new-customer growth reassigned to new SKUs" });
    }
    const base = fallbackBasis ? effective / (1 + inc) : Math.min(mb?.total ?? 0, effective);
    const growth = Math.max(0, effective - base);
    const oldSkuTarget = base + growth * mwOld;
    const newSkuTarget = growth * mwNew;
    const newCustomerTarget = growth * mwCust;

    // Monthly split from own segment mix
    const curve = mb ? personCurve(mb.bySegment, curves) : { split: [...FLAT_CURVE], basis: "flat (no baseline history — fallback target)" };

    const userFilled = s.monthlyTarget != null ? s.monthlyTarget * 12 : null;

    memberRows.push({
      type: "member", name: s.name, key: s.normKey, stateHead: s.stateHead, state,
      baseline: mb?.total ?? 0, baselineRetailers: mb?.retailers ?? 0, oldSkuPairs: mb?.pairs ?? 0,
      uncoveredAllocated,
      oldSkuTarget: round0(oldSkuTarget), newSkuTarget: round0(newSkuTarget),
      newCustomerTarget: round0(newCustomerTarget),
      combined: round0(effective),
      engineProposed: userValue != null ? round0(combined) : null,
      source: userValue != null ? "user" : "generated",
      userFilled: userFilled != null ? round0(userFilled) : null,
      difference: userFilled != null ? round0(effective - userFilled) : null,
      hadTarget,
      monthlySplit: curve.split.map((v) => Math.round(v * 10000) / 10000),
      splitBasis: curve.basis,
      fallbackBasis,
      flags,
    });
  }

  // ── Head rows = sum of members; flag when an override differs from the sum ──
  const headRows: PersonRow[] = [];
  const byHead = new Map<string, PersonRow[]>();
  for (const r of memberRows) {
    if (!byHead.has(r.stateHead)) byHead.set(r.stateHead, []);
    byHead.get(r.stateHead)!.push(r);
  }
  for (const [head, members] of byHead) {
    const active = members.filter((m) => m.combined != null);
    const sum = active.reduce((a, m) => a + (m.combined ?? 0), 0);
    const headKey = normSecKey(head);
    const ov = overrides.get(`sechead|${headKey}`);
    const userValue = ov ? Number((ov.value as any)?.combined ?? ov.value) : null;
    const flags: PersonFlag[] = [];
    if (userValue != null && Math.abs(userValue - sum) > 1) {
      flags.push({ kind: "sumMismatch", detail: `head figure ₹${(userValue / 1e7).toFixed(2)} Cr differs from the sum of members ₹${(sum / 1e7).toFixed(2)} Cr` });
    }
    const allFallback = active.length > 0 && active.every((m) => m.fallbackBasis != null);
    if (allFallback) {
      flags.push({ kind: "fallback", detail: "every member figure under this head is a labelled fallback — read the head total accordingly" });
    }
    const userFilledSum = members.reduce((a, m) => a + (m.userFilled ?? 0), 0);
    const states = [...new Set(members.map((m) => m.state))];
    headRows.push({
      type: "head", name: head, key: headKey, stateHead: head,
      state: states.length === 1 ? states[0] : `${states.length} states`,
      baseline: members.reduce((a, m) => a + m.baseline, 0),
      baselineRetailers: members.reduce((a, m) => a + m.baselineRetailers, 0),
      oldSkuPairs: members.reduce((a, m) => a + m.oldSkuPairs, 0),
      uncoveredAllocated: members.reduce((a, m) => a + m.uncoveredAllocated, 0),
      oldSkuTarget: round0(active.reduce((a, m) => a + (m.oldSkuTarget ?? 0), 0)),
      newSkuTarget: round0(active.reduce((a, m) => a + (m.newSkuTarget ?? 0), 0)),
      newCustomerTarget: round0(active.reduce((a, m) => a + (m.newCustomerTarget ?? 0), 0)),
      combined: round0(userValue ?? sum),
      engineProposed: userValue != null ? round0(sum) : null,
      source: userValue != null ? "user" : "generated",
      userFilled: userFilledSum > 0 ? round0(userFilledSum) : null,
      difference: userFilledSum > 0 ? round0((userValue ?? sum) - userFilledSum) : null,
      hadTarget: members.some((m) => m.hadTarget),
      monthlySplit: null, splitBasis: "sum of members (each on their own curve)",
      fallbackBasis: allFallback ? "all members on fallback medians" : null,
      flags,
    });
  }

  // ── Implied company total + visible scaling ──
  const impliedCompanyTotal = memberRows.reduce((a, m) => a + (m.combined ?? 0), 0);
  const scaleTo = opts.scaleTo ?? null;
  const factor = scaleTo != null && impliedCompanyTotal > 0 ? scaleTo / impliedCompanyTotal : null;
  const rows = [...headRows, ...memberRows];
  if (factor != null) {
    for (const r of rows) r.scaledCombined = r.combined != null ? round0(r.combined * factor) : null;
  }
  rows.sort((a, b) => (b.combined ?? -1) - (a.combined ?? -1));

  return {
    basis: "secondary",
    basisNote: "Salesperson and State Head targets are computed on the SECONDARY register (retailer → distributor) — the only measure carrying a salesperson name. The company/distributor engine stays on the PRIMARY basis; the two are different populations and will not reconcile.",
    fy, baselineFy,
    params: { increasePct, weights },
    baseline: {
      skuLineTotal: round0(skuLineTotal),
      registerTotal: round0(registerTotal),
      deltaPct: registerTotal > 0 ? Math.round(((skuLineTotal - registerTotal) / registerTotal) * 10000) / 100 : 0,
      lines: Number(sku.n),
      attributedTotal: round0(attributedTotal),
      unattributedTotal: round0(unattributedTotal),
      unattributedHeads,
    },
    populations: {
      oldSkuPairs: totalOldPairs,
      newSkuCandidatePairs: totalNewCandidates,
      newCustomers: {
        registeredRetailers: roster?.registered ?? 0,
        declaredCoverage: declaredCoverageTotal,
        idVerifiedCoverage: roster?.idVerifiedCovered ?? 0,
        uncoveredRetailers: uncoveredTotal,
        note: "declared coverage is a non-deduplicated sum of each member's retailer count, so the true coverage is lower and the uncovered pool is a minimum",
        byState: byStateReport.slice(0, 40),
        unattributedStates,
      },
    },
    zeroTargetMoved: { count: zeroMoved.length, names: zeroMoved, totalGenerated: round0(zeroMovedTotal) },
    leftMembersExcluded: leftExcluded,
    impliedCompanyTotal: round0(impliedCompanyTotal),
    scaling: { requested: scaleTo, factor: factor != null ? Math.round(factor * 10000) / 10000 : null },
    rows,
  };
}

function round0(n: number): number { return Math.round(n); }
