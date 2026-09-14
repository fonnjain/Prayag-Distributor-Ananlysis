/**
 * Central HOLD enforcement for margin/cost consumers.
 *
 * Resolution items deliberately live outside this package's Drizzle schema:
 * the register is owned by the resolution feature.  Reading the row as
 * `record` keeps this resolver compatible with the register's additive
 * columns while making the enforcement rules (HOLD only, open only and
 * measure/product/month scoped) one shared implementation.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ResolutionItemType = "HOLD" | "PENDING";

export type ResolutionHold = {
  id: string | number;
  /** Stable register code (for example H1/H3), when present. */
  code?: string;
  type: ResolutionItemType;
  title: string;
  scope: string;
  reason: string;
  fiscalYear: string | null;
  month: string | null;
  scopeProduct: string | null;
  scopeMeasure: string | null;
  resolutionUrl: string;
};
export type ResolutionItemRow = Omit<ResolutionHold, "type"> & {
  type: ResolutionItemType;
};

export type HoldCoverage = {
  requestedPeriods: string[];
  availablePeriods: string[];
  heldPeriods: string[];
  /** Compatibility aliases used by existing in-process consumers. */
  requested: string[];
  available: string[];
  held: string[];
};

/** Explicit response object returned to API consumers. Never substitute 0. */
export type StructuredExclusion = {
  value: null;
  availability: "unavailable";
  coverage: HoldCoverage;
  type: "HOLD";
  resolutionItemId: string | number;
  /** Compatibility alias used by existing in-process consumers. */
  holdId: string | number;
  title: string;
  scope: {
    fiscalYear: string | null;
    months: string[];
    products: string[];
    measures: string[];
  };
  scopeLabel: string;
  reason: string;
  resolutionUrl: string;
  scopeProduct?: string | null;
  scopeMeasure?: string | null;
  fiscalYear?: string | null;
  heldPeriod?: string | null;
  /** Nested form is useful to clients that render a hold badge generically. */
  hold: {
    id: string | number;
    title: string;
    scope: string;
    reason: string;
    resolutionUrl: string;
  };
};

export type HoldResolutionInput = {
  measure: string;
  product?: string | null;
  requestedPeriods?: string[];
  availablePeriods?: string[];
  /** External item analytics opts into exact FY/month interpretation. */
  strictFiscalYear?: boolean;
  /** Supplying rows makes this pure and is useful for route/unit tests. */
  holds?: Array<ResolutionHold | ResolutionItemRow>;
};

const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3], ["apr", 4], ["april", 4],
  ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10], ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12],
]);

