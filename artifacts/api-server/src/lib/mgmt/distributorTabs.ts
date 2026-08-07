/**
 * Distributor Deep Dive — three analysis tabs + the vocabulary reconciliation
 * that underpins them.
 *
 * TWO DISTRIBUTOR VOCABULARIES:
 *   A. Member working sheets (the deep-dive / directory names, 190 entries)
 *   B. Primary register (sale_line.customer, ~513 raw names in FY26-27)
 * The secondary item-code register (secondary_sku_line.distributor) uses the
 * sheet vocabulary (~96% by value) so it joins on normDistKey directly.
 *
 * IDENTITY RULE (never violated):
 *   Same distributor only if the name matches (normDistKey, optionally after
 *   stripping ONE trailing parenthetical location suffix) AND the state
 *   agrees AND the pair does not appear as separate transacting rows for the
 *   same period. NEVER merged on similarity alone — similar names go to a
 *   needs-confirmation list with each side's state, district and value.
 *   Pairs where BOTH sides transact in the same period are auto-flagged
 *   RESOLVED-DIFFERENT (positive proof of two entities).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  normDistKey,
  jaccardTrigram,
  prevFyLabel,
  toPriorYearMonths,
} from "./distributorDeepDive.js";
import { loadDistributorDirectory } from "./distributorDirectory.js";
import { normaliseStateCanon } from "../stateCanon.js";
import { getSkuPushList, type PushListResult } from "../sku/skuPushList.js";
import { computeCategoryMultipliers } from "../customers/laspeyres.js";
import { logger } from "../logger.js";

// ── State compatibility (sale_line vocab vs sheet vocab) ─────────────────────

/** Sheet-side territory names that are supersets/renames of geographic states. */
const NORTH_EAST_STATES = new Set([
  "ASSAM", "MEGHALAYA", "TRIPURA", "MANIPUR", "MIZORAM", "NAGALAND",
  "ARUNACHAL PRADESH", "SIKKIM", "NORTH EAST",
]);

/** True when a sale_line state and a sheet state can refer to the same place.
 *  A compatible state removes a disproof; it is NOT evidence of sameness. */
/** True when the register row carries a real geographic state (not blank, not NON-*). */
export function hasGeoState(saleState: string | null): boolean {
  if (!saleState || saleState.trim() === "") return false;
  const s = normaliseStateCanon(saleState.toUpperCase().trim()) ?? "";
  return s !== "" && !s.startsWith("NON-");
}

export function statesCompatible(saleState: string | null, sheetStates: string[]): boolean {
  if (!saleState || saleState.trim() === "") return true; // no state info → cannot disprove
  const s = normaliseStateCanon(saleState.toUpperCase().trim()) ?? "";
  if (s.startsWith("NON-")) return true;
  return sheetStates.some((raw) => {
    const t = normaliseStateCanon(raw.toUpperCase().trim()) ?? "";
    if (s === t) return true;
    // Register says the geographic state; sheets split UP into territories.
    if (s === "UTTAR PRADESH" && (t === "EAST U.P" || t === "WEST U.P")) return true;
    if ((s === "EAST U.P" || s === "WEST U.P") && t === "UTTAR PRADESH") return true;
    // Sheets use the NORTH EAST territory for the seven-sister states.
    if (t === "NORTH EAST" && NORTH_EAST_STATES.has(s)) return true;
    if (s === "NORTH EAST" && NORTH_EAST_STATES.has(t)) return true;
    return false;
  });
}

/** Strip ONE trailing parenthetical suffix: "MITTAL AGENCIES (Patna)" → "MITTAL AGENCIES".
 *  Also tolerates an unclosed trailing bracket ("GORAKHPUR MARBLE WORKS (GORAKHPUR"). */
export function stripLocationSuffix(raw: string): string {
  const m = /^(.*?)\s*\(([^)]*)\)?\s*$/.exec(raw.trim());
  return m && m[1].trim().length >= 3 ? m[1].trim() : raw.trim();
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export type ReconCandidate = {
  saleName: string;
  saleState: string | null;
  saleDistrict: string | null;   // sale_line.station
  saleValue: number;             // FY primary net
  saleMonths: string[];
  sheetName: string;
  sheetNormKey: string;
  sheetStates: string[];
  sheetHeads: string[];
  sheetPrimaryValue: number;     // primary value already matched to this sheet distributor
  sheetMonths: string[];         // months where the matched counterpart transacts
  similarity: number;            // jaccard trigram on norm keys
  /** Both sides transact in the same period → positive proof of two entities. */
  resolvedDifferent: boolean;
  overlapMonths: string[];
};

export type DistributorRecon = {
  fy: string;
  sheetDistributors: number;
  saleCustomers: number;          // distinct raw primary customers
  saleTerritoryValue: number;     // ₹, is_territory only
  saleTotalValue: number;
  exactMatches: number;           // raw name equality (case/trim-insensitive)
  normMatches: number;            // normDistKey equality
  matchedCustomers: number;       // after suffix rule + state agreement
  matchedSheetKeys: number;
  matchedValue: number;           // territory ₹ attributed to a sheet distributor
  unmatchedValue: number;         // territory ₹ NOT attributable — must be shown prominently
  unmatchedPct: number;           // of territory value
  /** normKey → matched raw sale_line customer names. */
  saleNamesByKey: Record<string, string[]>;
  /** Similar-name pairs. NEVER merged — human confirmation required. */
  needsConfirmation: ReconCandidate[];
  resolvedDifferent: ReconCandidate[];
  /** Unmatched territory customers by value (top 50). */
  unmatchedTop: { name: string; state: string | null; district: string | null; value: number }[];
  /** Sheet distributors with zero matched primary purchases this FY. */
  sheetNoPrimary: { name: string; normKey: string; states: string[] }[];
  secondaryMatchedValue: number;  // secondary_sku_line ₹ joined by normKey
  secondaryTotalValue: number;
  /** normKey → raw secondary_sku_line.distributor names. */
  secondaryNamesByKey: Record<string, string[]>;
  monthsLoaded: string[];         // secondary months present for the FY (coverage note)
  builtAt: number;
};

const reconCache = new Map<string, { v: DistributorRecon; until: number }>();
const RECON_TTL_MS = 15 * 60_000;

