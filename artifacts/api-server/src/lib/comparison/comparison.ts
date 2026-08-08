// ── C1 — Comparison Deep Dive: the contract layer ────────────────────────────
//
// No UI. Selection schema + measure catalogue + twelve guards, proven over
// POST /api/comparison. Every comparison that went wrong in this project went
// wrong because the two sides were not on the same basis; this module makes
// each of those failure modes impossible (blocked) or visible (annotated).
//
// Response contract: every response carries a BASIS BLOCK (source, periods
// with completeness, channel, population, normalisation) and the full guard
// report. A blocked comparison returns { blocked: true } with the reason —
// never silent numbers on a broken basis.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "../sku/catalogue.js";
import { computeCategoryMultipliers, computeCompanyMultiplier } from "../customers/laspeyres.js";
import { getSeasonality } from "../sku/skuK4.js";
import { loadDeepDiveData, loadRegistry, type MemberKpis } from "../mgmt/deepDiveData.js";
import type { RetailerRow } from "../mgmt/memberSheet.js";
import { fyForDate, priorFy } from "../mgmt/targetEngine.js";
import { logger } from "../logger.js";

// ── Selection schema ─────────────────────────────────────────────────────────

export type EntityType =
  | "company" | "head" | "member" | "distributor" | "retailer" | "segment" | "code";

export type PeriodSpec = {
  kind: "month" | "quarter" | "fy" | "ytd" | "samePeriodLastYear" | "custom";
  fy?: string;              // "2026-27"
  month?: number;           // fiscal month 1..12 (1 = Apr), for kind=month
  quarter?: number;         // 1..4, for kind=quarter
  monthFrom?: number;       // fiscal months, for kind=custom
  monthTo?: number;
};

export type MeasureSpec = {
  measure: string;
  /** Guard 1: retailer/visit measures name their source explicitly. */
  source?: string;
  /** Optional per-entity source overrides — mixing sources across entities is BLOCKED. */
  sourceByEntity?: Record<string, string>;
};

export type ComparisonRequest = {
  entityType: EntityType;
  entities: string[];                       // 1..N names/ids
  periods: PeriodSpec[];                    // 1..N
  measures: (string | MeasureSpec)[];
  basis?: "primary" | "secondary";          // never mixed silently
  normalise?: "absolute" | "perElapsedMonth" | "perWorkingDay" | "perRetailer" | "perVisit" | "realTerms";
  channel?: "territory" | "project" | "all"; // default territory
  population?: "activeOnly" | "includeLeft"; // default activeOnly
  /** Context to disambiguate member names (guard 10). */
  context?: { stateHead?: string };
  /** C2b: explicit baseline period for period-pair measures (new SKUs, new
   *  customers) in Mode B (single period). In Mode A each period's baseline is
   *  the one before it. Without a baseline, period-pair measures are DISABLED
   *  with the reason — never returned as zero. */
  baseline?: PeriodSpec;
  /** Simulation hook, mirrors the target engine. */
  today?: string;
};

// ── Period resolution ────────────────────────────────────────────────────────

const FISCAL = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

export function fiscalMonthLabel(fy: string, m: number): string {
  const startYear = parseInt(fy.split("-")[0], 10);
  const year = m <= 9 ? startYear : startYear + 1; // Apr..Dec = start year, Jan..Mar = next
  return `${FISCAL[m - 1]}-${String(year % 100).padStart(2, "0")}`;
}

export type ResolvedPeriod = {
  spec: PeriodSpec;
  label: string;
  fy: string;
  monthFrom: number;                       // fiscal 1..12
  monthTo: number;
  monthLabels: string[];
  completeness: "complete" | "partial" | "noActualsRecorded";
  /** Month labels actually present in the data for this period. */
  monthsWithData: string[];
};

function resolvePeriodShape(
  p: PeriodSpec,
  currentFy: string,
  prevResolved: { fy: string; monthFrom: number; monthTo: number } | null,
): { fy: string; monthFrom: number; monthTo: number; label: string } {
  switch (p.kind) {
    case "fy": {
      const fy = p.fy ?? currentFy;
      return { fy, monthFrom: 1, monthTo: 12, label: `FY${fy}` };
    }
    case "quarter": {
      const fy = p.fy ?? currentFy;
      const q = p.quarter ?? 1;
      if (q < 1 || q > 4) throw new ComparisonError(`quarter must be 1-4, got ${q}`);
      return { fy, monthFrom: (q - 1) * 3 + 1, monthTo: q * 3, label: `Q${q} FY${fy}` };
    }
    case "month": {
      const fy = p.fy ?? currentFy;
      const m = p.month ?? 1;
      if (m < 1 || m > 12) throw new ComparisonError(`month must be fiscal 1-12, got ${m}`);
      return { fy, monthFrom: m, monthTo: m, label: fiscalMonthLabel(fy, m) };
    }
    case "ytd": {
      const fy = p.fy ?? currentFy;
      return { fy, monthFrom: 1, monthTo: 12, label: `YTD FY${fy}` }; // trimmed to data below
    }
    case "custom": {
      const fy = p.fy ?? currentFy;
      const from = p.monthFrom ?? 1, to = p.monthTo ?? 12;
      if (from < 1 || to > 12 || from > to) throw new ComparisonError("custom period needs 1 <= monthFrom <= monthTo <= 12");
      return {
        fy, monthFrom: from, monthTo: to,
        label: `${fiscalMonthLabel(fy, from)}–${fiscalMonthLabel(fy, to)}`,
      };
    }
    case "samePeriodLastYear": {
      if (!prevResolved) throw new ComparisonError("samePeriodLastYear must follow the period it mirrors");
      const fy = priorFy(prevResolved.fy);
      return {
        fy, monthFrom: prevResolved.monthFrom, monthTo: prevResolved.monthTo,
        label: `${fiscalMonthLabel(fy, prevResolved.monthFrom)}–${fiscalMonthLabel(fy, prevResolved.monthTo)} (same period last year)`,
      };
    }
    default:
      throw new ComparisonError(`unknown period kind '${(p as any).kind}'`);
  }
}

/** Months with any actuals recorded, per FY, from the data itself (never a config list). */
async function monthsWithActuals(basis: "primary" | "secondary", fy: string): Promise<Set<string>> {
  const table = basis === "primary" ? sql.raw("sale_line_current") : sql.raw("secondary_register_line");
  const res = await db.execute(sql`SELECT DISTINCT month_label FROM ${table} WHERE fy = ${fy}`);
  const rows = ((res as any).rows ?? res) as { month_label: string }[];
  return new Set(rows.map((r) => r.month_label).filter(Boolean));
}

async function resolvePeriods(
  specs: PeriodSpec[],
  basis: "primary" | "secondary",
  today: Date,
): Promise<ResolvedPeriod[]> {
  const currentFy = fyForDate(today);
  const out: ResolvedPeriod[] = [];
  const dataCache = new Map<string, Set<string>>();
  let prev: { fy: string; monthFrom: number; monthTo: number } | null = null;

  for (const spec of specs) {
    const shape = resolvePeriodShape(spec, currentFy, prev);
    prev = shape;
    if (!dataCache.has(shape.fy)) dataCache.set(shape.fy, await monthsWithActuals(basis, shape.fy));
    const present = dataCache.get(shape.fy)!;

    let { monthFrom, monthTo, label } = shape;
    if (spec.kind === "ytd") {
      // YTD = FY start through the last fiscal month with data.
      let last = 0;
      for (let m = 1; m <= 12; m++) if (present.has(fiscalMonthLabel(shape.fy, m))) last = m;
      monthTo = Math.max(1, last);
      label = `YTD FY${shape.fy} (Apr–${FISCAL[monthTo - 1]})`;
    }

    const monthLabels = [];
    for (let m = monthFrom; m <= monthTo; m++) monthLabels.push(fiscalMonthLabel(shape.fy, m));
    const monthsWithData = monthLabels.filter((l) => present.has(l));

    // Completeness derived from the data + the clock: complete when every month
    // in the period has actuals AND the period's last calendar month has ended.
    const startYear = parseInt(shape.fy.split("-")[0], 10);
    const endCalYear = monthTo <= 9 ? startYear : startYear + 1;
    const endCalMonth = ((monthTo + 2) % 12) + 1; // fiscal → calendar month 1..12
    const periodEnded = new Date(endCalYear, endCalMonth, 1) <= today; // first day after period end
    const completeness: ResolvedPeriod["completeness"] =
      monthsWithData.length === 0 ? "noActualsRecorded"
      : monthsWithData.length === monthLabels.length && periodEnded ? "complete"
      : "partial";

    out.push({ spec, label, fy: shape.fy, monthFrom, monthTo, monthLabels, completeness, monthsWithData });
  }
  return out;
}

// ── Measure catalogue ────────────────────────────────────────────────────────

type MeasureDef = {
  id: string;
  label: string;
  money: boolean;
  /** Data-tab measures are FY-to-date only — they cannot be filtered to a sub-period. */
  fyToDateOnly?: boolean;
  /** Guard 1: sources this measure can be read from; caller must not mix them. */
  sources?: string[];
  /** Guard 11: minimum sample; below it the figure is suppressed. */
  minSample?: number;
  /** C2b: needs a baseline period — undefined without one, never zero. */
  periodPair?: boolean;
  /** C2b declaration: the named source, where more than one exists. */
  sourceNote?: string;
  /** C2b declaration: behaviour when the denominator is zero or data absent. */
  guardNote?: string;
  /** Valid for member entities only (sheet-level detail a head cannot aggregate cheaply). */
  memberOnly?: boolean;
};

