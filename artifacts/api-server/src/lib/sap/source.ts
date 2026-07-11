// SAP-derived analytics aggregate, assembled purely from the cached per-month
// summaries (no re-streaming). analytics.ts adapts this into the same
// MonthStat / HeadStat / Margins shapes it produces from sale_line, so the
// FY2026-27 cutover is a source swap with identical output contracts.
import { getUploadSummaries } from "./store.js";
import type { MonthSummary } from "./derive.js";

export type SapAggregate = {
  months: Array<{
    monthLabel: string;
    monthName: string;
    amount: number;
    territoryAmount: number;
    institutionalAmount: number;
    maxInvoiceDate: string | null;
  }>;
  byHead: Array<{ head: string; amount: number; isTerritory: boolean }>;
  customerByMonth: Map<string, Map<string, number>>;
  invoiceCountByMonth: Map<string, number>;
  byCode: Array<{ code: string; qty: number; revenue: number; group: string }>;
};

function combineHeads(
  summaries: MonthSummary[],
): Array<{ head: string; amount: number; isTerritory: boolean }> {
  const map = new Map<string, { amount: number; isTerritory: boolean }>();
  for (const s of summaries) {
    for (const h of s.byHead) {
      const cur = map.get(h.head) ?? { amount: 0, isTerritory: h.isTerritory };
      cur.amount += h.amount;
      cur.isTerritory = h.isTerritory;
      map.set(h.head, cur);
    }
  }
  return [...map.entries()]
    .map(([head, v]) => ({ head, amount: v.amount, isTerritory: v.isTerritory }))
    .sort((a, b) => b.amount - a.amount);
}

function combineCodes(
  summaries: MonthSummary[],
): Array<{ code: string; qty: number; revenue: number; group: string }> {
  const map = new Map<string, { qty: number; revenue: number; group: string }>();
  for (const s of summaries) {
    for (const c of s.byCode) {
      const cur = map.get(c.code) ?? { qty: 0, revenue: 0, group: c.group };
      cur.qty += c.qty;
      cur.revenue += c.revenue;
      cur.group = c.group;
      map.set(c.code, cur);
    }
  }
  return [...map.entries()].map(([code, v]) => ({ code, ...v }));
}

export function aggregateFromSummaries(summaries: MonthSummary[]): SapAggregate {
  const customerByMonth = new Map<string, Map<string, number>>();
  const invoiceCountByMonth = new Map<string, number>();
  for (const s of summaries) {
    const cust = new Map<string, number>();
    for (const [name, amount] of s.byCustomer) {
      cust.set(name, (cust.get(name) ?? 0) + amount);
    }
    customerByMonth.set(s.monthLabel, cust);
    invoiceCountByMonth.set(s.monthLabel, s.invoiceCount);
  }
  return {
    months: summaries.map((s) => ({
      monthLabel: s.monthLabel,
      monthName: s.monthLabel.slice(0, 3),
      amount: s.amount,
      territoryAmount: s.territoryAmount,
      institutionalAmount: s.institutionalAmount,
      maxInvoiceDate: s.maxInvoiceDate,
    })),
    byHead: combineHeads(summaries),
    customerByMonth,
    invoiceCountByMonth,
    byCode: combineCodes(summaries),
  };
}

export async function getSapAggregate(fy: string): Promise<SapAggregate> {
  const summaries = await getUploadSummaries(fy);
  return aggregateFromSummaries(summaries);
}