export async function buildDistributorRecon(fy: string): Promise<DistributorRecon> {
  const hit = reconCache.get(fy);
  if (hit && Date.now() < hit.until) return hit.v;

  const dir = await loadDistributorDirectory(fy);
  const sheet = dir.distributors.map((d) => ({
    name: d.name,
    normKey: d.normKey,
    states: d.states,
    heads: d.heads,
  }));
  const sheetByNorm = new Map(sheet.map((d) => [d.normKey, d]));

  // Primary register: distinct customers with value, state, district, months.
  const saleRows = await db.execute<{
    customer: string; value: string; total_value: string; state: string | null; district: string | null;
    terr: boolean; months: string[];
  }>(sql`
    SELECT customer,
           COALESCE(SUM(amount::numeric) FILTER (WHERE is_territory), 0)::text AS value,
           SUM(amount::numeric)::text AS total_value,
           MAX(NULLIF(BTRIM(COALESCE(state_canon,'')),'')) AS state,
           MAX(NULLIF(BTRIM(COALESCE(station,'')),''))     AS district,
           BOOL_OR(is_territory) AS terr,
           ARRAY_AGG(DISTINCT month_label) AS months
    FROM sale_line_current
    WHERE fy = ${fy} AND customer IS NOT NULL AND BTRIM(customer) <> ''
    GROUP BY customer
  `);

  type SaleCust = {
    raw: string; value: number; totalValue: number; state: string | null; district: string | null;
    terr: boolean; months: string[]; norm: string; baseNorm: string;
  };
  const sale: SaleCust[] = saleRows.rows.map((r) => ({
    raw: r.customer,
    value: parseFloat(r.value) || 0, // territory-only ₹ — every recon figure uses this
    totalValue: parseFloat(r.total_value) || 0,
    state: r.state,
    district: r.district,
    terr: r.terr,
    months: r.months ?? [],
    norm: normDistKey(r.customer),
    baseNorm: normDistKey(stripLocationSuffix(r.customer)),
  }));

  const sheetRawUpper = new Set(sheet.map((d) => d.name.trim().toUpperCase()));

  let exactMatches = 0, normMatches = 0, matchedCustomers = 0;
  let saleTerritoryValue = 0, saleTotalValue = 0, matchedValue = 0;
  const saleNamesByKey: Record<string, string[]> = {};
  const matchedMonthsByKey = new Map<string, Set<string>>();
  const matchedValueByKey = new Map<string, number>();
  const unmatched: SaleCust[] = [];

  for (const s of sale) {
    saleTotalValue += s.totalValue;
    if (s.terr) saleTerritoryValue += s.value;
    if (sheetRawUpper.has(s.raw.trim().toUpperCase())) exactMatches++;
    if (sheetByNorm.has(s.norm)) normMatches++;

    // Identity rule: exact-norm matches may lean on "no state info = no
    // disproof"; suffix-stripped matches are weaker and REQUIRE a known,
    // geographically compatible state.
    const dNorm = sheetByNorm.get(s.norm);
    const dBase = sheetByNorm.get(s.baseNorm);
    let d: typeof dNorm | undefined;
    if (dNorm && statesCompatible(s.state, dNorm.states)) d = dNorm;
    else if (dBase && hasGeoState(s.state) && statesCompatible(s.state, dBase.states)) d = dBase;
    if (d) {
      matchedCustomers++;
      if (s.terr) matchedValue += s.value;
      (saleNamesByKey[d.normKey] ??= []).push(s.raw);
      matchedValueByKey.set(d.normKey, (matchedValueByKey.get(d.normKey) ?? 0) + s.value);
      let ms = matchedMonthsByKey.get(d.normKey);
      if (!ms) matchedMonthsByKey.set(d.normKey, (ms = new Set()));
      for (const m of s.months) ms.add(m);
    } else {
      unmatched.push(s);
    }
  }

  // Similar-name candidates among unmatched territory customers — NEVER merged.
  const needsConfirmation: ReconCandidate[] = [];
  const resolvedDifferent: ReconCandidate[] = [];
  for (const s of unmatched) {
    if (!s.terr) continue;
    let best: { d: (typeof sheet)[number]; sim: number } | null = null;
    for (const d of sheet) {
      const sim = Math.max(
        jaccardTrigram(s.norm, d.normKey),
        jaccardTrigram(s.baseNorm, d.normKey),
      );
      if (sim > 0.6 && (!best || sim > best.sim)) best = { d, sim };
    }
    if (!best) continue;
    const counterpartMonths = [...(matchedMonthsByKey.get(best.d.normKey) ?? [])];
    const overlap = s.months.filter((m) => counterpartMonths.includes(m));
    const cand: ReconCandidate = {
      saleName: s.raw,
      saleState: s.state,
      saleDistrict: s.district,
      saleValue: s.value,
      saleMonths: sortMonths(s.months),
      sheetName: best.d.name,
      sheetNormKey: best.d.normKey,
      sheetStates: best.d.states,
      sheetHeads: best.d.heads,
      sheetPrimaryValue: matchedValueByKey.get(best.d.normKey) ?? 0,
      sheetMonths: sortMonths(counterpartMonths),
      similarity: Math.round(best.sim * 1000) / 1000,
      resolvedDifferent: overlap.length > 0,
      overlapMonths: overlap.sort(),
    };
    (cand.resolvedDifferent ? resolvedDifferent : needsConfirmation).push(cand);
  }
  needsConfirmation.sort((a, b) => b.saleValue - a.saleValue);
  resolvedDifferent.sort((a, b) => b.saleValue - a.saleValue);

  const unmatchedTerr = unmatched.filter((s) => s.terr).sort((a, b) => b.value - a.value);
  const unmatchedValue = unmatchedTerr.reduce((a, b) => a + b.value, 0);

  // Secondary register join (sheet vocabulary — direct normKey join).
  const secRows = await db.execute<{ distributor: string; value: string }>(sql`
    SELECT distributor, SUM(net_amount::numeric)::text AS value
    FROM secondary_sku_line
    WHERE fy = ${fy} AND distributor IS NOT NULL AND BTRIM(distributor) <> ''
    GROUP BY distributor
  `);
  const secondaryNamesByKey: Record<string, string[]> = {};
  let secondaryMatchedValue = 0, secondaryTotalValue = 0;
  for (const r of secRows.rows) {
    const v = parseFloat(r.value) || 0;
    secondaryTotalValue += v;
    const k = normDistKey(r.distributor);
    if (sheetByNorm.has(k)) {
      secondaryMatchedValue += v;
      (secondaryNamesByKey[k] ??= []).push(r.distributor);
    }
  }

  const monthRows = await db.execute<{ m: string }>(sql`
    SELECT DISTINCT month_label AS m FROM secondary_sku_line WHERE fy = ${fy}
  `);
  const monthsLoaded = sortMonths(monthRows.rows.map((r) => r.m));

  const recon: DistributorRecon = {
    fy,
    sheetDistributors: sheet.length,
    saleCustomers: sale.length,
    saleTerritoryValue,
    saleTotalValue,
    exactMatches,
    normMatches,
    matchedCustomers,
    matchedSheetKeys: Object.keys(saleNamesByKey).length,
    matchedValue,
    unmatchedValue,
    unmatchedPct: saleTerritoryValue > 0 ? (unmatchedValue / saleTerritoryValue) * 100 : 0,
    saleNamesByKey,
    needsConfirmation: needsConfirmation.slice(0, 60),
    resolvedDifferent: resolvedDifferent.slice(0, 60),
    unmatchedTop: unmatchedTerr.slice(0, 50).map((s) => ({
      name: s.raw, state: s.state, district: s.district, value: s.value,
    })),
    sheetNoPrimary: sheet
      .filter((d) => !saleNamesByKey[d.normKey])
      .map((d) => ({ name: d.name, normKey: d.normKey, states: d.states })),
    secondaryMatchedValue,
    secondaryTotalValue,
    secondaryNamesByKey,
    monthsLoaded,
    builtAt: Date.now(),
  };
  reconCache.set(fy, { v: recon, until: Date.now() + RECON_TTL_MS });
  return recon;
}

