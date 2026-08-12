// Derivation + aggregation for one uploaded SAP month.
//
// Each SAP line is enriched using the rate-list maps:
//   item code  -> product GROUP (via the item master + group_map)
//   customer   -> STATE HEAD / STATE / channel (via the customer master)
// then classified territory vs institutional using the same head lists the
// invoice-line register uses. A line that cannot be matched still counts toward
// the grand total but lands in an "Unmapped" bucket, so every cross-foot
// dimension (group / head / state) always sums back to the grand total.
import { titleCase } from "./util.js";
import { buildHeadResolver, normName } from "../mgmt/names.js";
import { NON_TERRITORY_BUCKET } from "../registers/normalize.js";
import headAlias from "../../../config/head_alias.json";
import normalizeConfig from "../../../config/normalize.json";
import {
  matchCustomer,
  normCode,
  type RateListMaps,
} from "./rateList.js";
import { dateToMonthLabel, type SapRow } from "./sapStream.js";

export const UNMAPPED_GROUP = "Unmapped";
export const UNMAPPED_HEAD = "Unmapped (review)";
export const UNMAPPED_STATE = "Unmapped (review)";

// Fixed channel vocabulary.  A customer with no rate-list match gets NULL —
// never a default of 'Retail'.  Raw values that do not match any canonical
// token are stored as 'Unmapped' (not dropped) so they remain queryable.
export const CHANNEL_VOCAB = new Set([
  "Retail", "Govt", "Project", "JJM", "Gem", "Export",
]);

export function normalizeChannel(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // Case-insensitive match against the canonical set.
  for (const canonical of CHANNEL_VOCAB) {
    if (canonical.toLowerCase() === trimmed.toLowerCase()) return canonical;
  }
  return "Unmapped";
}

const territoryHeadKeys = normalizeConfig.territory_heads as string[];
const territoryDisplays = territoryHeadKeys.map(
  (k) => (headAlias as Record<string, string>)[k] ?? titleCase(k),
);
const resolveTerritoryHead = buildHeadResolver(territoryDisplays);
const institutionalKeys = (normalizeConfig.institutional as string[]).map((t) =>
  normName(t),
);

export type HeadClass = {
  head: string;
  isTerritory: boolean;
  mapped: boolean;
};

// Classifies a customer-master STATE HEAD value into a canonical territory head
// or the single institutional bucket. Unknown heads are surfaced (mapped:false)
// but still bucketed under their own display so no revenue is lost.
export function classifyHead(raw: string | null): HeadClass {
  if (!raw || raw.trim() === "") {
    return { head: UNMAPPED_HEAD, isTerritory: false, mapped: false };
  }
  const territory = resolveTerritoryHead(raw);
  if (territory) return { head: territory, isTerritory: true, mapped: true };
  const key = normName(raw);
  if (institutionalKeys.some((tok) => key.includes(tok) || tok.includes(key))) {
    return { head: NON_TERRITORY_BUCKET, isTerritory: false, mapped: true };
  }
  return { head: titleCase(raw), isTerritory: false, mapped: false };
}

export type ByAmount = { key: string; amount: number };
export type CodeAgg = { code: string; qty: number; revenue: number; group: string };

export type MonthSummary = {
  fy: string;
  monthLabel: string;
  rowsRead: number;
  amount: number;
  territoryAmount: number;
  institutionalAmount: number;
  maxInvoiceDate: string | null;
  invoiceCount: number;
  customerCount: number;
  byHead: Array<{ head: string; amount: number; isTerritory: boolean }>;
  byState: ByAmount[];
  byGroup: ByAmount[];
  byCustomer: Array<[string, number]>;
  byCode: CodeAgg[];
  matchedRows: number;
  matchedRevenue: number;
  unmatchedCustomers: Array<{ name: string; amount: number }>;
  unmappedGroups: ByAmount[];
};