const MEMBER_MEASURES: MeasureDef[] = [
  { id: "secondaryOb",      label: "Secondary OB (I+J)",        money: true,  fyToDateOnly: true },
  { id: "salesReceived",    label: "Sales received (AY)",       money: true,  fyToDateOnly: true },
  { id: "target",           label: "Target to date (BM)",       money: true,  fyToDateOnly: true },
  { id: "achievement",      label: "Achievement (recomputed)",  money: false, fyToDateOnly: true },
  { id: "retailers",        label: "Retailers",                 money: false, fyToDateOnly: true,
    sources: ["dataTabDeclared", "memberSheetRows"] },
  { id: "visits",           label: "Visits (absolute)",         money: false, fyToDateOnly: true,
    sources: ["dataTab"] },
  { id: "visitsPerDay",     label: "Visits per working day",    money: false, fyToDateOnly: true },
  { id: "workingDays",      label: "Working days",              money: false, fyToDateOnly: true },
  { id: "elapsedMonths",    label: "Elapsed months",            money: false, fyToDateOnly: true },
  { id: "paceRatio",        label: "Pace ratio (achievement ÷ elapsed share)", money: false, fyToDateOnly: true },
  { id: "registerOb",       label: "Secondary OB from register (period-exact)", money: true },
  { id: "correlation",      label: "OB↔sale correlation across retailers", money: false, fyToDateOnly: true, minSample: 5 },

  // ── C2b: period-pair measures — undefined without a baseline, never zero ──
  { id: "newSkusExistingCount", label: "New SKUs to existing customers (count)", money: false, periodPair: true,
    sourceNote: "secondary SKU register (secondary_sku_line) — distinct (retailer, code) pairs; the customer is a RETAILER",
    guardNote: "period-pair: Mode B needs an explicit baseline or the measure is disabled with the reason" },
  { id: "newSkusExistingValue", label: "New SKUs to existing customers (value)", money: true, periodPair: true,
    sourceNote: "secondary SKU register (secondary_sku_line) — net amount of the new (retailer, code) pairs in the selected period",
    guardNote: "period-pair: Mode B needs an explicit baseline or the measure is disabled with the reason" },
  { id: "newCustomersCount", label: "New customers (count)", money: false, periodPair: true,
    sourceNote: "secondary register (secondary_register_line) — retailers with business in the selected period and none in the baseline",
    guardNote: "period-pair: Mode B needs an explicit baseline or the measure is disabled with the reason" },
  { id: "newCustomersValue", label: "New customers (value)", money: true, periodPair: true,
    sourceNote: "secondary register (secondary_register_line) — net amount from baseline-new retailers in the selected period",
    guardNote: "period-pair: Mode B needs an explicit baseline or the measure is disabled with the reason" },

  // ── C2b: the four separately named coverage measures (no measure is called
  // just "coverage", and secondary ÷ primary is NOT offered — different
  // populations; State Head glossary Correction 1) ──
  { id: "activeRetailerShare", label: "Active retailer share (%)", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — active rows ÷ total rows",
    guardNote: "sheet unavailable → 'member sheet unavailable', never zero" },
  { id: "visitCoverage", label: "Visit coverage (%)", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "visits done = Data tab column AF (all-type cumulative); visits required = member working sheet 'Visits Required' sum",
    guardNote: "required = 0 → undefined, not infinite" },
  { id: "segmentCoverage", label: "Segment coverage (%)", money: false,
    sourceNote: "secondary SKU register — distinct segments sold in the period ÷ segments available (sold company-wide in the same FY)",
    guardNote: "no segments available in the FY → undefined" },
  { id: "skuBreadthShare", label: "SKU breadth (%)", money: false,
    sourceNote: "secondary SKU register — distinct codes bought in the period ÷ codes ever sold company-wide (all FYs)",
    guardNote: "no codes ever sold → undefined" },

  // ── C2b: cost measures — TWO ratios, kept separate; their divergence is diagnostic ──
  { id: "costPerVisit", label: "Cost per visit", money: true, fyToDateOnly: true,
    sourceNote: "cost = monthly CTC × elapsed complete months (Data tab column BD, the member's OWN) + YTD travel (T.A. Bill); visits = Data tab column AF (all-type cumulative)",
    guardNote: "no cost data → 'not recorded' (blank is not zero cost); visits = 0 → undefined" },
  { id: "costRatioOb", label: "Cost ratio on order booking (%)", money: false, fyToDateOnly: true,
    sourceNote: "cost (CTC × BD elapsed months + YTD travel) ÷ secondary OB (I + J)",
    guardNote: "no cost data → 'not recorded'; OB = 0 → undefined, not infinite and not zero" },
  { id: "costRatioSales", label: "Cost ratio on sales received (%)", money: false, fyToDateOnly: true,
    sourceNote: "cost (CTC × BD elapsed months + YTD travel) ÷ sales received (AY)",
    guardNote: "sales = 0 → UNDEFINED, not infinite and not zero (the OB ratio still computes); no cost data → 'not recorded'" },

  // ── C2b: measures added alongside — all already computed elsewhere ──
  { id: "unassignedShare", label: "Unassigned retailer share (%)", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — rows with no assigned distributor ÷ total rows",
    guardNote: "sheet unavailable → 'member sheet unavailable'" },
  { id: "visitsToUnassigned", label: "Visits to unassigned retailers", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — visit total over rows with no assigned distributor",
    guardNote: "sheet unavailable → 'member sheet unavailable'" },
  { id: "customersRetained", label: "Customer states — retained", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — active AND business plan > 0" },
  { id: "customersReactivated", label: "Customer states — reactivated", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — active without a business plan" },
  { id: "customersAtRisk", label: "Customer states — at risk", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — dormant but visited AND planned (the recoverable pool)" },
  { id: "customersNever", label: "Customer states — never established", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — dormant without both a visit and a plan" },
  { id: "removedParties", label: "Removed parties (count)", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet 'Removed Parties' section, labelled by LAST ACTIVE YEAR — the sheet holds no removal date" },
  { id: "businessPerActiveRetailer", label: "Business per active retailer", money: true, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — total OB ÷ active retailers",
    guardNote: "no active retailers → undefined" },
  { id: "effectiveRetailers", label: "Effective retailers (10,000 ÷ HHI)", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — concentration expressed as an equivalent count, preferred to a raw HHI",
    guardNote: "no positive OB → undefined" },
  { id: "top5Share", label: "Top-5 retailer share (%)", money: false, fyToDateOnly: true, memberOnly: true,
    sourceNote: "member working sheet — top-5 retailers' OB ÷ total OB",
    guardNote: "no OB → undefined" },
];

// A head aggregates its members: sheet-level measures (working-sheet rows)
// stay member-only; the head catalogue adds the territory gap value.
const HEAD_MEASURES: MeasureDef[] = [
  ...MEMBER_MEASURES.filter((d) => !d.memberOnly),
  { id: "gapValue", label: "Gap value (SKU push list, territory only)", money: true,
    sourceNote: "SKU push list — sum of actionable segment gaps (gapNet) for the head's territory",
    guardNote: "push list unavailable → 'could not compute', never zero" },
];

const CATALOGUE: Record<EntityType, MeasureDef[]> = {
  company: [
    { id: "net",      label: "NET (primary sale)", money: true },
    { id: "quantity", label: "Quantity",           money: false },
  ],
  head: HEAD_MEASURES,
  member: MEMBER_MEASURES,
  distributor: [
    { id: "primarySale", label: "Primary sale (NET)",  money: true },
    { id: "primaryOb",   label: "Primary OB",          money: true },
    { id: "pending",     label: "Pending (OB − sale)", money: true },
    { id: "skuBreadth",  label: "SKU breadth (distinct codes)", money: false },
    // C2b: for a distributor the "customer" is the distributor themselves, from sale_line.
    { id: "newSkusExistingCount", label: "New SKUs bought (count)", money: false, periodPair: true,
      sourceNote: "primary register (sale_line) — distinct codes bought in the selected period that this distributor did not buy in the baseline",
      guardNote: "period-pair: Mode B needs an explicit baseline or the measure is disabled with the reason" },
    { id: "newSkusExistingValue", label: "New SKUs bought (value)", money: true, periodPair: true,
      sourceNote: "primary register (sale_line) — NET of the baseline-new codes in the selected period",
      guardNote: "period-pair: Mode B needs an explicit baseline or the measure is disabled with the reason" },
  ],
  retailer: [
    { id: "secondaryOb",   label: "Secondary OB (register)", money: true },
    { id: "lastOrderMonth", label: "Last order month",       money: false },
  ],
  segment: [
    { id: "net",             label: "NET",                money: true },
    { id: "quantity",        label: "Quantity",           money: false },
    { id: "customersBuying", label: "Customers buying",   money: false },
    { id: "breadth",         label: "Distinct codes sold", money: false },
  ],
  code: [
    { id: "net",             label: "NET",              money: true },
    { id: "quantity",        label: "Quantity",         money: false },
    { id: "customersBuying", label: "Customers buying", money: false },
    // C2b: the register discount is a SECONDARY-register figure — named so.
    { id: "effectiveDiscount", label: "Effective discount (%, secondary register)", money: false,
      sourceNote: "secondary SKU register Discount column (retailer-level, beside Sub Total) — a DIFFERENT measure from the primary MRP discount; net-amount-weighted average",
      guardNote: "no secondary SKU rows for the code in the period → 'not recorded'" },
    { id: "discountVariance", label: "Discount spread across customers (pp)", money: false,
      sourceNote: "secondary SKU register — max − min customer-average discount on the same code in the period",
      guardNote: "fewer than 2 customers → undefined (a spread needs at least two)" },
  ],
};

/** The measure catalogue, for consumers: only measures valid for each entity type are offered. */
export function CATALOGUE_SUMMARY() {
  return Object.fromEntries(
    Object.entries(CATALOGUE).map(([et, defs]) => [
      et,
      defs.map((d) => ({
        id: d.id, label: d.label, money: d.money, sources: d.sources ?? null,
        // C2b declarations: every measure states its source, whether it is
        // period-pair (needs a baseline), and its zero/absent guard behaviour.
        periodPair: d.periodPair ?? false,
        sourceNote: d.sourceNote ?? null,
        guardNote: d.guardNote ?? null,
      })),
    ]),
  );
}

export class ComparisonError extends Error {
  constructor(message: string, public status = 400, public detail?: unknown) {
    super(message);
  }
}

// ── Guards ───────────────────────────────────────────────────────────────────

export type GuardResult = {
  id: number;
  name: string;
  status: "pass" | "annotated" | "blocked" | "notApplicable";
  detail: string | null;
  data?: unknown;
};

const GUARD_NAMES = [
  "SOURCE", "LIKE MONTHS", "SEASONAL", "REAL TERMS", "CHANNEL", "POPULATION",
  "TENURE", "ZERO TARGET", "NO BUSINESS", "IDENTITY", "SAMPLE", "FROZEN",
];

function guard(id: number, status: GuardResult["status"], detail: string | null = null, data?: unknown): GuardResult {
  return { id, name: GUARD_NAMES[id - 1], status, detail, ...(data !== undefined ? { data } : {}) };
}

// ── Entity resolution ────────────────────────────────────────────────────────

type ResolvedEntity = {
  input: string;
  name: string;                 // canonical display name
  key: string;                  // lookup key (nsk for members, name for others)
  stateHead?: string | null;
  hq?: string | null;
  isLeft?: boolean;
  kpis?: MemberKpis | null;     // member entities
  memberKpis?: MemberKpis[];    // head entities: members under the head
};

// ── Value matrix ─────────────────────────────────────────────────────────────

export type CellValue = {
  value: number | string | null;
  /** Real-terms companion for cross-year money values (guard 4). */
  real?: number | null;
  realIndex?: number | null;
  realIndexName?: string | null;
  note?: string | null;
  suppressed?: boolean;
};

export type MatrixRow = {
  entity: string;
  measure: string;
  measureLabel: string;
  source: string | null;
  /** Guard 9: excluded from any ranking by consumers. */
  excludeFromRanking?: boolean;
  /** Authoritative row flags — render verbatim: TENURE, NO TARGET, NO BUSINESS, INSUFFICIENT SAMPLE. */
  flags?: string[];
  /** Guard 7: false when ranking on this measure would mislead; consumers must not sort by it. */
  rankEligible?: boolean;
  rankBlockReason?: string | null;
  cells: CellValue[];           // one per period, in request order
  /** Mode C (matrix): level + direction across the requested periods.
   *  Present when the request has >1 period. Authoritative — consumers must
   *  not recompute a slope client-side. */
  trend?: TrendMeta;
};

export type TrendMeta = {
  /** The latest period's usable value (real terms when present). */
  level: number | null;
  levelPeriod: string | null;
  levelIsPartial?: boolean;
  /** Least-squares slope per period step over COMPLETE periods only. */
  direction: number | null;
  directionBasis: string | null;
  usedPeriods: string[];
  /** Periods excluded from the direction calculation, each with its reason. */
  excludedPeriods: { label: string; reason: string }[];
};

export type QuadrantGroup = {
  quadrant: "high-falling" | "low-falling" | "high-rising" | "low-rising";
  label: string;
  entities: { entity: string; level: number; direction: number }[];
};

export type QuadrantView = {
  measure: string;
  measureLabel: string;
  /** The level split value and the rule that produced it — never a hidden threshold. */
  levelSplit: number;
  splitRule: string;
  /** Ordered: high-falling (the early-warning quadrant) FIRST. */
  groups: QuadrantGroup[];
  /** Entities shown but given no direction, with the reason. Never silently dropped. */
  noDirection: { entity: string; reason: string }[];
};

export type RosterChange = {
  entity: string;
  fromFy: string;
  toFy: string;
  joiners: string[];
  leavers: string[];
  note: string;
};

/** C4: a server-computed suggested action. The UI renders these verbatim —
 *  every figure cited is a field here, never re-derived client-side. */
export type Suggestion = {
  rank: number;
  kind: "high-falling" | "low-falling" | "roster-context";
  entity: string;
  measure?: string;
  measureLabel?: string;
  action: string;
  /** The exact figures the suggestion rests on, in plain words. */
  evidence: string;
  level?: number;
  direction?: number;
  /** Caveats that MUST travel with the suggestion (roster changes, ambiguity). */
  caveats: string[];
};

export type ComparisonResponse = {
  blocked: false;
  basis: {
    entityType: EntityType;
    basis: "primary" | "secondary";
    channel: "territory" | "project" | "all";
    /** Prominent scope statement — repeat this next to any figure shown to a user. */
    channelLabel: string;
    population: "activeOnly" | "includeLeft";
    normalise: string;
    periods: { label: string; fy: string; completeness: string; months: string[] }[];
    sources: Record<string, string>;      // measure → source used
  };
  guards: GuardResult[];
  matrix: MatrixRow[];
  /** Mode C: quadrant view per measure — present when >1 entity AND >1 period. */
  quadrants?: QuadrantView[];
  /** Mode C: joiners/leavers per head when periods span FYs — a head's direction
   *  can move purely from membership. */
  rosterChanges?: RosterChange[];
  /** C4: ranked suggested actions — high-falling first, always with evidence. */
  suggestions?: Suggestion[];
  /** Head groups: headline vs like-for-like achievement (guard 8). */
  likeForLike?: {
    entity: string;
    headlineAchievement: number | null;
    likeForLikeAchievement: number | null;
    untargetedMembers: string[];
  }[];
  notes: string[];
};

export type BlockedResponse = {
  blocked: true;
  reason: string;
  guards: GuardResult[];
  basis: Partial<ComparisonResponse["basis"]>;
};

// ── SQL helpers ──────────────────────────────────────────────────────────────

function channelFilter(channel: "territory" | "project" | "all") {
  if (channel === "territory") return sql`(head_canon IS NULL OR head_canon != ${PROJECT_HEAD_CANON})`;
  if (channel === "project") return sql`head_canon = ${PROJECT_HEAD_CANON}`;
  return sql`TRUE`;
}

function monthIn(labels: string[]) {
  return sql`month_label IN (${sql.join(labels.map((l) => sql`${l}`), sql`, `)})`;
}

async function one<T = any>(q: any): Promise<T> {
  const res = await db.execute(q);
  return (((res as any).rows ?? res) as T[])[0];
}

async function all<T = any>(q: any): Promise<T[]> {
  const res = await db.execute(q);
  return ((res as any).rows ?? res) as T[];
}

// ── Main entry ───────────────────────────────────────────────────────────────

const MIN_CORRELATION_SAMPLE = 5;
const TENURE_RATIO_THRESHOLD = 2; // working-day ratio beyond which absolutes are suppressed
// Measures already expressed per unit — safe to rank even when the tenure guard fired.
const PER_UNIT_MEASURE_IDS = new Set(["visitsPerDay", "achievement", "paceRatio", "correlation", "elapsedMonths", "workingDays"]);

export async function runComparison(req: ComparisonRequest): Promise<ComparisonResponse | BlockedResponse> {
  const today = req.today ? new Date(req.today) : new Date();
  if (req.today && isNaN(today.getTime())) throw new ComparisonError(`invalid today '${req.today}'`);
  const currentFy = fyForDate(today);

  // ── Schema validation ──
  if (!req.entityType || !(req.entityType in CATALOGUE)) {
    throw new ComparisonError(
      `entityType must be one of: ${Object.keys(CATALOGUE).join(", ")}`,
    );
  }
  if (!Array.isArray(req.entities) || req.entities.length < 1) {
    throw new ComparisonError("entities must be a non-empty array");
  }
  if (!Array.isArray(req.periods) || req.periods.length < 1) {
    throw new ComparisonError("periods must be a non-empty array");
  }
  if (!Array.isArray(req.measures) || req.measures.length < 1) {
    throw new ComparisonError("measures must be a non-empty array");
  }
  // Basis is bound to the entity type — a member's figures come from the
  // secondary channel (Data tab + register), a distributor's from the primary
  // register. A request that claims the other basis would make the basis
  // block untruthful, so it is rejected, never silently reinterpreted.
  const BASIS_BY_ENTITY: Record<EntityType, "primary" | "secondary"> = {
    company: "primary", segment: "primary", code: "primary", distributor: "primary",
    member: "secondary", head: "secondary", retailer: "secondary",
  };
  const requiredBasis = BASIS_BY_ENTITY[req.entityType];
  if (req.basis && req.basis !== requiredBasis) {
    throw new ComparisonError(
      `entity type '${req.entityType}' is measured on the ${requiredBasis} basis; basis '${req.basis}' would mislabel the figures. Omit basis or pass '${requiredBasis}'.`,
    );
  }
  const basis: "primary" | "secondary" = requiredBasis;
  const channel = req.channel ?? "territory";
  const population = req.population ?? "activeOnly";
  const normalise = req.normalise ?? "absolute";

  // ── Measure catalogue check (before anything expensive) ──
  const catalogue = CATALOGUE[req.entityType];
  const measureSpecs: MeasureSpec[] = req.measures.map((m) =>
    typeof m === "string" ? { measure: m } : m,
  );
  for (const m of measureSpecs) {
    const def = catalogue.find((d) => d.id === m.measure);
    if (!def) {
      throw new ComparisonError(
        `measure '${m.measure}' is not valid for entity type '${req.entityType}'. Valid measures: ${catalogue.map((d) => d.id).join(", ")}`,
        400,
        { entityType: req.entityType, validMeasures: catalogue.map((d) => ({ id: d.id, label: d.label })) },
      );
    }
    if (def.sources && m.source && !def.sources.includes(m.source)) {
      throw new ComparisonError(
        `source '${m.source}' is not valid for measure '${m.measure}'. Valid sources: ${def.sources.join(", ")}`,
      );
    }
  }

  // ── Period resolution + completeness (from data, not config) ──
  const periods = await resolvePeriods(req.periods, basis, today);

  // ── C2b: baseline for period-pair measures ──
  // Mode A (>1 period): each period's baseline is the one before it in the
  // request; the first period has none. Mode B (1 period): the request must
  // name a baseline explicitly, or period-pair measures are disabled with the
  // reason — never returned as zero.
  const wantsPeriodPair = measureSpecs.some(
    (m) => catalogue.find((d) => d.id === m.measure)?.periodPair,
  );
  let explicitBaseline: ResolvedPeriod | null = null;
  if (req.baseline != null && wantsPeriodPair) {
    if (typeof req.baseline !== "object" || Array.isArray(req.baseline) || typeof (req.baseline as any).kind !== "string" || typeof (req.baseline as any).fy !== "string") {
      throw new ComparisonError("'baseline' must be a period spec object like { kind: 'fy', fy: '2025-26' }");
    }
    explicitBaseline = (await resolvePeriods([req.baseline], basis, today))[0];
  }
  // A baseline without any period-pair measure is ignored (nothing uses it).
  const baselineFor = (idx: number): ResolvedPeriod | null =>
    periods.length > 1 ? (idx > 0 ? periods[idx - 1] : explicitBaseline) : explicitBaseline;

  const guards: GuardResult[] = [];
  const notes: string[] = [];

  // ── Guard 10 — IDENTITY (resolve entities first; ambiguity is an error) ──
  let entities: ResolvedEntity[] = [];
  const kpiFy = periods[0].fy === currentFy ? currentFy : periods.map((p) => p.fy).includes(currentFy) ? currentFy : periods[0].fy;

  if (req.entityType === "member" || req.entityType === "head") {
    const registry = await loadRegistry(kpiFy);
    const dd = await loadDeepDiveData(kpiFy, undefined, undefined, { skipExtras: true });
    if (req.entityType === "member") {
      if (!registry) throw new ComparisonError("member registry unavailable (Data tab not loaded)", 503);
      for (const input of req.entities) {
        const r = registry.resolve(input, req.context);
        if (r.kind === "ambiguous") {
          const cands = r.candidates.map((c) => ({
            name: c.displayName, stateHead: c.stateHead, headquarter: c.hq,
          }));
          guards.push(guard(10, "blocked",
            `'${input}' is ambiguous: ${cands.map((c) => `${c.name} (head: ${c.stateHead}, HQ: ${c.headquarter ?? "?"})`).join(" vs ")}. Pass context.stateHead to disambiguate.`,
            cands));
          return blockedResponse(guards, req, basis, channel, population, normalise, periods,
            `entity '${input}' is ambiguous — ${cands.length} people share this name`);
        }
        if (r.kind === "not_found") throw new ComparisonError(`member '${input}' not found in FY${kpiFy}`, 404);
        const dd2 = await loadDeepDiveData(kpiFy, undefined, r.person.nsk, { skipExtras: true });
        entities.push({
          input, name: r.person.displayName, key: r.person.nsk,
          stateHead: r.person.stateHead, hq: r.person.hq,
          isLeft: r.person.isLeft, kpis: dd2.kpis,
        });
      }
      guards.push(guard(10, "pass", "all member names resolved unambiguously"));
    } else {
      for (const input of req.entities) {
        const headName = dd.stateHeads.find((h) => h.toLowerCase() === input.trim().toLowerCase());
        if (!headName) throw new ComparisonError(`state head '${input}' not found. Known: ${dd.stateHeads.join(", ")}`, 404);
        const headDd = await loadDeepDiveData(kpiFy, headName, undefined, { skipExtras: true });
        const results = await Promise.all(
          headDd.members.map((m) => loadDeepDiveData(kpiFy, headName, m.normKey, { skipExtras: true })),
        );
        const memberKpis = results.map((r) => r.kpis).filter((k): k is MemberKpis => k != null);
        entities.push({ input, name: headName, key: headName, memberKpis });
      }
      guards.push(guard(10, "pass", "head names resolved"));
    }
  } else {
    entities = req.entities.map((e) => ({ input: e, name: e, key: e }));
    guards.push(guard(10, "notApplicable", null));
  }

  // ── Guard 1 — SOURCE ──
  const sourcesUsed: Record<string, string> = {};
  for (const m of measureSpecs) {
    const def = catalogue.find((d) => d.id === m.measure)!;
    if (!def.sources) continue;
    const defaultSource = m.source ?? def.sources[0];
    const perEntity = new Set<string>(
      entities.map((e) => m.sourceByEntity?.[e.input] ?? m.sourceByEntity?.[e.name] ?? defaultSource),
    );
    if (perEntity.size > 1) {
      guards.push(guard(1, "blocked",
        `measure '${m.measure}' would mix sources across entities: ${[...perEntity].join(" vs ")}. Both sides must use the same source — pick one of: ${def.sources.join(", ")}.`));
      return blockedResponse(guards, req, basis, channel, population, normalise, periods,
        `measure '${m.measure}' mixes sources (${[...perEntity].join(" vs ")})`);
    }
    sourcesUsed[m.measure] = defaultSource;
  }
  if (!guards.some((g) => g.id === 1)) {
    guards.push(guard(1, "pass", `single source per measure: ${JSON.stringify(sourcesUsed)}`));
  }

  // ── Guard 2 — LIKE MONTHS ──
  if (periods.length > 1) {
    const shapes0 = new Set(periods.map((p) => `${p.monthFrom}-${p.monthTo}`));
    const crossYear = new Set(periods.map((p) => p.fy)).size > 1;
    // A sub-year slice of one year may only be compared to the SAME months of
    // another year. Q1 FY2026-27 vs full FY2025-26 is partial vs complete —
    // blocked, whatever the quarter's own completeness. (Different months of
    // the SAME year are a seasonal question — guard 3.)
    if (crossYear && shapes0.size > 1) {
      const parts = periods.map((p) => `${p.label} (${p.completeness}, fiscal months ${p.monthFrom}–${p.monthTo})`);
      guards.push(guard(2, "blocked",
        `a period compares only to the same months of another year — this is partial vs complete. Requested: ${parts.join(" vs ")}. Compare like months (e.g. Q1 vs Q1) instead.`));
      return blockedResponse(guards, req, basis, channel, population, normalise, periods,
        "partial vs complete: periods in different years cover different months");
    }
    if (shapes0.size === 1 && crossYear) {
      const comp = periods.map((p) => `${p.label}: ${p.completeness}`).join("; ");
      guards.push(guard(2, "annotated", `like-months comparison: fiscal months ${periods[0].monthFrom}–${periods[0].monthTo} in each year (${comp})`));
    } else {
      guards.push(guard(2, "pass", null));
    }
  } else {
    guards.push(guard(2, "notApplicable", "single period"));
  }

  // ── Guard 3 — SEASONAL ──
  const shapes = new Set(periods.map((p) => `${p.monthFrom}-${p.monthTo}`));
  let seasonalIndices: { segment: string; byPeriod: number[] }[] | null = null;
  if (periods.length > 1 && shapes.size > 1) {
    try {
      const season = await getSeasonality("territory");
      seasonalIndices = season.segments.slice(0, 20).map((s) => ({
        segment: s.segment,
        byPeriod: periods.map((p) => {
          let share = 0;
          for (let m = p.monthFrom; m <= p.monthTo; m++) share += s.monthShare[m - 1] ?? 0;
          const flat = (p.monthTo - p.monthFrom + 1) / 12;
          return flat > 0 ? round2(share / flat) : 1; // seasonal index: 1 = flat
        }),
      }));
      const peakQ4 = season.segments.filter((s) => s.peakQuarter === 4).length;
      guards.push(guard(3, "annotated",
        `periods cover different months — each segment's seasonal index shown beside the figure (${peakQ4} of ${season.segments.length} segments peak Q4)`,
        seasonalIndices));
    } catch (err) {
      guards.push(guard(3, "annotated", "periods cover different months; seasonal curves unavailable"));
    }
  } else {
    guards.push(guard(3, "pass", null));
  }

  // ── Guard 4 — REAL TERMS ──
  const fys = [...new Set(periods.map((p) => p.fy))];
  const hasMoney = measureSpecs.some((m) => catalogue.find((d) => d.id === m.measure)!.money);
  let realIndex: { company: number | null; bySegment: Map<string, number>; pair: [string, string] } | null = null;
  if (fys.length > 1 && hasMoney) {
    const sorted = [...fys].sort();
    const fyLy = sorted[0], fyCy = sorted[sorted.length - 1];
    try {
      const [catMap, company] = await Promise.all([
        computeCategoryMultipliers(fyLy, fyCy),
        computeCompanyMultiplier(fyLy, fyCy),
      ]);
      const bySegment = new Map<string, number>();
      for (const [seg, v] of catMap) bySegment.set(seg, v.multiplier);
      realIndex = { company: company?.multiplier ?? null, bySegment, pair: [fyLy, fyCy] };
      guards.push(guard(4, "annotated",
        `cross-year money comparison — nominal AND real shown, deflated by each segment's own Laspeyres index (${fyLy} → ${fyCy}; company ${company ? round3(company.multiplier) : "n/a"}). Never one company figure across segments.`));
    } catch (err) {
      logger.warn({ err }, "comparison: Laspeyres unavailable");
      guards.push(guard(4, "annotated", "cross-year money comparison but price indices unavailable — treat nominal deltas with caution"));
    }
  } else {
    guards.push(guard(4, hasMoney ? "pass" : "notApplicable", null));
  }

  // ── Guard 5 — CHANNEL ──
  if (channel === "all") {
    guards.push(guard(5, "annotated",
      `channel=all blends territory and project. Project was ~6% of revenue but ~78% of apparent opportunity — compare on territory and view project as its own panel.`));
  } else if (channel === "project") {
    guards.push(guard(5, "annotated", "project channel shown as its own panel — never blended into a territory baseline"));
  } else {
    guards.push(guard(5, "pass", "territory channel (default)"));
  }

  // ── Guard 6 — POPULATION ──
  const leftEntities = entities.filter((e) => e.isLeft);
  if (req.entityType === "member" || req.entityType === "head") {
    if (population === "activeOnly" && leftEntities.length > 0) {
      guards.push(guard(6, "annotated",
        `left members excluded from current-period comparison (history preserved): ${leftEntities.map((e) => e.name).join(", ")}`));
    } else if (population === "includeLeft") {
      guards.push(guard(6, "annotated", "includeLeft: departed members included — do not read current-period gaps as underperformance"));
    } else {
      guards.push(guard(6, "pass", "activeOnly population; no departed members in selection"));
    }
  } else {
    guards.push(guard(6, "notApplicable", null));
  }

  // ── Guard 7 — TENURE ──
  let suppressAbsoluteVisits = false;
  // Entities whose OWN tenure is materially short vs the set — their trend gets
  // no direction (a short-tenure member's slope is mostly their start date).
  // Distinct from the set-wide ranking suppression, which fires for everyone.
  const shortTenureNames = new Set<string>();
  if (req.entityType === "member" && entities.length > 1) {
    const wds = entities.map((e) => e.kpis?.workingDaysActual ?? null);
    const known = wds.filter((w): w is number => w != null && w > 0);
    if (known.length >= 2) {
      const maxWd = Math.max(...known);
      for (const e of entities) {
        const wd = e.kpis?.workingDaysActual ?? null;
        if (wd != null && wd > 0 && maxWd / wd > TENURE_RATIO_THRESHOLD) shortTenureNames.add(e.name);
      }
      const ratio = Math.max(...known) / Math.min(...known);
      if (ratio > TENURE_RATIO_THRESHOLD) {
        suppressAbsoluteVisits = true;
        guards.push(guard(7, "annotated",
          `working days differ materially (${entities.map((e) => `${e.name}: ${e.kpis?.workingDaysActual ?? "?"}`).join(", ")}; ratio ${round2(ratio)}×). Absolute visit counts suppressed — compare per-working-day figures instead.`));
      } else {
        guards.push(guard(7, "pass", `working days comparable (ratio ${round2(ratio)}×)`));
      }
    } else {
      guards.push(guard(7, "pass", "working days unavailable for one or both sides"));
    }
  } else {
    guards.push(guard(7, "notApplicable", null));
  }

  // ── Guards 8 + 9 — ZERO TARGET / NO BUSINESS (per member/head entity) ──
  const zeroTargetNames: string[] = [];
  const noBusinessNames: string[] = [];
  const likeForLike: NonNullable<ComparisonResponse["likeForLike"]> = [];
  if (req.entityType === "member") {
    for (const e of entities) {
      const t = e.kpis?.totalTargetToDate ?? null;
      const biz = (e.kpis?.orderBooking ?? 0) + (e.kpis?.directDealersOrder ?? 0) + (e.kpis?.sale ?? 0);
      if (t == null || t <= 0) {
        if (biz <= 0) noBusinessNames.push(e.name);
        else zeroTargetNames.push(e.name);
      }
    }
  } else if (req.entityType === "head") {
    for (const e of entities) {
      const members = (e.memberKpis ?? []).filter((k) => !k.isLeft || population === "includeLeft");
      const untargeted = members.filter((k) => (k.totalTargetToDate ?? 0) <= 0);
      for (const k of untargeted) {
        const biz = (k.orderBooking ?? 0) + (k.directDealersOrder ?? 0) + (k.sale ?? 0);
        if (biz <= 0) noBusinessNames.push(k.name); else zeroTargetNames.push(k.name);
      }
      const sumOb = (ks: MemberKpis[]) =>
        ks.reduce((a, k) => a + (k.orderBooking ?? 0) + (k.directDealersOrder ?? 0), 0);
      const sumT = (ks: MemberKpis[]) => ks.reduce((a, k) => a + (k.totalTargetToDate ?? 0), 0);
      const targeted = members.filter((k) => (k.totalTargetToDate ?? 0) > 0);
      const headlineT = sumT(members);
      likeForLike.push({
        entity: e.name,
        headlineAchievement: headlineT > 0 ? round3(sumOb(members) / headlineT) : null,
        likeForLikeAchievement: sumT(targeted) > 0 ? round3(sumOb(targeted) / sumT(targeted)) : null,
        untargetedMembers: untargeted.map((k) => k.name),
      });
    }
  }
  if (zeroTargetNames.length > 0 || likeForLike.some((l) => l.untargetedMembers.length > 0)) {
    const names = [...new Set([...zeroTargetNames, ...likeForLike.flatMap((l) => l.untargetedMembers)])];
    guards.push(guard(8, "annotated",
      `untargeted members read "no target recorded", never 0%: ${names.join(", ")}. Group achievement reported headline AND like-for-like.`));
  } else {
    guards.push(guard(8, req.entityType === "member" || req.entityType === "head" ? "pass" : "notApplicable", null));
  }
  if (noBusinessNames.length > 0) {
    guards.push(guard(9, "annotated",
      `no target and no recorded business — undefined, not zero, and excluded from ranking: ${[...new Set(noBusinessNames)].join(", ")}`));
  } else {
    guards.push(guard(9, req.entityType === "member" || req.entityType === "head" ? "pass" : "notApplicable", null));
  }

  // ── Guard 11 — SAMPLE (evaluated during matrix build; register intent here) ──
  const wantsCorrelation = measureSpecs.some((m) => m.measure === "correlation");
  // pushed after matrix build below.

  // ── Guard 12 — FROZEN ──
  // The anchor is the frozen register itself: closed-FY totals from
  // sale_line_current, which the anchors file reconciles against.
  try {
    const anchorNotes: string[] = [];
    for (const fy of fys) {
      if (fy === currentFy) continue;
      const r = await one(sql`
        SELECT coalesce(sum(amount::float8),0) AS v FROM sale_line_current WHERE fy = ${fy}`);
      const total = Number(r.v);
      if (total > 0) {
        anchorNotes.push(`FY${fy} frozen anchor ₹${(total / 1e7).toFixed(2)} Cr (frozen register total)`);
      }
    }
    if (anchorNotes.length > 0) {
      guards.push(guard(12, "annotated", `comparison against closed year(s): ${anchorNotes.join("; ")}`));
    } else {
      guards.push(guard(12, "pass", null));
    }
  } catch {
    guards.push(guard(12, "pass", "anchors file unavailable"));
  }

  // ── Value matrix ──
  const matrix: MatrixRow[] = [];
  let correlationSuppressed: string | null = null;

  for (const e of entities) {
    for (const m of measureSpecs) {
      const def = catalogue.find((d) => d.id === m.measure)!;
      const row: MatrixRow = {
        entity: e.name,
        measure: def.id,
        measureLabel: def.label,
        source: sourcesUsed[def.id] ?? null,
        flags: [],
        cells: [],
      };
      const noBiz = noBusinessNames.includes(e.name);
      if (noBiz) { row.excludeFromRanking = true; row.flags!.push("NO BUSINESS"); }
      if (!noBiz && zeroTargetNames.includes(e.name)) row.flags!.push("NO TARGET");
      if (suppressAbsoluteVisits) {
        row.flags!.push("TENURE");
        if (!PER_UNIT_MEASURE_IDS.has(def.id)) {
          row.rankEligible = false;
          row.rankBlockReason = "tenure guard fired (working days differ materially) — ranking on an unnormalised measure would mislead; sort a per-day or ratio column instead";
        }
      }

      for (let pIdx = 0; pIdx < periods.length; pIdx++) {
        const p = periods[pIdx];
        let cell: CellValue = { value: null };
        try {
          const baselineP = def.periodPair ? baselineFor(pIdx) : null;
          if (def.periodPair && !baselineP) {
            cell = {
              value: null,
              note: periods.length > 1
                ? `'${def.id}' is a period-pair measure — ${p.label} is the first period in the trajectory, so it has no earlier baseline in this request (pass 'baseline' to supply one)`
                : `'${def.id}' is a period-pair measure — "new" only means anything against a baseline. Pass 'baseline' (a period spec) to enable it; without one the measure is disabled, not zero.`,
            };
          } else if (def.fyToDateOnly && !(p.spec.kind === "fy" || p.spec.kind === "ytd") && p.fy === currentFy) {
            cell = { value: null, note: `'${def.id}' is a Data-tab FY-to-date figure; it cannot be filtered to ${p.label}. Use kind:'ytd' or the period-exact 'registerOb'.` };
          } else {
            cell = await computeCell(req.entityType, e, def, m, p, basis, channel, currentFy, baselineP);
          }
          // Guard 8/9 overlays
          if ((def.id === "target" || def.id === "achievement") && (zeroTargetNames.includes(e.name) || noBiz)) {
            cell = { value: null, note: noBiz ? "no target and no recorded business — not recorded yet" : "no target recorded" };
          }
          if (noBiz && def.money) {
            cell = { value: null, note: "not recorded yet" };
          }
          // Guard 7 overlay
          if (def.id === "visits" && suppressAbsoluteVisits) {
            cell = { value: null, suppressed: true, note: "absolute visits suppressed under the tenure guard — see visitsPerDay" };
          }
          // Guard 11 overlay
          if (def.id === "correlation" && typeof cell.value === "string" && cell.value.startsWith("SUPPRESSED")) {
            const n = cell.note ?? "";
            correlationSuppressed = n;
            if (!row.flags!.includes("INSUFFICIENT SAMPLE")) row.flags!.push("INSUFFICIENT SAMPLE");
            cell = { value: null, suppressed: true, note: n };
          }
          // Guard 4 overlay: real terms for cross-year money
          if (def.money && realIndex && typeof cell.value === "number" && p.fy === realIndex.pair[1]) {
            const idx = req.entityType === "segment"
              ? realIndex.bySegment.get(e.name) ?? realIndex.company
              : realIndex.company;
            if (idx && idx > 0) {
              cell.real = round2(cell.value / idx);
              cell.realIndex = round3(idx);
              cell.realIndexName = req.entityType === "segment"
                ? `Laspeyres ${e.name} (${realIndex.pair[0]}→${realIndex.pair[1]})`
                : `Laspeyres company (${realIndex.pair[0]}→${realIndex.pair[1]})`;
            }
          }
        } catch (err) {
          logger.warn({ err, entity: e.name, measure: def.id }, "comparison cell failed");
          cell = { value: null, note: `could not compute: ${err instanceof Error ? err.message : String(err)}` };
        }
        row.cells.push(cell);
      }
      matrix.push(row);
    }
  }

  if (wantsCorrelation) {
    guards.push(correlationSuppressed
      ? guard(11, "annotated", correlationSuppressed)
      : guard(11, "pass", `correlation sample ≥ ${MIN_CORRELATION_SAMPLE}`));
  } else {
    guards.push(guard(11, "notApplicable", null));
  }

  // ── Mode C: trend (level + direction) per row, quadrants per measure ──
  let quadrants: QuadrantView[] | undefined;
  if (periods.length > 1) {
    for (const row of matrix) {
      const tenureBlocked = shortTenureNames.has(row.entity);
      const used: { idx: number; v: number; label: string }[] = [];
      const excluded: { label: string; reason: string }[] = [];
      row.cells.forEach((c, i) => {
        const p = periods[i];
        const v = (c.real ?? c.value);
        if (typeof v !== "number") {
          excluded.push({ label: p.label, reason: c.note ?? (p.completeness === "noActualsRecorded" ? "no actuals recorded" : "no numeric value") });
        } else if (p.completeness !== "complete") {
          excluded.push({ label: p.label, reason: `period is ${p.completeness} — a partial period would fake a fall` });
        } else {
          used.push({ idx: i, v, label: p.label });
        }
      });
      // LEVEL: the latest period with a numeric value (partial allowed, but said so).
      let level: number | null = null, levelPeriod: string | null = null, levelIsPartial = false;
      for (let i = row.cells.length - 1; i >= 0; i--) {
        const v = (row.cells[i].real ?? row.cells[i].value);
        if (typeof v === "number") { level = v; levelPeriod = periods[i].label; levelIsPartial = periods[i].completeness !== "complete"; break; }
      }
      // DIRECTION: least-squares slope over complete periods only.
      let direction: number | null = null, directionBasis: string | null = null;
      if (tenureBlocked) {
        directionBasis = "no direction — this member's working days are materially fewer than peers (tenure guard); a slope would mostly measure their start date";
      } else if (used.length < 2) {
        directionBasis = `no direction — only ${used.length} complete numeric period(s); a slope needs at least 2`;
      } else {
        const n = used.length;
        // x = the period's actual position in the requested sequence, so a gap
        // (e.g. an excluded partial Q2 between Q1 and Q3) counts as two steps,
        // not one — otherwise the "per period step" claim would be wrong.
        const mx = used.reduce((a, u) => a + u.idx, 0) / n;
        const my = used.reduce((a, u) => a + u.v, 0) / n;
        let num = 0, den = 0;
        used.forEach((u) => { num += (u.idx - mx) * (u.v - my); den += (u.idx - mx) ** 2; });
        direction = den > 0 ? round3(num / den) : 0;
        const real = row.cells.some((c) => c.real != null);
        directionBasis = `least-squares slope per period step over ${n} complete periods${real ? " (real terms where available)" : ""}`;
      }
      row.trend = { level, levelPeriod, ...(levelIsPartial ? { levelIsPartial } : {}), direction, directionBasis, usedPeriods: used.map((u) => u.label), excludedPeriods: excluded };
    }

    if (entities.length > 1) {
      quadrants = [];
      for (const m of measureSpecs) {
        const def = catalogue.find((d) => d.id === m.measure)!;
        const rows = matrix.filter((r) => r.measure === def.id);
        const eligible = rows.filter((r) => r.trend?.level != null && r.trend?.direction != null && !r.excludeFromRanking);
        const noDirection = rows
          .filter((r) => !eligible.includes(r))
          .map((r) => ({
            entity: r.entity,
            reason: r.excludeFromRanking ? "excluded from ranking (guard 9 — no target and no recorded business)"
              : r.trend?.level == null ? "no usable level value"
              : (r.trend?.directionBasis ?? "no direction"),
          }));
        if (eligible.length < 2) {
          quadrants.push({ measure: def.id, measureLabel: def.label, levelSplit: 0,
            splitRule: `quadrants need at least 2 entities with a level and a direction; ${eligible.length} qualify`, groups: [], noDirection });
          continue;
        }
        const levels = eligible.map((r) => r.trend!.level!).sort((a, b) => a - b);
        const mid = Math.floor(levels.length / 2);
        const levelSplit = levels.length % 2 ? levels[mid] : (levels[mid - 1] + levels[mid]) / 2;
        const mk = (q: QuadrantGroup["quadrant"], label: string, f: (l: number, d: number) => boolean): QuadrantGroup => ({
          quadrant: q, label,
          entities: eligible
            .filter((r) => f(r.trend!.level!, r.trend!.direction!))
            .map((r) => ({ entity: r.entity, level: r.trend!.level!, direction: r.trend!.direction! }))
            .sort((a, b) => a.direction - b.direction),
        });
        quadrants.push({
          measure: def.id, measureLabel: def.label,
          levelSplit: round3(levelSplit),
          splitRule: "level split at the median of entity levels; direction split at slope 0 — both stated, never a hidden threshold",
          groups: [
            mk("high-falling", "high level, falling — the early-warning quadrant", (l, d) => l >= levelSplit && d < 0),
            mk("low-falling", "low level, falling — the intervention list", (l, d) => l < levelSplit && d < 0),
            mk("high-rising", "high level, rising — performing and improving", (l, d) => l >= levelSplit && d >= 0),
            mk("low-rising", "low level, rising — recovering, leave alone", (l, d) => l < levelSplit && d >= 0),
          ],
          noDirection,
        });
      }
    }
  }

  // ── Mode C: roster changes per head when periods span FYs ──
  let rosterChanges: RosterChange[] | undefined;
  if (req.entityType === "head" && fys.length > 1) {
    rosterChanges = [];
    const fyOrder: string[] = [];
    for (const p of periods) if (!fyOrder.includes(p.fy)) fyOrder.push(p.fy);
    for (const e of entities) {
      const rosterByFy = new Map<string, Set<string> | null>();
      for (const fy of fyOrder) {
        try {
          const dd = await loadDeepDiveData(fy, e.name, undefined, { skipExtras: true });
          rosterByFy.set(fy, new Set(dd.members.map((m) => m.name)));
        } catch { rosterByFy.set(fy, null); }
      }
      for (let i = 1; i < fyOrder.length; i++) {
        const a = rosterByFy.get(fyOrder[i - 1]), b = rosterByFy.get(fyOrder[i]);
        if (!a || !b) {
          rosterChanges.push({ entity: e.name, fromFy: fyOrder[i - 1], toFy: fyOrder[i], joiners: [], leavers: [],
            note: `roster unavailable for ${!a ? fyOrder[i - 1] : fyOrder[i]} — membership change cannot be verified for this pair` });
          continue;
        }
        const joiners = [...b].filter((n) => !a.has(n)).sort();
        const leavers = [...a].filter((n) => !b.has(n)).sort();
        if (joiners.length || leavers.length) {
          rosterChanges.push({ entity: e.name, fromFy: fyOrder[i - 1], toFy: fyOrder[i], joiners, leavers,
            note: `the head's direction can move purely from membership — ${joiners.length} joined, ${leavers.length} left between FY${fyOrder[i - 1]} and FY${fyOrder[i]}` });
        }
      }
    }
    if (rosterChanges.length === 0) rosterChanges = undefined;
    else notes.push("roster changed between compared years for: " + [...new Set(rosterChanges.map((r) => r.entity))].join(", ") + " — see rosterChanges before reading a head's direction as performance");
  }

  // ── C4: suggestion layer — built ONLY from eligible quadrant entries and
  // roster facts already computed above; nothing here invents a new figure. ──
  let suggestions: Suggestion[] | undefined;
  if (quadrants?.length || rosterChanges?.length) {
    suggestions = [];
    const rosterByEntity = new Map<string, RosterChange[]>();
    for (const rc of rosterChanges ?? []) {
      const list = rosterByEntity.get(rc.entity) ?? [];
      list.push(rc); rosterByEntity.set(rc.entity, list);
    }
    const rowOf = (measure: string, entity: string) =>
      matrix.find((r) => r.measure === measure && r.entity === entity);
    for (const q of quadrants ?? []) {
      const falling = q.groups.filter((g) => g.quadrant === "high-falling" || g.quadrant === "low-falling");
      for (const g of falling) {
        for (const e of g.entities) { // already sorted steepest fall first
          const row = rowOf(q.measure, e.entity);
          // Guard 7 marks unnormalised measures rankEligible:false under the
          // tenure guard — a median-relative suggestion from such a row would
          // assert exactly the ranking the guard forbids. Skip it.
          if (row?.rankEligible === false) continue;
          const t = row?.trend;
          const caveats: string[] = [];
          for (const rc of rosterByEntity.get(e.entity) ?? []) caveats.push(rc.note);
          suggestions.push({
            rank: 0, // assigned after global sort
            kind: g.quadrant === "high-falling" ? "high-falling" : "low-falling",
            entity: e.entity, measure: q.measure, measureLabel: q.measureLabel,
            action: g.quadrant === "high-falling"
              ? `Review ${e.entity} first — ${q.measureLabel} is still above the group median but falling; this is the cheapest moment to intervene.`
              : `Put ${e.entity} on the intervention list — ${q.measureLabel} is below the group median and still falling.`,
            evidence: `level ${e.level} (${t?.levelPeriod ?? "latest period"}${t?.levelIsPartial ? ", partial period" : ""}) vs group median split ${q.levelSplit}; direction ${e.direction} per period step over ${t?.usedPeriods.join(", ") ?? "complete periods"}. ${t?.directionBasis ?? ""}`.trim(),
            level: e.level, direction: e.direction,
            caveats,
          });
        }
      }
    }
    // Roster-context suggestions for entities not already covered by a falling entry.
    const covered = new Set(suggestions.map((sg) => sg.entity));
    for (const [entity, rcs] of rosterByEntity) {
      if (covered.has(entity)) continue;
      suggestions.push({
        rank: 0, kind: "roster-context", entity,
        action: `Read ${entity}'s trend with the roster change in mind before acting on it.`,
        evidence: rcs.map((rc) => `${rc.fromFy}→${rc.toFy}: ${rc.joiners.length} joined, ${rc.leavers.length} left`).join("; "),
        caveats: rcs.map((rc) => rc.note),
      });
    }
    // Order: high-falling (steepest fall first), then low-falling, then roster-context.
    const kindOrder = { "high-falling": 0, "low-falling": 1, "roster-context": 2 } as const;
    suggestions.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.direction ?? 0) - (b.direction ?? 0));
    suggestions = suggestions.slice(0, 12);
    suggestions.forEach((sg, i) => { sg.rank = i + 1; });
    if (suggestions.length === 0) suggestions = undefined;
  }

  guards.sort((a, b) => a.id - b.id);

  return {
    blocked: false,
    basis: {
      entityType: req.entityType,
      basis, channel, channelLabel: channelLabel(channel), population, normalise,
      periods: periods.map((p) => ({ label: p.label, fy: p.fy, completeness: p.completeness, months: p.monthLabels })),
      sources: sourcesUsed,
    },
    guards,
    matrix,
    ...(quadrants ? { quadrants } : {}),
    ...(rosterChanges ? { rosterChanges } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(likeForLike.length > 0 ? { likeForLike } : {}),
    notes,
  };
}

function blockedResponse(
  guards: GuardResult[],
  req: ComparisonRequest,
  basis: "primary" | "secondary",
  channel: string, population: string, normalise: string,
  periods: ResolvedPeriod[],
  reason: string,
): BlockedResponse {
  // Fill the unevaluated guards as notApplicable so the report is always 12 long.
  for (let i = 1; i <= 12; i++) {
    if (!guards.some((g) => g.id === i)) guards.push(guard(i, "notApplicable", "not evaluated — comparison blocked earlier"));
  }
  guards.sort((a, b) => a.id - b.id);
  return {
    blocked: true,
    reason,
    guards,
    basis: {
      entityType: req.entityType,
      basis, channel: channel as any, channelLabel: channelLabel(channel as any),
      population: population as any, normalise,
      periods: periods.map((p) => ({ label: p.label, fy: p.fy, completeness: p.completeness, months: p.monthLabels })),
    },
  };
}

/** Scope statement repeated on every response — the figures below only make
 *  sense against other figures with the SAME channel scope. */
function channelLabel(channel: "territory" | "project" | "all"): string {
  if (channel === "territory") {
    return "TERRITORY ONLY — project & institutional (Non-territory / Project / Govt) business is EXCLUDED. Do not compare these figures against all-channel totals from other pages; the register's all-channel figure is higher by the project amount.";
  }
  if (channel === "project") {
    return "PROJECT / INSTITUTIONAL CHANNEL ONLY — territory business is excluded.";
  }
  return "ALL CHANNELS — territory plus project/institutional blended. Guard 5 flags this; prefer territory with project as its own panel.";
}

// ── Cell computation ─────────────────────────────────────────────────────────

async function computeCell(
  entityType: EntityType,
  e: ResolvedEntity,
  def: MeasureDef,
  m: MeasureSpec,
  p: ResolvedPeriod,
  basis: "primary" | "secondary",
  channel: "territory" | "project" | "all",
  currentFy: string,
  baselineP: ResolvedPeriod | null = null,
): Promise<CellValue> {
  if (p.completeness === "noActualsRecorded") {
    return { value: null, note: "not recorded yet — the period has a plan but no actuals" };
  }

  switch (entityType) {
    case "company": {
      const r = await one(sql`
        SELECT coalesce(sum(amount::float8),0) AS v, coalesce(sum(qty::float8),0) AS q
        FROM sale_line_current WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)} AND ${channelFilter(channel)}`);
      return { value: def.id === "quantity" ? Number(r.q) : Number(r.v) };
    }
    case "segment": {
      const r = await one(sql`
        SELECT coalesce(sum(amount::float8),0) AS v, coalesce(sum(qty::float8),0) AS q,
               count(DISTINCT customer)::int AS c, count(DISTINCT code)::int AS b
        FROM sale_line_current
        WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)} AND ${channelFilter(channel)}
          AND coalesce(group_canon, group_raw, 'Uncategorized') = ${e.key}`);
      if (def.id === "net") return { value: Number(r.v) };
      if (def.id === "quantity") return { value: Number(r.q) };
      if (def.id === "customersBuying") return { value: Number(r.c) };
      return { value: Number(r.b) };
    }
    case "code": {
      const r = await one(sql`
        SELECT coalesce(sum(amount::float8),0) AS v, coalesce(sum(qty::float8),0) AS q,
               count(DISTINCT customer)::int AS c
        FROM sale_line_current
        WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)} AND ${channelFilter(channel)} AND code = ${e.key}`);
      if (def.id === "net") return { value: Number(r.v) };
      if (def.id === "quantity") return { value: Number(r.q) };
      if (def.id === "customersBuying") return { value: Number(r.c) };
      // C2b: register discount measures — SECONDARY SKU register, named so.
      if (def.id === "effectiveDiscount" || def.id === "discountVariance") {
        const d = await one(sql`
          WITH perCust AS (
            -- RET# is the retailer identity when present (task 172): same-name
            -- distinct retailers must not merge; same-RET# spellings must not split.
            SELECT coalesce(nullif(trim(retailer_id), ''), lower(trim(retailer))) AS rk,
                   sum(net_amount::float8) AS v,
                   sum(discount_pct::float8 * net_amount::float8) / nullif(sum(net_amount::float8), 0) AS avg_d
            FROM secondary_sku_line
            WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)} AND upper(trim(item_code)) = upper(trim(${e.key}))
              AND discount_pct IS NOT NULL AND net_amount IS NOT NULL
            GROUP BY 1
          )
          SELECT count(*)::int AS custs,
                 sum(avg_d * v) / nullif(sum(v), 0) AS wavg,
                 max(avg_d) - min(avg_d) AS spread
          FROM perCust WHERE avg_d IS NOT NULL`);
        const srcNote = "secondary SKU register Discount column — a DIFFERENT measure from the primary MRP discount";
        if (def.id === "effectiveDiscount") {
          return Number(d.custs) > 0 && d.wavg != null
            ? { value: round2(Number(d.wavg)), note: `${srcNote}; net-weighted average over ${d.custs} customers` }
            : { value: null, note: `not recorded — no secondary SKU rows with a discount for this code in ${p.label}` };
        }
        return Number(d.custs) >= 2 && d.spread != null
          ? { value: round2(Number(d.spread)), note: `${srcNote}; max − min customer-average discount across ${d.custs} customers` }
          : { value: null, note: `undefined — a spread needs at least 2 customers with a recorded discount (found ${d.custs ?? 0})` };
      }
      return { value: Number(r.c) };
    }
    case "distributor": {
      // C2b period-pair: new codes vs the baseline period, from sale_line.
      if (def.id === "newSkusExistingCount" || def.id === "newSkusExistingValue") {
        const r = await one(sql`
          WITH base AS (
            SELECT DISTINCT code FROM sale_line_current
            WHERE fy = ${baselineP!.fy} AND month_label IN (${sql.join(baselineP!.monthLabels.map((l) => sql`${l}`), sql`, `)})
              AND lower(trim(customer)) = lower(trim(${e.key}))
          ),
          cur AS (
            SELECT code, sum(amount::float8) AS v FROM sale_line_current
            WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)}
              AND lower(trim(customer)) = lower(trim(${e.key}))
            GROUP BY 1
          )
          SELECT count(*)::int AS n, coalesce(sum(cur.v),0) AS v
          FROM cur WHERE cur.code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM base WHERE base.code = cur.code)`);
        return {
          value: def.id === "newSkusExistingCount" ? Number(r.n) : Number(r.v),
          note: `codes bought in ${p.label} that this distributor did not buy in the baseline ${baselineP!.label}`,
        };
      }
      const sale = await one(sql`
        SELECT coalesce(sum(amount::float8),0) AS v, count(DISTINCT code)::int AS b
        FROM sale_line_current
        WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)} AND lower(trim(customer)) = lower(trim(${e.key}))`);
      if (def.id === "primarySale") return { value: Number(sale.v) };
      if (def.id === "skuBreadth") return { value: Number(sale.b) };
      const ob = await one(sql`
        SELECT coalesce(sum(amount::float8),0) AS v
        FROM primary_order_line
        WHERE fy = ${p.fy} AND lower(trim(customer)) = lower(trim(${e.key}))`);
      if (def.id === "primaryOb") return { value: Number(ob.v), note: "primary OB is FY-level (order sheet has no month column)" };
      return { value: Math.max(0, Number(ob.v) - Number(sale.v)), note: "pending = FY OB − period sale; use full-FY periods for a clean read" };
    }
    case "retailer": {
      const r = await one(sql`
        SELECT coalesce(sum(net_amount::float8),0) AS v, max(month_label) AS lm
        FROM secondary_register_line
        WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)} AND lower(trim(customer)) = lower(trim(${e.key}))`);
      if (def.id === "secondaryOb") {
        const note = p.fy === currentFy ? "live-year register coverage is Apr–Jun only — July is not in the register" : null;
        return { value: Number(r.v), ...(note ? { note } : {}) };
      }
      return { value: r.lm ?? null };
    }
    case "member":
    case "head": {
      return computeMemberCell(entityType, e, def, m, p, currentFy, baselineP);
    }
  }
}

// ── C2b: cost cell — pure, exported for the guard-regression unit test. ──
// Contract (must never regress silently):
//   • cost sums ONLY members with recorded cost (blank cost is NOT zero cost);
//   • the DENOMINATOR (visits / OB / sales) sums ALL active members — a
//     recorded-members-only denominator would overstate the ratio;
//   • partially missing cost annotates the cell with the full-team wording;
//   • zero denominator → UNDEFINED note (never 0, never Infinity);
//   • no cost recorded at all → 'not recorded' note.
export type CostKpisLike = Pick<
  MemberKpis,
  "ctcMonthly" | "elapsedMonthsFromSheet" | "elapsedMonths" | "taBillStCost"
  | "totalVisitsYtd" | "orderBooking" | "directDealersOrder" | "sale"
>;

export function computeCostCell(
  defId: "costPerVisit" | "costRatioOb" | "costRatioSales",
  ks: CostKpisLike[],
): CellValue {
  const memberCost = (k: CostKpisLike): number | null => {
    if (k.ctcMonthly == null) return null; // blank cost is NOT zero cost
    const elapsed = k.elapsedMonthsFromSheet ?? k.elapsedMonths;
    if (elapsed == null) return null;
    return k.ctcMonthly * elapsed + (k.taBillStCost ?? 0);
  };
  const recorded = ks.filter((k) => memberCost(k) != null);
  if (recorded.length === 0) {
    return { value: null, note: "not recorded — no CTC/elapsed-months data on the Data tab for this entity; a blank cost cell is not a zero cost" };
  }
  // Cost sums over members WITH recorded cost; denominators (visits, OB,
  // sales) sum over ALL active members — otherwise a head's ratio would
  // silently drop the excluded members' activity and overstate the ratio.
  const cost = recorded.reduce((s, k) => s + (memberCost(k) as number), 0);
  const missing = ks.length - recorded.length;
  const missNote = missing > 0 ? `; cost missing for ${missing} of ${ks.length} members (their cost is excluded — the denominator still covers all members)` : "";
  if (defId === "costPerVisit") {
    const v = ks.reduce((s, k) => s + (k.totalVisitsYtd ?? 0), 0);
    return v > 0
      ? { value: round2(cost / v), note: `cost = CTC × BD elapsed months + YTD travel; visits = Data tab column AF (all-type cumulative)${missNote}` }
      : { value: null, note: `undefined — no visits recorded (column AF); cost ₹${round2(cost)} cannot be spread over zero visits${missNote}` };
  }
  if (defId === "costRatioOb") {
    const ob = ks.reduce((s, k) => s + (k.orderBooking ?? 0) + (k.directDealersOrder ?? 0), 0);
    return ob > 0
      ? { value: round2((cost / ob) * 100), note: `cost ÷ secondary OB (I + J), as %${missNote}` }
      : { value: null, note: `UNDEFINED — order booking is 0; a ratio on zero is not infinite and not zero${missNote}` };
  }
  const sales = ks.reduce((s, k) => s + (k.sale ?? 0), 0);
  return sales > 0
    ? { value: round2((cost / sales) * 100), note: `cost ÷ sales received (AY), as %${missNote}` }
    : { value: null, note: `UNDEFINED — sales received is 0, so cost ÷ sales does not exist (not infinite, not zero). The OB ratio 'costRatioOb' still computes${missNote}` };
}

async function computeMemberCell(
  entityType: "member" | "head",
  e: ResolvedEntity,
  def: MeasureDef,
  m: MeasureSpec,
  p: ResolvedPeriod,
  currentFy: string,
  baselineP: ResolvedPeriod | null = null,
): Promise<CellValue> {
  // Register-backed member/head measures aggregate over MEMBER names —
  // register head_canon holds member names, not the state head's own name.
  const names = entityType === "head" ? (e.memberKpis ?? []).map((k) => k.name) : [e.name];
  const nameIn = names.length > 0
    ? sql.join(names.map((n) => sql`lower(trim(${n}))`), sql`, `)
    : null;

  // ── C2b: period-pair measures (work for ANY period, like registerOb) ──
  if (def.id === "newSkusExistingCount" || def.id === "newSkusExistingValue") {
    if (!nameIn) return { value: null, note: "no members resolved for this head" };
    const bMonths = sql.join(baselineP!.monthLabels.map((l) => sql`${l}`), sql`, `);
    // Retailer identity (task 172): match by RET# when BOTH sides carry one;
    // fall back to the name key when either side lacks an ID. A plain
    // coalesce key would mis-declare every pair "new" across periods with
    // asymmetric RET# coverage.
    const r = await one(sql`
      WITH base AS (
        SELECT DISTINCT nullif(trim(retailer_id), '') AS rid, lower(trim(retailer)) AS rname, upper(trim(item_code)) AS code
        FROM secondary_sku_line
        WHERE fy = ${baselineP!.fy} AND month_label IN (${bMonths})
          AND lower(trim(head_canon)) IN (${nameIn}) AND retailer IS NOT NULL
      ),
      cur AS (
        SELECT nullif(trim(retailer_id), '') AS rid, lower(trim(retailer)) AS rname, upper(trim(item_code)) AS code,
               sum(net_amount::float8) AS v
        FROM secondary_sku_line
        WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)}
          AND lower(trim(head_canon)) IN (${nameIn}) AND retailer IS NOT NULL
        GROUP BY 1, 2, 3
      )
      SELECT count(*)::int AS n, coalesce(sum(cur.v), 0) AS v
      FROM cur
      WHERE EXISTS (
        SELECT 1 FROM base b WHERE
          CASE WHEN cur.rid IS NOT NULL AND b.rid IS NOT NULL
               THEN b.rid = cur.rid ELSE b.rname = cur.rname END
      )
      AND NOT EXISTS (
        SELECT 1 FROM base b WHERE b.code = cur.code AND
          CASE WHEN cur.rid IS NOT NULL AND b.rid IS NOT NULL
               THEN b.rid = cur.rid ELSE b.rname = cur.rname END
      )`);
    return {
      value: def.id === "newSkusExistingCount" ? Number(r.n) : Number(r.v),
      note: `(retailer, code) pairs in ${p.label} where the retailer had business in the baseline ${baselineP!.label} but not this code — secondary SKU register`,
    };
  }
  if (def.id === "newCustomersCount" || def.id === "newCustomersValue") {
    if (!nameIn) return { value: null, note: "no members resolved for this head" };
    const bMonths = sql.join(baselineP!.monthLabels.map((l) => sql`${l}`), sql`, `);
    const r = await one(sql`
      WITH base AS (
        SELECT DISTINCT lower(trim(customer)) AS rk FROM secondary_register_line
        WHERE fy = ${baselineP!.fy} AND month_label IN (${bMonths})
          AND lower(trim(head_canon)) IN (${nameIn}) AND customer IS NOT NULL
      ),
      cur AS (
        SELECT lower(trim(customer)) AS rk, sum(net_amount::float8) AS v
        FROM secondary_register_line
        WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)}
          AND lower(trim(head_canon)) IN (${nameIn}) AND customer IS NOT NULL
        GROUP BY 1
      )
      SELECT count(*)::int AS n, coalesce(sum(cur.v), 0) AS v
      FROM cur WHERE cur.rk IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM base WHERE base.rk = cur.rk)`);
    return {
      value: def.id === "newCustomersCount" ? Number(r.n) : Number(r.v),
      note: `retailers with business in ${p.label} and none in the baseline ${baselineP!.label} — secondary register`,
    };
  }

  // ── C2b: period-capable coverage measures from the secondary SKU register ──
  if (def.id === "segmentCoverage" || def.id === "skuBreadthShare") {
    if (!nameIn) return { value: null, note: "no members resolved for this head" };
    if (def.id === "segmentCoverage") {
      const r = await one(sql`
        SELECT
          (SELECT count(DISTINCT segment_canon)::int FROM secondary_sku_line
            WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)}
              AND lower(trim(head_canon)) IN (${nameIn}) AND segment_canon IS NOT NULL) AS sold,
          (SELECT count(DISTINCT segment_canon)::int FROM secondary_sku_line
            WHERE fy = ${p.fy} AND segment_canon IS NOT NULL) AS avail`);
      const avail = Number(r.avail);
      if (avail === 0) return { value: null, note: `undefined — no segments recorded company-wide in FY${p.fy}'s secondary SKU register` };
      return { value: round2((Number(r.sold) / avail) * 100), note: `${r.sold} of ${avail} segments available (sold company-wide in FY${p.fy}) — secondary SKU register` };
    }
    const r = await one(sql`
      SELECT
        (SELECT count(DISTINCT upper(trim(item_code)))::int FROM secondary_sku_line
          WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)}
            AND lower(trim(head_canon)) IN (${nameIn})) AS bought,
        (SELECT count(DISTINCT upper(trim(item_code)))::int FROM secondary_sku_line) AS ever`);
    const ever = Number(r.ever);
    if (ever === 0) return { value: null, note: "undefined — no codes ever sold in the secondary SKU register" };
    return { value: round2((Number(r.bought) / ever) * 100), note: `${r.bought} of ${ever} codes ever sold company-wide (all FYs) — secondary SKU register` };
  }

  // ── C2b: head-only gap value from the SKU push list ──
  if (def.id === "gapValue") {
    const { getSkuRecommendations } = await import("../sku/skuRecommendations.js");
    const rec = await getSkuRecommendations({
      fy: p.fy, monthLabels: p.monthLabels, level: "distributor", scope: "head", scopeId: e.name,
    });
    return { value: rec.totalGapNet ?? null, note: "total actionable segment gap (gapNet) from the SKU push list — territory only" };
  }

  // Period-exact register OB works for any period. Register head_canon holds
  // MEMBER names, so a head entity aggregates over its members' names.
  if (def.id === "registerOb") {
    if (!nameIn) return { value: null, note: "no members resolved for this head" };
    const r = await one(sql`
      SELECT coalesce(sum(net_amount::float8),0) AS v
      FROM secondary_register_line
      WHERE fy = ${p.fy} AND ${monthIn(p.monthLabels)}
        AND lower(trim(head_canon)) IN (${nameIn})`);
    return {
      value: Number(r.v),
      note: entityType === "head"
        ? `period-exact register OB summed over ${names.length} member names (register head names are member names)`
        : "period-exact, from the secondary register (register head names are member names)",
    };
  }

  // Everything else is a Data-tab FY-to-date figure for the CURRENT FY.
  if (p.fy !== currentFy) {
    return { value: null, note: `Data-tab measures exist only for the current FY dashboard; ${p.label} has no Data tab. Use 'registerOb' for historical periods.` };
  }

  const agg = (fn: (k: MemberKpis) => number | null): number | null => {
    if (entityType === "member") return e.kpis ? fn(e.kpis) : null;
    const ks = (e.memberKpis ?? []).filter((k) => !k.isLeft);
    const vals = ks.map(fn).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  switch (def.id) {
    case "secondaryOb":
      return { value: agg((k) => (k.orderBooking ?? 0) + (k.directDealersOrder ?? 0)), note: "OB = retailer/party + direct dealer (I+J)" };
    case "salesReceived":
      return { value: agg((k) => k.sale) };
    case "target":
      return { value: agg((k) => k.totalTargetToDate) };
    case "achievement": {
      const ob = agg((k) => (k.orderBooking ?? 0) + (k.directDealersOrder ?? 0));
      const t = agg((k) => k.totalTargetToDate);
      return { value: t && t > 0 && ob != null ? round3(ob / t) : null, note: "recomputed (OB+DD)/target — never read from a sheet % cell" };
    }
    case "retailers": {
      const source = m.source ?? "dataTabDeclared";
      if (source === "dataTabDeclared") {
        return { value: agg((k) => k.totalRetailers), note: "Data-tab declared count (BH 'Grand Total Retailers')" };
      }
      // memberSheetRows: literal row count from the member's own workbook.
      if (entityType === "head") return { value: null, note: "memberSheetRows source is per-member; use member entities" };
      const dd = await loadDeepDiveData(currentFy, undefined, e.key, { skipExtras: true });
      const detail = dd.retailerDetail;
      const rows = detail && detail.status === "ok" ? detail.rows.length : null;
      return {
        value: rows,
        note: rows == null ? "member sheet unavailable" : "literal row count from the member's own sheet",
      };
    }
    case "visits":
      return { value: agg((k) => k.totalVisitsYtd), note: "Data-tab AF (visits YTD)" };
    case "workingDays":
      return { value: agg((k) => k.workingDaysActual) };
    case "visitsPerDay": {
      const v = agg((k) => k.totalVisitsYtd);
      const w = agg((k) => k.workingDaysActual);
      return { value: v != null && w && w > 0 ? round2(v / w) : null };
    }
    case "elapsedMonths":
      return { value: agg((k) => k.elapsedMonths) };
    case "paceRatio": {
      const ob = agg((k) => (k.orderBooking ?? 0) + (k.directDealersOrder ?? 0));
      const t = agg((k) => k.totalTargetToDate);
      return { value: t && t > 0 && ob != null ? round3(ob / t) : null, note: "achievement against target-to-date (already pace-adjusted: BM is to-date)" };
    }
    case "correlation": {
      if (entityType === "head") {
        const ks = (e.memberKpis ?? []).filter((k) => !k.isLeft);
        const pairs = ks
          .map((k) => [((k.orderBooking ?? 0) + (k.directDealersOrder ?? 0)), k.sale ?? 0] as [number, number])
          .filter(([a, b]) => a > 0 || b > 0);
        if (pairs.length < MIN_CORRELATION_SAMPLE) {
          return { value: `SUPPRESSED`, note: `correlation suppressed: sample n=${pairs.length} below minimum ${MIN_CORRELATION_SAMPLE} — that is not a distribution` };
        }
        return { value: round3(pearson(pairs)), note: `OB↔sale across ${pairs.length} members` };
      }
      const dd = await loadDeepDiveData(currentFy, undefined, e.key, { skipExtras: true });
      const detail = dd.retailerDetail;
      const rets = detail && detail.status === "ok" ? detail.rows : [];
      const pairs = rets
        .map((r) => [Number(r.orderBooking ?? 0), Number(r.sale ?? 0)] as [number, number])
        .filter(([a, b]) => a > 0 || b > 0);
      if (pairs.length < MIN_CORRELATION_SAMPLE) {
        return { value: `SUPPRESSED`, note: `correlation suppressed: sample n=${pairs.length} below minimum ${MIN_CORRELATION_SAMPLE} — that is not a distribution` };
      }
      return { value: round3(pearson(pairs)), note: `OB↔sale across ${pairs.length} retailers` };
    }
    // ── C2b: cost measures. cost = monthly CTC × elapsed complete months
    // (column BD, the member's OWN — never a team figure) + YTD travel. ──
    case "costPerVisit":
    case "costRatioOb":
    case "costRatioSales": {
      const ks = entityType === "member"
        ? (e.kpis ? [e.kpis] : [])
        : (e.memberKpis ?? []).filter((k) => !k.isLeft);
      return computeCostCell(def.id, ks);
    }

    // ── C2b: member-sheet measures (member entities only) ──
    case "activeRetailerShare":
    case "visitCoverage":
    case "unassignedShare":
    case "visitsToUnassigned":
    case "customersRetained":
    case "customersReactivated":
    case "customersAtRisk":
    case "customersNever":
    case "removedParties":
    case "businessPerActiveRetailer":
    case "effectiveRetailers":
    case "top5Share": {
      if (entityType === "head") {
        return { value: null, note: `'${def.id}' reads the member working sheet; it is member-only — compare member entities instead` };
      }
      const dd = await loadDeepDiveData(currentFy, undefined, e.key, { skipExtras: true });
      const detail = dd.retailerDetail;
      if (!detail || detail.status !== "ok") {
        return { value: null, note: "member sheet unavailable — the working sheet could not be read; this is missing data, not zero" };
      }
      const rows = detail.rows;
      const spread = detail.spread;
      switch (def.id) {
        case "activeRetailerShare":
          return rows.length > 0
            ? { value: round2((rows.filter((r) => r.isActive).length / rows.length) * 100), note: `${rows.filter((r) => r.isActive).length} active of ${rows.length} retailers — member working sheet` }
            : { value: null, note: "undefined — the working sheet has no retailer rows" };
        case "visitCoverage": {
          const required = rows.reduce((s, r) => s + (r.visitsRequired ?? 0), 0);
          const done = e.kpis?.totalVisitsYtd ?? null;
          if (required <= 0) return { value: null, note: "undefined — no visit requirement recorded on the working sheet (a ratio on zero required is not 100%)" };
          if (done == null) return { value: null, note: "not recorded — Data tab column AF (visits done) is blank" };
          return { value: round2((done / required) * 100), note: `visits done ${done} (Data tab column AF, all-type cumulative) ÷ required ${required} (working sheet)` };
        }
        case "unassignedShare": {
          const un = rows.filter((r) => !r.distributor || r.distributor.trim() === "" || r.distributor.trim() === "--");
          return rows.length > 0
            ? { value: round2((un.length / rows.length) * 100), note: `${un.length} of ${rows.length} retailers have no assigned distributor — member working sheet` }
            : { value: null, note: "undefined — no retailer rows" };
        }
        case "visitsToUnassigned": {
          const un = rows.filter((r) => !r.distributor || r.distributor.trim() === "" || r.distributor.trim() === "--");
          return { value: un.reduce((s, r) => s + (r.totalVisit ?? 0), 0), note: `visit total over ${un.length} retailers with no assigned distributor — member working sheet` };
        }
        case "customersRetained":
        case "customersReactivated":
        case "customersAtRisk":
        case "customersNever": {
          const active = rows.filter((r) => r.isActive);
          const dormant = rows.filter((r) => !r.isActive);
          const states: Record<string, RetailerRow[]> = {
            customersRetained: active.filter((r) => (r.businessPlan ?? 0) > 0),
            customersReactivated: active.filter((r) => !((r.businessPlan ?? 0) > 0)),
            customersAtRisk: dormant.filter((r) => (r.totalVisit ?? 0) > 0 && (r.businessPlan ?? 0) > 0),
            customersNever: dormant.filter((r) => !((r.totalVisit ?? 0) > 0 && (r.businessPlan ?? 0) > 0)),
          };
          return { value: states[def.id].length, note: `of ${rows.length} retailers on the working sheet (states use activity + plan + visits, same definitions as the AI reports)` };
        }
        case "removedParties": {
          const removed = detail.removedRows ?? [];
          const byYear = new Map<string, number>();
          for (const r of removed) {
            const y = r.lastActiveYear ?? "unknown";
            byYear.set(y, (byYear.get(y) ?? 0) + 1);
          }
          const breakdown = [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([y, n]) => `${y}: ${n}`).join(", ");
          return { value: removed.length, note: removed.length > 0
            ? `by LAST ACTIVE YEAR (the sheet holds no removal date) — ${breakdown}`
            : "no rows in the 'Removed Parties' section" };
        }
        case "businessPerActiveRetailer":
          return spread.businessPerActiveRetailer != null
            ? { value: round2(spread.businessPerActiveRetailer), note: "total OB ÷ active retailers — member working sheet" }
            : { value: null, note: "undefined — no active retailers with order booking" };
        case "effectiveRetailers":
          return spread.concentrationIndex != null && spread.concentrationIndex > 0
            ? { value: round2(10000 / spread.concentrationIndex), note: `10,000 ÷ HHI (${round2(spread.concentrationIndex)}) — an equivalent-count reading of concentration` }
            : { value: null, note: "undefined — no positive order booking to measure concentration on" };
        case "top5Share":
          return spread.top5ObShare != null
            ? { value: round2(spread.top5ObShare), note: "top-5 retailers' OB ÷ total OB — member working sheet" }
            : { value: null, note: "undefined — no order booking recorded" };
      }
      return { value: null, note: `measure '${def.id}' not computable` };
    }

    default:
      return { value: null, note: `measure '${def.id}' not computable` };
  }
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function pearson(pairs: [number, number][]): number {
  const n = pairs.length;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : 0;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