// ── Month helpers ─────────────────────────────────────────────────────────────

const MONTH_ORDER = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
function monthIdx(label: string): number {
  return MONTH_ORDER.indexOf(label.slice(0, 3));
}
export function sortMonths(months: string[]): string[] {
  return [...new Set(months)].sort((a, b) => monthIdx(a) - monthIdx(b));
}
function quarterOf(label: string): "Q1" | "Q2" | "Q3" | "Q4" {
  const i = monthIdx(label);
  return i < 3 ? "Q1" : i < 6 ? "Q2" : i < 9 ? "Q3" : "Q4";
}

// ── Tab 1: Secondary sales + flow gap at item-code level ─────────────────────

export type FlowGapCode = {
  code: string;
  group: string | null;           // primary register group_canon (shared code vocab)
  primaryInQty: number;
  primaryInValue: number;         // source: primary register (sale_line)
  secondaryOutQty: number;
  secondaryOutValue: number;      // source: secondary register (secondary_sku_line)
  gapValue: number;               // primary in − secondary out
  /** Primary in is material and secondary out is near zero — stock sitting still
   *  OR business moving outside the attributed channel (indistinguishable:
   *  no stock statements exist). */
  flagged: boolean;
};

export type SecondaryTabResult = {
  fy: string;
  distributor: { name: string; normKey: string };
  monthsLoaded: string[];         // derived, never hardcoded
  coverageNote: string;
  // headline (source: secondary register, item-code level)
  netAmount: number;
  grossAmount: number;
  effectiveDiscountPct: number | null;
  retailerCount: number;
  activeRetailerCount: number;    // net > 0 in the loaded months
  codeCount: number;
  segments: { segment: string; net: number; qty: number; codes: number }[];
  monthly: { month: string; net: number; retailers: number }[];
  topRetailers: { name: string; net: number; sharePct: number; salesperson: string | null }[];
  top5SharePct: number | null;
  // flow gap
  primaryMatched: boolean;        // false → no primary vocabulary match; gap not computable
  primarySaleNames: string[];     // which sale_line customers back "primary in"
  primaryInTotal: number;
  secondaryOutTotal: number;
  flowGapTotal: number | null;
  flowGapBySegment: { segment: string; primaryIn: number; secondaryOut: number; gap: number }[];
  flowGapByCode: FlowGapCode[];   // sorted by |gap| desc, flagged first
  flaggedCodes: number;
  unattributedNote: string;       // the prominent unmatched-value statement
};

/** Optional month-label restriction ("" = whole FY). Appends AND month_label IN (...). */
function monthCond(months: string[] | null | undefined) {
  return months && months.length > 0
    ? sql` AND month_label IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)})`
    : sql``;
}