function text(value: unknown): string | null {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function normal(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function scopeValues(value: string | null): string[] {
  return value
    ? value.split(/[;,|]/).map((part) => part.trim()).filter(Boolean)
    : [];
}

function namedMatch(value: string, requested: string): boolean {
  const a = normal(value);
  const b = normal(requested);
  if (!a || !b) return false;
  if (a === b) return true;
  // Register scope labels may add a human qualifier ("PTMT master
  // category") while consumers use the canonical segment ("PTMT").
  if (new RegExp(`(?:^|\\s)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "i").test(a)) return true;
  if (new RegExp(`(?:^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "i").test(b)) return true;
  // Register rows commonly use a comma/semicolon separated measure list.
  return a.split(/[;,|]/).map((part) => part.trim()).includes(b) ||
    a.split(/[;,|]/).some((part) => part.trim() === "all" || part.trim() === "*");
}

function monthNumbers(period: string): Set<number> {
  const lower = period.toLowerCase();
  const foundWithPositions: Array<{ position: number; month: number }> = [];
  for (const [name, month] of MONTHS) {
    const position = lower.search(new RegExp(`\\b${name}\\b`, "i"));
    if (position >= 0) foundWithPositions.push({ position, month });
  }
  const found = foundWithPositions.sort((a, b) => a.position - b.position).map((entry) => entry.month);
  if (found.length <= 1) return new Set(found);
  const out = new Set<number>();
  for (let i = 0; i < found.length - 1; i++) {
    const from = found[i]!;
    const to = found[i + 1]!;
    // Month ranges may cross the calendar-year boundary (for example,
    // "Nov-Feb"). Walk forward through December rather than producing an
    // empty range when the end month is numerically smaller.
    if (from <= to) {
      for (let n = from; n <= to; n++) out.add(n);
    } else {
      for (let n = from; n <= 12; n++) out.add(n);
      for (let n = 1; n <= to; n++) out.add(n);
    }
  }
  // A list of non-range month names is still interpreted as its complete
  // span, retaining the previous behaviour for "Jan, Feb, Mar".
  if (out.size === 0) {
    for (let n = found[0]!; n <= found[found.length - 1]!; n++) out.add(n);
  }
  return out;
}

function years(period: string): Set<number> {
  const fiscal = period.match(/\b(20\d{2})-(\d{2})\b/);
  if (fiscal) return new Set([Number(fiscal[1]), 2000 + Number(fiscal[2])]);
  const full = [...period.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (full.length > 0) return new Set(full);
  // margin_fact labels use Mon-YY (for example Jan-26).
  return new Set(
    [...period.matchAll(/(?:^|[-\s])(\d{2})(?:$|\b)/g)]
      .map((m) => 2000 + Number(m[1])),
  );
}

function fiscalYearForMonthLabel(period: string): string | null {
  const match = period.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*[-\s](20\d{2}|\d{2})\b/i);
  if (!match) return null;
  const month = MONTHS.get(match[1]!.toLowerCase());
  if (!month) return null;
  const year = Number(match[2]!.length === 2 ? `20${match[2]}` : match[2]);
  const start = month <= 3 ? year - 1 : year;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function periodMatches(hold: ResolutionHold, requested: string, strictFiscalYear = false): boolean {
  const holdMonth = hold.month;
  const holdFy = hold.fiscalYear;
  if (!holdMonth && !holdFy) return true;
  const requestedYears = years(requested);
  if (holdFy && requested.includes(holdFy)) return true;
  const requestedFy = strictFiscalYear ? fiscalYearForMonthLabel(requested) : null;
  if (holdFy && requestedFy && requestedFy !== holdFy) return false;
  if (!holdMonth) return !holdFy || requestedYears.size === 0;
  const heldMonths = monthNumbers(holdMonth);
  const requestedMonths = monthNumbers(requested);
  // Comparison month labels (for example Jan-25) carry the calendar year,
  // while attribution holds are seeded with their fiscal year (FY2024-25).
  // Reconcile those representations for FY-scoped attribution holds before
  // testing a concrete month range.
  if (heldMonths.size === 0 && holdFy && fiscalYearForMonthLabel(requested) === holdFy) return true;
  // A fiscal-year-only request cannot safely claim a held month is absent.
  if (requestedMonths.size === 0) return !!holdFy && requestedYears.size > 0 && requested.includes(holdFy);
  if (heldMonths.size === 0) return normal(holdMonth) === normal(requested);
  if (![...heldMonths].some((m) => requestedMonths.has(m))) return false;
  const heldYears = years(holdMonth);
  return heldYears.size === 0 || requestedYears.size === 0 || [...heldYears].some((y) => requestedYears.has(y));
}

function toHold(row: Record<string, unknown>): ResolutionHold | null {
  const id = row.id;
  if (id == null) return null;
  const type = String(row.type ?? "").toUpperCase();
  if (type !== "HOLD" || String(row.status ?? "").toLowerCase() !== "open") return null;
  if (row.blocks_api === false || row.blocksApi === false) return null;
  const month = text(row.month ?? row.month_range ?? row.monthRange);
  const fiscalYear = text(row.fiscal_year ?? row.fiscalYear);
  const scopeProduct = text(row.scope_product ?? row.scopeProduct);
  const scopeMeasure = text(row.scope_measure ?? row.scopeMeasure);
  const scope = [scopeProduct, scopeMeasure, fiscalYear, month].filter(Boolean).join(" · ") || "specified register scope";
  return {
    id: typeof id === "number" ? id : String(id),
    code: text(row.code) ?? undefined,
    type: "HOLD",
    title: text(row.title) ?? "Open resolution hold",
    scope,
    reason: text(row.reason) ?? "This figure is held pending resolution.",
    fiscalYear,
    month,
    scopeProduct,
    scopeMeasure,
    resolutionUrl: `/settings/resolution/${encodeURIComponent(String(id))}`,
  };
}

/** Read currently open API-blocking HOLD rows. PENDING rows never appear. */
export async function getOpenResolutionHolds(): Promise<ResolutionHold[]> {
  const result = await db.execute(sql`SELECT * FROM resolution_item`);
  return (result.rows as unknown as Record<string, unknown>[])
    .map(toHold)
    .filter((row): row is ResolutionHold => row != null);
}

export function resolveHoldExclusionsFromRows(
  input: HoldResolutionInput,
  rows: Array<ResolutionHold | ResolutionItemRow>,
): StructuredExclusion[] {
  const requested = [...new Set((input.requestedPeriods ?? []).filter(Boolean))];
  const baselineAvailable = input.availablePeriods
    ? [...new Set(input.availablePeriods.filter(Boolean))]
    : requested;
  const applicable = rows.filter((hold) => {
    if (hold.type !== "HOLD") return false;
    if (hold.scopeMeasure && !namedMatch(hold.scopeMeasure, input.measure)) return false;
    if (hold.scopeProduct && input.product && !namedMatch(hold.scopeProduct, input.product)) return false;
    if (hold.scopeProduct && !input.product) return false;
    // For an unbounded request, a period-scoped hold still applies to the
    // aggregate. For a bounded request only overlapping named months apply.
    return requested.length === 0 || requested.some((period) => periodMatches(hold, period, input.strictFiscalYear));
  });
  return applicable.map((hold) => {
    const held = requested.length === 0
      ? (hold.month ? [hold.month] : [])
      : requested.filter((period) => periodMatches(hold, period, input.strictFiscalYear));
    const available = baselineAvailable.filter((period) => !held.includes(period));
    const coverage = {
      requestedPeriods: requested,
      availablePeriods: available,
      heldPeriods: held,
      requested,
      available,
      held,
    };
    return {
      value: null,
      availability: "unavailable",
      coverage,
      type: "HOLD",
      resolutionItemId: hold.id,
      holdId: hold.id,
      title: hold.title,
      scope: {
        fiscalYear: hold.fiscalYear,
        months: held,
        products: scopeValues(hold.scopeProduct),
        measures: scopeValues(hold.scopeMeasure),
      },
      scopeLabel: hold.scope,
      reason: hold.reason,
      resolutionUrl: hold.resolutionUrl,
      scopeProduct: hold.scopeProduct,
      scopeMeasure: hold.scopeMeasure,
      fiscalYear: hold.fiscalYear,
      heldPeriod: hold.month,
      hold: {
        id: hold.id,
        title: hold.title,
        scope: hold.scope,
        reason: hold.reason,
        resolutionUrl: hold.resolutionUrl,
      },
    };
  });
}

/** Resolve exclusions against the live register. */
export async function resolveHoldExclusions(input: HoldResolutionInput): Promise<StructuredExclusion[]> {
  const rows = input.holds ?? await getOpenResolutionHolds();
  return resolveHoldExclusionsFromRows(input, rows);
}

/** Convenience for consumers that need one unavailable marker. */
export async function resolveHoldExclusion(input: HoldResolutionInput): Promise<StructuredExclusion | null> {
  return (await resolveHoldExclusions(input))[0] ?? null;
}
