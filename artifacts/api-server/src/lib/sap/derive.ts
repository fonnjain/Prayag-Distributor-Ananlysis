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
import type { SapRow } from "./sapStream.js";

export const UNMAPPED_GROUP = "Unmapped";
export const UNMAPPED_HEAD = "Unmapped (review)";
export const UNMAPPED_STATE = "Unmapped (review)";

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
export type MonthAccumulator = {
  addRow: (row: SapRow) => void;
  finish: () => MonthSummary;
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
    rowsRead++;
    const rev = row.taxable;
    amount += rev;

    if (row.date) {
      const ms = row.date.getTime();
      if (maxDateMs == null || ms > maxDateMs) maxDateMs = ms;
    }
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

  return { addRow, finish };
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