export async function buildSecondaryTab(
  fy: string,
  distKey: string,
  months: string[] | null = null,
): Promise<SecondaryTabResult> {
  const recon = await buildDistributorRecon(fy);
  const dir = await loadDistributorDirectory(fy);
  const d = dir.distributors.find((x) => x.normKey === distKey);
  if (!d) throw new Error(`Unknown distributor key: ${distKey}`);

  const secNames = recon.secondaryNamesByKey[distKey] ?? [];
  const saleNames = recon.saleNamesByKey[distKey] ?? [];

  // Secondary rows for this distributor (item-code register).
  const secAgg = secNames.length === 0 ? { rows: [] as any[] } : await db.execute<{
    item_code: string; segment: string | null; month_label: string;
    retailer: string | null; head: string | null;
    qty: string; net: string; gross: string;
  }>(sql`
    SELECT item_code, segment_canon AS segment, month_label, retailer, head_canon AS head,
           SUM(qty::numeric)::text AS qty,
           SUM(net_amount::numeric)::text AS net,
           SUM(gross_amount::numeric)::text AS gross
    FROM secondary_sku_line
    WHERE fy = ${fy} AND distributor IN (${sql.join(secNames.map((n) => sql`${n}`), sql`, `)})${monthCond(months)}
    GROUP BY item_code, segment_canon, month_label, retailer, head_canon
  `);

  let net = 0, gross = 0;
  const byMonth = new Map<string, { net: number; retailers: Set<string> }>();
  const bySeg = new Map<string, { net: number; qty: number; codes: Set<string> }>();
  const byRetailer = new Map<string, { net: number; salesperson: string | null }>();
  const secByCode = new Map<string, { qty: number; net: number; segment: string | null }>();
  for (const r of secAgg.rows) {
    const rNet = parseFloat(r.net) || 0, rGross = parseFloat(r.gross) || 0, rQty = parseFloat(r.qty) || 0;
    net += rNet; gross += rGross;
    let m = byMonth.get(r.month_label);
    if (!m) byMonth.set(r.month_label, (m = { net: 0, retailers: new Set() }));
    m.net += rNet;
    if (r.retailer) m.retailers.add(r.retailer);
    const seg = r.segment ?? "Unmapped";
    let s = bySeg.get(seg);
    if (!s) bySeg.set(seg, (s = { net: 0, qty: 0, codes: new Set() }));
    s.net += rNet; s.qty += rQty; s.codes.add(r.item_code);
    if (r.retailer) {
      let ret = byRetailer.get(r.retailer);
      if (!ret) byRetailer.set(r.retailer, (ret = { net: 0, salesperson: null }));
      ret.net += rNet;
      if (r.head) ret.salesperson = r.head;
    }
    let c = secByCode.get(r.item_code);
    if (!c) secByCode.set(r.item_code, (c = { qty: 0, net: 0, segment: r.segment }));
    c.qty += rQty; c.net += rNet;
  }

  // Primary in per code, restricted to the matched vocabulary — attribution is
  // only as good as the reconciliation; unmatched value is stated, not hidden.
  const priByCode = new Map<string, { qty: number; value: number; group: string | null }>();
  if (saleNames.length > 0) {
    const priRows = await db.execute<{ code: string; grp: string | null; qty: string; value: string }>(sql`
      SELECT code, MAX(group_canon) AS grp,
             SUM(qty::numeric)::text AS qty,
             SUM(amount::numeric)::text AS value
      FROM sale_line_current
      WHERE fy = ${fy} AND code IS NOT NULL AND is_territory = true
        AND customer IN (${sql.join(saleNames.map((n) => sql`${n}`), sql`, `)})${monthCond(months)}
      GROUP BY code
    `);
    for (const r of priRows.rows) {
      priByCode.set(r.code, {
        qty: parseFloat(r.qty) || 0,
        value: parseFloat(r.value) || 0,
        group: r.grp,
      });
    }
  }

  // Map secondary codes to the primary group vocabulary where the code exists there.
  const allCodes = [...new Set([...priByCode.keys(), ...secByCode.keys()])];
  const flowGapByCode: FlowGapCode[] = allCodes.map((code) => {
    const p = priByCode.get(code);
    const s = secByCode.get(code);
    const primaryInValue = p?.value ?? 0;
    const secondaryOutValue = s?.net ?? 0;
    return {
      code,
      group: p?.group ?? s?.segment ?? null,
      primaryInQty: p?.qty ?? 0,
      primaryInValue,
      secondaryOutQty: s?.qty ?? 0,
      secondaryOutValue,
      gapValue: primaryInValue - secondaryOutValue,
      // material in (≥ ₹1 L) with out < 10% of in → stock sitting still, or
      // business moving outside the attributed channel.
      flagged: primaryInValue >= 100_000 && secondaryOutValue < primaryInValue * 0.1,
    };
  });
  flowGapByCode.sort((a, b) =>
    (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0) || Math.abs(b.gapValue) - Math.abs(a.gapValue));

  const segGap = new Map<string, { primaryIn: number; secondaryOut: number }>();
  for (const c of flowGapByCode) {
    const g = c.group ?? "Unmapped";
    let e = segGap.get(g);
    if (!e) segGap.set(g, (e = { primaryIn: 0, secondaryOut: 0 }));
    e.primaryIn += c.primaryInValue;
    e.secondaryOut += c.secondaryOutValue;
  }

  const primaryInTotal = [...priByCode.values()].reduce((a, b) => a + b.value, 0);
  const topRet = [...byRetailer.entries()].sort((a, b) => b[1].net - a[1].net);
  const top5 = topRet.slice(0, 5).reduce((a, [, v]) => a + v.net, 0);
  const monthsLoaded = months && months.length > 0
    ? recon.monthsLoaded.filter((m) => months.includes(m))
    : recon.monthsLoaded;

  return {
    fy,
    distributor: { name: d.name, normKey: distKey },
    monthsLoaded,
    coverageNote: months && months.length > 0
      ? `Filtered to selected period ${months[0]}–${months[months.length - 1]} (${monthsLoaded.length} of ${months.length} selected month${months.length === 1 ? "" : "s"} present in the secondary register)`
      : monthsLoaded.length > 0
      ? `Secondary register covers ${monthsLoaded[0]}–${monthsLoaded[monthsLoaded.length - 1]} (${monthsLoaded.length} month${monthsLoaded.length === 1 ? "" : "s"} loaded)`
      : "No secondary register months loaded for this FY",
    netAmount: net,
    grossAmount: gross,
    effectiveDiscountPct: gross > 0 ? ((gross - net) / gross) * 100 : null,
    retailerCount: byRetailer.size,
    activeRetailerCount: [...byRetailer.values()].filter((r) => r.net > 0).length,
    codeCount: secByCode.size,
    segments: [...bySeg.entries()]
      .map(([segment, v]) => ({ segment, net: v.net, qty: v.qty, codes: v.codes.size }))
      .sort((a, b) => b.net - a.net),
    monthly: sortMonths([...byMonth.keys()]).map((m) => ({
      month: m,
      net: byMonth.get(m)!.net,
      retailers: byMonth.get(m)!.retailers.size,
    })),
    topRetailers: topRet.slice(0, 10).map(([name, v]) => ({
      name,
      net: v.net,
      sharePct: net > 0 ? (v.net / net) * 100 : 0,
      salesperson: v.salesperson,
    })),
    top5SharePct: net > 0 ? (top5 / net) * 100 : null,
    primaryMatched: saleNames.length > 0,
    primarySaleNames: saleNames,
    primaryInTotal,
    secondaryOutTotal: net,
    flowGapTotal: saleNames.length > 0 ? primaryInTotal - net : null,
    flowGapBySegment: [...segGap.entries()]
      .map(([segment, v]) => ({ segment, primaryIn: v.primaryIn, secondaryOut: v.secondaryOut, gap: v.primaryIn - v.secondaryOut }))
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)),
    flowGapByCode: flowGapByCode.slice(0, 200),
    flaggedCodes: flowGapByCode.filter((c) => c.flagged).length,
    unattributedNote: `${recon.unmatchedPct.toFixed(1)}% of FY ${fy} territory primary value (₹${(recon.unmatchedValue / 1e7).toFixed(2)} Cr) is not attributable to any sheet distributor; figures joining the two registers cover matched names only.`,
  };
}

/** Map one FY's register names to a single sheet distributor key using the
 *  identity rule (norm / suffix-stripped name + state agreement). Cheap: two
 *  SQL scans, no directory build for the target FY. */
async function mapRegisterNamesForKey(
  fy: string,
  distKey: string,
  dir: Awaited<ReturnType<typeof loadDistributorDirectory>>,
): Promise<{ saleNames: string[]; secNames: string[] }> {
  const d = dir.distributors.find((x) => x.normKey === distKey);
  if (!d) return { saleNames: [], secNames: [] };
  const saleRows = await db.execute<{ customer: string; state: string | null }>(sql`
    SELECT customer, MAX(NULLIF(BTRIM(COALESCE(state_canon,'')),'')) AS state
    FROM sale_line_current
    WHERE fy = ${fy} AND customer IS NOT NULL AND BTRIM(customer) <> ''
    GROUP BY customer
  `);
  const saleNames = saleRows.rows
    .filter((r) => {
      const norm = normDistKey(r.customer);
      const baseNorm = normDistKey(stripLocationSuffix(r.customer));
      if (norm === distKey) return statesCompatible(r.state, d.states);
      // Suffix-stripped match: weaker — requires a known compatible state.
      return baseNorm === distKey && hasGeoState(r.state) && statesCompatible(r.state, d.states);
    })
    .map((r) => r.customer);
  const secRows = await db.execute<{ distributor: string }>(sql`
    SELECT DISTINCT distributor FROM secondary_sku_line
    WHERE fy = ${fy} AND distributor IS NOT NULL AND BTRIM(distributor) <> ''
  `);
  const secNames = secRows.rows
    .filter((r) => normDistKey(r.distributor) === distKey)
    .map((r) => r.distributor);
  return { saleNames, secNames };
}