function bump(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

// A single-pass accumulator for SAP rows. Rows are folded in one at a time (via
// addRow) so the caller can stream the workbook straight from object storage
// without ever holding the whole file in memory; finish() materializes the
// summary. deriveMonthSummary() below is a thin wrapper used by tests.
// Audit of how the streamed rows map onto the requested month. The month label
// is authoritative from each row's invoice date (SAP col C), NOT the month the
// user selected — a row dated outside the requested month is excluded from the
// aggregation and reported here so the route can reject a mislabeled or
// mixed-month upload instead of silently misclassifying revenue.
export type MonthAudit = {
  expectedMonth: string;
  scannedRows: number;
  inMonthRows: number;
  undatedRows: number;
  offMonthRows: number;
  offMonthAmount: number;
  monthsDetected: Array<{ month: string; rows: number; amount: number }>;
};

export type MonthAccumulator = {
  addRow: (row: SapRow) => void;
  finish: () => MonthSummary;
  audit: () => MonthAudit;
};

export function createMonthAccumulator(
  maps: RateListMaps,
  fy: string,
  monthLabel: string,
): MonthAccumulator {
  let amount = 0;
  let territoryAmount = 0;
  let matchedRows = 0;
  let matchedRevenue = 0;
  let maxDateMs: number | null = null;
  let rowsRead = 0;
  let scannedRows = 0;
  let undatedRows = 0;
  let offMonthRows = 0;
  let offMonthAmount = 0;
  const monthsDetected = new Map<string, { rows: number; amount: number }>();

  const byHead = new Map<string, { amount: number; isTerritory: boolean }>();
  const byState = new Map<string, number>();
  const byGroup = new Map<string, number>();
  const byCustomer = new Map<string, number>();
  const byCode = new Map<string, CodeAgg>();
  const invoices = new Set<string>();
  const customers = new Set<string>();
  const unmatched = new Map<string, number>();
  const unmappedGroups = new Map<string, number>();

  function addRow(row: SapRow): void {
    scannedRows++;
    const rev = row.taxable;

    // Month is authoritative from the invoice date. A dated row outside the
    // requested month is excluded and recorded for the route to reject on;
    // an undated row falls back to the requested month (historical exports and
    // manual files sometimes omit a date).
    if (row.date) {
      const label = dateToMonthLabel(row.date);
      const seen = monthsDetected.get(label) ?? { rows: 0, amount: 0 };
      seen.rows++;
      seen.amount += rev;
      monthsDetected.set(label, seen);
      if (label !== monthLabel) {
        offMonthRows++;
        offMonthAmount += rev;
        return;
      }
      const ms = row.date.getTime();
      if (maxDateMs == null || ms > maxDateMs) maxDateMs = ms;
    } else {
      undatedRows++;
    }

    rowsRead++;
    amount += rev;
    if (row.invoiceNo) invoices.add(row.invoiceNo);

    // Item -> group
    const item = maps.items.get(normCode(row.code ?? ""));
    const group = item?.group ?? UNMAPPED_GROUP;
    if (group === UNMAPPED_GROUP) {
      bump(unmappedGroups, item?.itemType ?? row.code ?? "unknown", rev);
    }
    bump(byGroup, group, rev);

    const codeKey = normCode(row.code ?? "");
    const codeAgg = byCode.get(codeKey);
    if (codeAgg) {
      codeAgg.qty += row.qty ?? 0;
      codeAgg.revenue += rev;
    } else {
      byCode.set(codeKey, {
        code: codeKey,
        qty: row.qty ?? 0,
        revenue: rev,
        group,
      });
    }

    // Customer -> head / state / channel
    const info = matchCustomer(row.customer, maps);
    if (info) {
      matchedRows++;
      matchedRevenue += rev;
    } else if (row.customer) {
      bump(unmatched, row.customer, rev);
    }
    if (row.customer) {
      bump(byCustomer, row.customer, rev);
      customers.add(row.customer);
    }

    const cls = classifyHead(info?.head ?? null);
    const headBucket = byHead.get(cls.head) ?? { amount: 0, isTerritory: cls.isTerritory };
    headBucket.amount += rev;
    headBucket.isTerritory = cls.isTerritory;
    byHead.set(cls.head, headBucket);
    if (cls.isTerritory) territoryAmount += rev;

    const state = info?.state ? info.state.toUpperCase() : UNMAPPED_STATE;
    bump(byState, state, rev);
  }

  function finish(): MonthSummary {
    const round = (n: number) => Math.round(n);
    return {
      fy,
      monthLabel,
      rowsRead,
      amount: round(amount),
      territoryAmount: round(territoryAmount),
      institutionalAmount: round(amount - territoryAmount),
      maxInvoiceDate:
        maxDateMs == null ? null : new Date(maxDateMs).toISOString().slice(0, 10),
      invoiceCount: invoices.size,
      customerCount: customers.size,
      byHead: [...byHead.entries()]
        .map(([head, v]) => ({ head, amount: round(v.amount), isTerritory: v.isTerritory }))
        .sort((a, b) => b.amount - a.amount),
      byState: [...byState.entries()]
        .map(([key, v]) => ({ key, amount: round(v) }))
        .sort((a, b) => b.amount - a.amount),
      byGroup: [...byGroup.entries()]
        .map(([key, v]) => ({ key, amount: round(v) }))
        .sort((a, b) => b.amount - a.amount),
      byCustomer: [...byCustomer.entries()].map(([k, v]) => [k, round(v)] as [string, number]),
      byCode: [...byCode.values()].map((c) => ({
        code: c.code,
        qty: c.qty,
        revenue: round(c.revenue),
        group: c.group,
      })),
      matchedRows,
      matchedRevenue: round(matchedRevenue),
      unmatchedCustomers: [...unmatched.entries()]
        .map(([name, v]) => ({ name, amount: round(v) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 200),
      unmappedGroups: [...unmappedGroups.entries()]
        .map(([key, v]) => ({ key, amount: round(v) }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  function audit(): MonthAudit {
    return {
      expectedMonth: monthLabel,
      scannedRows,
      inMonthRows: rowsRead,
      undatedRows,
      offMonthRows,
      offMonthAmount: Math.round(offMonthAmount),
      monthsDetected: [...monthsDetected.entries()]
        .map(([month, v]) => ({ month, rows: v.rows, amount: Math.round(v.amount) }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  return { addRow, finish, audit };
}

export function deriveMonthSummary(
  rows: SapRow[],
  maps: RateListMaps,
  fy: string,
  monthLabel: string,
): MonthSummary {
  const acc = createMonthAccumulator(maps, fy, monthLabel);
  for (const row of rows) acc.addRow(row);
  return acc.finish();
}