// ── Tab 2: Existing vs New vs Lost SKU ───────────────────────────────────────

export type SkuPopulationSide = {
  source: "primary register (sale_line)" | "secondary register (secondary_sku_line)";
  baselineMonths: string[];
  currentMonths: string[];
  baselineNote: string;
  existing: { value: number; baselineValue: number; codes: number; growth: number };
  fresh:    { value: number; codes: number; segments: string[] };
  lost:     { codes: { code: string; group: string | null; baselineValue: number }[]; value: number };
  totalCurrent: number;
  totalBaseline: number;
  totalGrowth: number;
  existingGrowthShare: number | null;  // share of totalGrowth from existing SKU
  newGrowthShare: number | null;
  // real terms using this distributor's own baseline segment mix
  deflator: number | null;
  realCurrent: number | null;
  realGrowth: number | null;
  mixNote: string;
};

export type SkuEvolutionResult = {
  fy: string;
  baselineFy: string;
  distributor: { name: string; normKey: string };
  primary: SkuPopulationSide | null;    // null → no primary vocabulary match
  secondary: SkuPopulationSide | null;  // null → no secondary rows
  reading: string;
};

/** The Targets engine's three-population definition (existing / new / lost by
 *  code presence in baseline vs current period) applied to one entity. Shared
 *  semantics with targetEngine populations — do not fork the definition. */
export function classifySkuPopulations(
  baseline: Map<string, { value: number; group: string | null }>,
  current: Map<string, { value: number; group: string | null }>,
) {
  let existingCur = 0, existingBase = 0, freshVal = 0;
  let existingCodes = 0;
  const freshSegs = new Set<string>();
  let freshCodes = 0;
  const lost: { code: string; group: string | null; baselineValue: number }[] = [];
  for (const [code, cur] of current) {
    const base = baseline.get(code);
    if (base) { existingCodes++; existingCur += cur.value; existingBase += base.value; }
    else { freshCodes++; freshVal += cur.value; if (cur.group) freshSegs.add(cur.group); }
  }
  for (const [code, base] of baseline) {
    if (!current.has(code)) lost.push({ code, group: base.group, baselineValue: base.value });
  }
  lost.sort((a, b) => b.baselineValue - a.baselineValue);
  return { existingCur, existingBase, existingCodes, freshVal, freshCodes, freshSegs: [...freshSegs], lost };
}

async function codeMapPrimary(fy: string, months: string[], saleNames: string[]) {
  const map = new Map<string, { value: number; group: string | null }>();
  if (saleNames.length === 0 || months.length === 0) return map;
  const rows = await db.execute<{ code: string; grp: string | null; value: string }>(sql`
    SELECT code, MAX(group_canon) AS grp, SUM(amount::numeric)::text AS value
    FROM sale_line_current
    WHERE fy = ${fy} AND code IS NOT NULL AND is_territory = true
      AND month_label IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)})
      AND customer IN (${sql.join(saleNames.map((n) => sql`${n}`), sql`, `)})
    GROUP BY code
  `);
  for (const r of rows.rows) map.set(r.code, { value: parseFloat(r.value) || 0, group: r.grp });
  return map;
}

async function codeMapSecondary(fy: string, months: string[], secNames: string[]) {
  const map = new Map<string, { value: number; group: string | null }>();
  if (secNames.length === 0 || months.length === 0) return map;
  const rows = await db.execute<{ code: string; grp: string | null; value: string }>(sql`
    SELECT item_code AS code, MAX(segment_canon) AS grp, SUM(net_amount::numeric)::text AS value
    FROM secondary_sku_line
    WHERE fy = ${fy} AND item_code IS NOT NULL
      AND month_label IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)})
      AND distributor IN (${sql.join(secNames.map((n) => sql`${n}`), sql`, `)})
    GROUP BY item_code
  `);
  for (const r of rows.rows) map.set(r.code, { value: parseFloat(r.value) || 0, group: r.grp });
  return map;
}

function buildSide(
  source: SkuPopulationSide["source"],
  baseMap: Map<string, { value: number; group: string | null }>,
  curMap: Map<string, { value: number; group: string | null }>,
  baseMonths: string[],
  curMonths: string[],
  baselineNote: string,
  multipliers: Map<string, number> | null,
): SkuPopulationSide {
  const pop = classifySkuPopulations(baseMap, curMap);
  const totalCurrent = [...curMap.values()].reduce((a, b) => a + b.value, 0);
  const totalBaseline = [...baseMap.values()].reduce((a, b) => a + b.value, 0);
  const totalGrowth = totalCurrent - totalBaseline;
  const existingGrowth = pop.existingCur - pop.existingBase;
  // Real terms: deflator = Σ (baseline segment share × segment multiplier),
  // weighted by THIS distributor's own baseline mix.
  let deflator: number | null = null;
  let mixNote = "Real terms unavailable — no category price index for this period.";
  if (multipliers && totalBaseline > 0) {
    const segBase = new Map<string, number>();
    for (const v of baseMap.values()) {
      const g = v.group ?? "Unmapped";
      segBase.set(g, (segBase.get(g) ?? 0) + v.value);
    }
    let weighted = 0, covered = 0;
    for (const [g, val] of segBase) {
      const m = multipliers.get(g);
      if (m != null) { weighted += (val / totalBaseline) * m; covered += val; }
    }
    if (covered / totalBaseline >= 0.5) {
      // Renormalise over covered share so missing categories don't drag toward 0.
      deflator = weighted / (covered / totalBaseline);
      mixNote = `Deflator ${deflator.toFixed(3)} from this distributor's own baseline segment mix (${((covered / totalBaseline) * 100).toFixed(0)}% of baseline value covered by the category price index).`;
    }
  }
  const growthDenom = Math.abs(totalGrowth) > 1 ? totalGrowth : null;
  return {
    source,
    baselineMonths: baseMonths,
    currentMonths: curMonths,
    baselineNote,
    existing: { value: pop.existingCur, baselineValue: pop.existingBase, codes: pop.existingCodes, growth: existingGrowth },
    fresh: { value: pop.freshVal, codes: pop.freshCodes, segments: pop.freshSegs },
    lost: { codes: pop.lost.slice(0, 30), value: pop.lost.reduce((a, b) => a + b.baselineValue, 0) },
    totalCurrent,
    totalBaseline,
    totalGrowth,
    existingGrowthShare: growthDenom != null ? (existingGrowth / growthDenom) * 100 : null,
    newGrowthShare: growthDenom != null ? (pop.freshVal / growthDenom) * 100 : null,
    deflator,
    realCurrent: deflator != null ? totalCurrent / deflator : null,
    realGrowth: deflator != null ? totalCurrent / deflator - totalBaseline : null,
    mixNote,
  };
}

export async function buildSkuEvolution(
  fy: string,
  distKey: string,
  months: string[] | null = null,
): Promise<SkuEvolutionResult> {
  const recon = await buildDistributorRecon(fy);
  const dir = await loadDistributorDirectory(fy);
  const d = dir.distributors.find((x) => x.normKey === distKey);
  if (!d) throw new Error(`Unknown distributor key: ${distKey}`);

  const baselineFy = prevFyLabel(fy);
  // Like months only: default = every loaded secondary month; a selected
  // period narrows both sides to the same fiscal months.
  const curMonths = months && months.length > 0 ? months : recon.monthsLoaded;
  const baseMonths = toPriorYearMonths(curMonths);
  const baselineNote = `Baseline = same fiscal months of ${baselineFy} (${baseMonths.join(", ") || "none"}), frozen register anchors (sale_line_current / secondary register).`;

  const saleNames = recon.saleNamesByKey[distKey] ?? [];
  // Baseline-FY register names drift; map them against the SAME sheet vocabulary
  // (lightweight — never builds a prior-FY directory / Sheets pass).
  const base = await mapRegisterNamesForKey(baselineFy, distKey, dir).catch(() => null);
  const baseSaleNames = base?.saleNames ?? saleNames;
  const secNames = recon.secondaryNamesByKey[distKey] ?? [];
  const baseSecNames = base?.secNames ?? secNames;

  let multipliers: Map<string, number> | null = null;
  try {
    const mm = await computeCategoryMultipliers(baselineFy, fy);
    multipliers = new Map([...mm.entries()].map(([k, v]) => [k, v.multiplier]));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "distributorTabs: category multipliers unavailable");
  }

  const [priBase, priCur, secBase, secCur] = await Promise.all([
    codeMapPrimary(baselineFy, baseMonths, baseSaleNames),
    codeMapPrimary(fy, curMonths, saleNames),
    codeMapSecondary(baselineFy, baseMonths, baseSecNames),
    codeMapSecondary(fy, curMonths, secNames),
  ]);

  const primary = saleNames.length > 0 || baseSaleNames.length > 0
    ? buildSide("primary register (sale_line)", priBase, priCur, baseMonths, curMonths, baselineNote, multipliers)
    : null;
  const secondary = secCur.size > 0 || secBase.size > 0
    ? buildSide("secondary register (secondary_sku_line)", secBase, secCur, baseMonths, curMonths, baselineNote, multipliers)
    : null;

  const side = secondary ?? primary;
  let reading = "No data on either register for this distributor in the period.";
  if (side && side.totalGrowth > 0) {
    const ex = side.existingGrowthShare ?? 0, nw = side.newGrowthShare ?? 0;
    reading = ex >= 70
      ? `Growth is ${ex.toFixed(0)}% existing-SKU: buying more of the same — exposed if those lines soften.`
      : nw >= 40
        ? `${nw.toFixed(0)}% of growth comes from NEW SKU: the distributor is widening its range.`
        : `Growth is balanced: ${ex.toFixed(0)}% from existing SKU, ${nw.toFixed(0)}% from new SKU.`;
  } else if (side && side.totalGrowth < 0) {
    reading = `Business contracted vs the like-months baseline; lost SKU worth ₹${(side.lost.value / 1e5).toFixed(1)} L (baseline value) is the first place to look.`;
  }

  return { fy, baselineFy, distributor: { name: d.name, normKey: distKey }, primary, secondary, reading };
}

// ── Tab 3: Where and how to push ─────────────────────────────────────────────

export type PushRecommendation = {
  code: string;
  itemName: string | null;
  segment: string;
  tier: 1 | 2 | 3 | 4;
  tierLabel: string;
  peerCount: number;
  segmentPeerCount: number;
  peerNet: number;
  peakQuarter: string | null;
  peakQuarterSharePct: number | null;
  timingNote: string | null;      // e.g. "Q4 code pushed in August is January groundwork"
  candidateRetailers: { name: string; segmentNet: number; salesperson: string | null }[];
  /** This distributor's own discount on the code vs its territory norm (secondary register discount_pct). */
  ownDiscountPct: number | null;
  territoryNormPct: number | null;
  overDiscounted: boolean;        // own ≥ norm + 5 points
};

export type PushTabResult = {
  fy: string;
  distributor: { name: string; normKey: string };
  verdict: "PUSH" | "CLEAR_STOCK_FIRST" | "NO_PRIMARY_DATA";
  verdictDetail: string;
  flowSummary: { primaryIn: number; secondaryOut: number; ratio: number | null; flaggedCodes: number };
  pushListSource: string;
  peerNames: string[];
  cohortBasis: string;
  suppressed: boolean;
  suppressReason: string | null;
  recommendations: PushRecommendation[];
  // coverage — the administrative push
  coverage: {
    /** Unassigned retailers under the members serving this distributor, with
     *  assigned-vs-unassigned activity rates (source: member working sheets). */
    unassignedByMember: {
      member: string; state: string; unassigned: number;
      assignedActivePct: number | null; unassignedActivePct: number | null;
    }[];
    dormantRetailers: { name: string; priorYearValue: number; district: string | null; salesperson: string | null }[];
    /** Districts in this distributor's own retailer rows served by no OTHER distributor. */
    soleCoverageDistricts: string[];
    districts: string[];
    note: string;
  };
};

/** Per-segment quarter shares from the last CLOSED FY, territory channel only. */
async function segmentPeakQuarters(closedFy: string) {
  const rows = await db.execute<{ grp: string; m: string; v: string }>(sql`
    SELECT group_canon AS grp, month_label AS m, SUM(amount::numeric)::text AS v
    FROM sale_line_current
    WHERE fy = ${closedFy} AND is_territory = true AND group_canon IS NOT NULL
    GROUP BY group_canon, month_label
  `);
  const bySeg = new Map<string, Map<string, number>>();
  for (const r of rows.rows) {
    let q = bySeg.get(r.grp);
    if (!q) bySeg.set(r.grp, (q = new Map()));
    const quarter = quarterOf(r.m);
    q.set(quarter, (q.get(quarter) ?? 0) + (parseFloat(r.v) || 0));
  }
  const result = new Map<string, { peak: string; sharePct: number }>();
  for (const [seg, q] of bySeg) {
    const total = [...q.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    const [peak, val] = [...q.entries()].sort((a, b) => b[1] - a[1])[0];
    result.set(seg, { peak, sharePct: (val / total) * 100 });
  }
  return result;
}

export async function buildPushTab(
  fy: string,
  distKey: string,
  months: string[] | null = null,
): Promise<PushTabResult> {
  const recon = await buildDistributorRecon(fy);
  const dir = await loadDistributorDirectory(fy);
  const d = dir.distributors.find((x) => x.normKey === distKey);
  if (!d) throw new Error(`Unknown distributor key: ${distKey}`);

  const saleNames = recon.saleNamesByKey[distKey] ?? [];
  const secNames = recon.secondaryNamesByKey[distKey] ?? [];
  // Verdict flow gap respects the selected period (same window on both sides).
  const secTab = await buildSecondaryTab(fy, distKey, months);

  // ── Verdict FIRST: check the flow gap before recommending anything ─────────
  let verdict: PushTabResult["verdict"];
  let verdictDetail: string;
  const ratio = secTab.primaryInTotal > 0 ? secTab.secondaryOutTotal / secTab.primaryInTotal : null;
  if (!secTab.primaryMatched) {
    verdict = "NO_PRIMARY_DATA";
    verdictDetail = "This distributor has no matched primary-register purchases, so the stock position cannot be assessed. Recommendations below rest on secondary evidence only.";
  } else if (secTab.primaryInTotal >= 500_000 && ratio != null && ratio < 0.5) {
    verdict = "CLEAR_STOCK_FIRST";
    verdictDetail = `Primary in ₹${(secTab.primaryInTotal / 1e5).toFixed(1)} L far exceeds secondary out ₹${(secTab.secondaryOutTotal / 1e5).toFixed(1)} L (${(ratio * 100).toFixed(0)}% flows through). Either stock is building at the distributor OR business is moving outside the attributed channel — no stock statements exist, so the two cannot be distinguished. Either way, pushing more SKU now is wrong; ${secTab.flaggedCodes} code(s) with near-zero secondary out are the place to start.`;
  } else {
    verdict = "PUSH";
    verdictDetail = ratio != null
      ? `Secondary out is ${(ratio * 100).toFixed(0)}% of primary in — flow-through is healthy enough to push.`
      : "No primary purchases in the period; nothing suggests stock is building.";
  }

  // ── Push list: reuse the K3 engine (never rebuilt) ─────────────────────────
  // K3 keys on a single raw sale_line customer name; use the largest matched one.
  let push: PushListResult | null = null;
  let pushKey: string | null = null;
  if (saleNames.length > 0) {
    const vals = await db.execute<{ customer: string; v: string }>(sql`
      SELECT customer, SUM(amount::numeric)::text AS v FROM sale_line_current
      WHERE fy = ${fy} AND is_territory = true
        AND customer IN (${sql.join(saleNames.map((n) => sql`${n}`), sql`, `)})${monthCond(months)}
      GROUP BY customer ORDER BY SUM(amount::numeric) DESC LIMIT 1
    `);
    pushKey = vals.rows[0]?.customer ?? saleNames[0];
    try {
      push = await getSkuPushList({
        fy,
        monthLabels: months && months.length > 0 ? months : recon.monthsLoaded,
        level: "distributor",
        distributorKey: pushKey,
      });
    } catch (e) {
      logger.warn({ err: (e as Error).message, pushKey }, "distributorTabs: push list failed");
    }
  }

  // ── Enrichment: peak quarter, retailers, discount position, salesperson ────
  const peaks = await segmentPeakQuarters("2025-26");

  // Retailer activity by segment + own/territory discount norms (secondary register).
  const retBySeg = new Map<string, { name: string; net: number; salesperson: string | null }[]>();
  if (secNames.length > 0) {
    const rows = await db.execute<{ seg: string | null; retailer: string; head: string | null; net: string }>(sql`
      SELECT segment_canon AS seg, retailer, MAX(head_canon) AS head, SUM(net_amount::numeric)::text AS net
      FROM secondary_sku_line
      WHERE fy = ${fy} AND retailer IS NOT NULL
        AND distributor IN (${sql.join(secNames.map((n) => sql`${n}`), sql`, `)})${monthCond(months)}
      GROUP BY segment_canon, retailer
    `);
    for (const r of rows.rows) {
      const seg = r.seg ?? "Unmapped";
      let list = retBySeg.get(seg);
      if (!list) retBySeg.set(seg, (list = []));
      list.push({ name: r.retailer, net: parseFloat(r.net) || 0, salesperson: r.head });
    }
    for (const list of retBySeg.values()) list.sort((a, b) => b.net - a.net);
  }

  const recCodes = (push?.segments ?? []).flatMap((s) =>
    s.topCodes.map((c) => ({ ...c, segment: s.segment, segmentPeerCount: s.segmentPeerCount })));
  const codeList = recCodes.map((c) => c.code);
  const ownDisc = new Map<string, number>();
  const normDisc = new Map<string, number>();
  if (codeList.length > 0) {
    const [own, norm] = await Promise.all([
      secNames.length === 0 ? { rows: [] as any[] } : db.execute<{ code: string; d: string }>(sql`
        SELECT item_code AS code,
               (SUM(discount_pct::numeric * net_amount::numeric) / NULLIF(SUM(net_amount::numeric),0))::text AS d
        FROM secondary_sku_line
        WHERE fy = ${fy} AND item_code IN (${sql.join(codeList.map((c) => sql`${c}`), sql`, `)})
          AND distributor IN (${sql.join(secNames.map((n) => sql`${n}`), sql`, `)})${monthCond(months)}
        GROUP BY item_code
      `),
      db.execute<{ code: string; d: string }>(sql`
        SELECT item_code AS code,
               (SUM(discount_pct::numeric * net_amount::numeric) / NULLIF(SUM(net_amount::numeric),0))::text AS d
        FROM secondary_sku_line
        WHERE fy = ${fy} AND item_code IN (${sql.join(codeList.map((c) => sql`${c}`), sql`, `)})${monthCond(months)}
        GROUP BY item_code
      `),
    ]);
    for (const r of own.rows) if (r.d != null) ownDisc.set(r.code, parseFloat(r.d));
    for (const r of norm.rows) if (r.d != null) normDisc.set(r.code, parseFloat(r.d));
  }

  const currentMonth = new Date().getMonth(); // 0=Jan
  const currentQ = currentMonth >= 3 && currentMonth <= 5 ? "Q1" : currentMonth >= 6 && currentMonth <= 8 ? "Q2" : currentMonth >= 9 && currentMonth <= 11 ? "Q3" : "Q4";

  const recommendations: PushRecommendation[] = recCodes
    .map((c) => {
      const peak = peaks.get(c.segment) ?? null;
      const own = ownDisc.get(c.code) ?? null;
      const norm = normDisc.get(c.code) ?? null;
      const timingNote = peak && peak.peak !== currentQ
        ? `${c.segment} peaks in ${peak.peak} (${peak.sharePct.toFixed(0)}% of FY 2025-26 territory value) — a ${peak.peak} code pushed now is groundwork for that quarter, not immediate volume.`
        : peak ? `${c.segment} is in its peak quarter now (${peak.peak}).` : null;
      return {
        code: c.code,
        itemName: c.itemName,
        segment: c.segment,
        tier: c.tier,
        tierLabel: c.tierLabel,
        peerCount: c.peerCount,
        segmentPeerCount: c.segmentPeerCount,
        peerNet: c.peerNet,
        peakQuarter: peak?.peak ?? null,
        peakQuarterSharePct: peak ? Math.round(peak.sharePct * 10) / 10 : null,
        timingNote,
        candidateRetailers: (retBySeg.get(c.segment) ?? [])
          .slice(0, 5)
          .map((r) => ({ name: r.name, segmentNet: r.net, salesperson: r.salesperson })),
        ownDiscountPct: own,
        territoryNormPct: norm,
        overDiscounted: own != null && norm != null && own >= norm + 5,
      };
    })
    .sort((a, b) => a.tier - b.tier || b.peerCount * b.peerNet - a.peerCount * a.peerNet)
    .slice(0, 10);

  // ── Coverage: the administrative push ───────────────────────────────────────
  const distDistricts = new Set<string>();
  const dormant: PushTabResult["coverage"]["dormantRetailers"] = [];
  const priorFy = prevFyLabel(fy);
  if (secNames.length > 0) {
    // Districts come from the deep-dive retailer rows via the directory head payloads;
    // secondary register has no district column, so derive dormancy from it instead:
    // retailers with prior-FY net but zero this FY under this distributor.
    // With a selected period, both sides use like months (prior = same fiscal
    // months of the prior FY) so the comparison stays like-for-like.
    const priorMonths = months && months.length > 0 ? toPriorYearMonths(months) : null;
    const rows = await db.execute<{ retailer: string; head: string | null; prior: string; cur: string }>(sql`
      WITH prior AS (
        SELECT retailer, MAX(head_canon) AS head, SUM(net_amount::numeric) AS v
        FROM secondary_sku_line
        WHERE fy = ${priorFy} AND retailer IS NOT NULL
          AND distributor IN (${sql.join(secNames.map((n) => sql`${n}`), sql`, `)})${monthCond(priorMonths)}
        GROUP BY retailer
      ), cur AS (
        SELECT retailer, SUM(net_amount::numeric) AS v
        FROM secondary_sku_line
        WHERE fy = ${fy} AND retailer IS NOT NULL
          AND distributor IN (${sql.join(secNames.map((n) => sql`${n}`), sql`, `)})${monthCond(months)}
        GROUP BY retailer
      )
      SELECT p.retailer, p.head, p.v::text AS prior, COALESCE(c.v,0)::text AS cur
      FROM prior p LEFT JOIN cur c USING (retailer)
      WHERE COALESCE(c.v,0) <= 0
      ORDER BY p.v DESC LIMIT 25
    `);
    for (const r of rows.rows) {
      dormant.push({ name: r.retailer, priorYearValue: parseFloat(r.prior) || 0, district: null, salesperson: r.head });
    }
  }

  // Unassigned retailers under the serving members + district coverage,
  // from the deep-dive snapshots (member working sheets).
  const unassignedByMember: PushTabResult["coverage"]["unassignedByMember"] = [];
  const soleCoverageDistricts: string[] = [];
  try {
    const { loadDistDdSnapshotOnly } = await import("./distributorDeepDive.js");
    for (const head of d.heads) {
      const snap = await loadDistDdSnapshotOnly(fy, head);
      if (!snap) continue;
      const grp = snap.distributors.find((g) => g.normKey === distKey);
      const servingMembers = new Set<string>();
      if (grp) {
        for (const r of grp.retailers) {
          if (r.district) distDistricts.add(r.district.trim().toUpperCase());
          if (r.memberName) servingMembers.add(r.memberName);
        }
      }
      for (const m of snap.perMember ?? []) {
        if (!servingMembers.has(m.name) || m.noneCount <= 0) continue;
        unassignedByMember.push({
          member: m.name,
          state: m.state,
          unassigned: m.noneCount,
          assignedActivePct: m.namedActivePct,
          unassignedActivePct: m.noneActivePct,
        });
      }
      // Districts in this distributor's rows that no OTHER distributor serves.
      const otherCovered = new Set<string>();
      for (const g of snap.distributors) {
        if (g.normKey === distKey) continue;
        for (const r of g.retailers) if (r.district) otherCovered.add(r.district.trim().toUpperCase());
      }
      for (const dd of distDistricts) if (!otherCovered.has(dd)) soleCoverageDistricts.push(dd);
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "distributorTabs: coverage from snapshots failed");
  }

  return {
    fy,
    distributor: { name: d.name, normKey: distKey },
    verdict,
    verdictDetail,
    flowSummary: {
      primaryIn: secTab.primaryInTotal,
      secondaryOut: secTab.secondaryOutTotal,
      ratio,
      flaggedCodes: secTab.flaggedCodes,
    },
    pushListSource: push
      ? `K3 push engine, keyed on primary customer "${pushKey}"; cohort ${push.cohortBasis}${push.isFallback ? ` (fallback: ${push.fallbackScopeName ?? push.fallbackTier})` : ""}`
      : "K3 push engine unavailable — no matched primary customer for this distributor.",
    peerNames: push?.peerNames ?? [],
    cohortBasis: push?.cohortBasis ?? "none",
    suppressed: push?.suppressed ?? false,
    suppressReason: push?.suppressReason ?? null,
    recommendations,
    coverage: {
      unassignedByMember,
      dormantRetailers: dormant,
      soleCoverageDistricts: [...new Set(soleCoverageDistricts)].sort(),
      districts: [...distDistricts].sort(),
      note: (months && months.length > 0
        ? "Unassigned counts and district coverage come from the member working sheets, which carry no month detail — they always reflect the full FY regardless of the selected period. Dormant retailers compare the selected months against the SAME months of the prior FY. "
        : "") + "Unassigned-retailer activation is an administrative fix — the fastest push available. Unassigned counts are per serving salesperson (member sheets carry no district on unassigned rows). Dormant retailers ranked by prior-year secondary value (source: secondary register).",
    },
  };
}
