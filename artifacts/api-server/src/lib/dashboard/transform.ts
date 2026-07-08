// Transforms raw Google Sheet workbooks into the aggregate dashboard shape.
//
// Four live sources:
//  1. Item-wise product sales workbook, tab "SALE " -> fy2425 (FY2024-25).
//  2. Order book workbook, monthly tabs (Apr/May/Jun/...) -> orders_fy2627 and
//     the regional / state-head / top-retailer rollups.
//  3. "Retailer-Distributor Data" workbook -> retailer roster (coverage by
//     state) and distributor roster (distributor counts).
//  4. "STATE HEAD DASHBOARD(2026-27)" workbook -> per-head dealer network,
//     states covered, and secondary order value (heads_resources, totals).
//
// The order book's "Combined" tab is formula-driven and does not cache its rows
// in the Drive XLSX export, so we read the per-month tabs directly.
import type { Workbook, Worksheet } from "exceljs";
import { cellNumber, cellString } from "../sheets.js";

export const MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

// Product code -> product group. Only these codes are treated as products; any
// other row in the SALE tab (section subtotals, grand totals) is ignored.
const PRODUCT_GROUP: Record<string, string> = {
  PTMT: "PTMT / Faucets",
  CP: "CP (Chrome-Plated)",
  "CPVC PIPE": "Plumbing (Pipes & Fittings)",
  CPVC: "Plumbing (Pipes & Fittings)",
  SWR: "Plumbing (Pipes & Fittings)",
  "HDPE PIPE": "Plumbing (Pipes & Fittings)",
  "WATER TANK": "Plumbing (Pipes & Fittings)",
  "CP ACCESSORIES": "CP (Chrome-Plated)",
  SINK: "Sink",
  SANITARYWARE: "Sanitaryware",
  "UPVC PIPE": "Plumbing (Pipes & Fittings)",
  CISTERN: "PTMT / Faucets",
  UPVC: "Plumbing (Pipes & Fittings)",
  CONNECTION: "Connection / Waste",
  AGRI: "Plumbing (Pipes & Fittings)",
  "GARDEEN PIPE": "Plumbing (Pipes & Fittings)",
  "WASTE-PIPE": "Connection / Waste",
  "SEAT COVER": "PTMT / Faucets",
  HARDWARE: "Hardware",
  "P-RACK": "Sink",
  CABINET: "PTMT / Faucets",
  "TEFLON TAPE": "CP (Chrome-Plated)",
  JALI: "Sink",
  GEYSER: "CP (Chrome-Plated)",
  QUAA: "PTMT / Faucets",
  GLASS: "CP (Chrome-Plated)",
};

const GROUP_ORDER = [
  "Plumbing (Pipes & Fittings)",
  "PTMT / Faucets",
  "CP (Chrome-Plated)",
  "Sink",
  "Sanitaryware",
  "Connection / Waste",
  "Hardware",
];

function monthIndex(label: string): number {
  const m = String(label).slice(0, 3).toLowerCase();
  return (MONTHS as readonly string[]).findIndex((x) => x.toLowerCase() === m);
}

function dominant(counts: Map<string, number>): string {
  let best = "";
  let bestVal = -1;
  for (const [k, v] of counts) {
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return best;
}

export interface Fy2425Product {
  group: string;
  product: string;
  monthly: number[];
  annual: number;
}
export interface Fy2425Group {
  group: string;
  annual: number;
  monthly: number[];
}
export interface Fy2425 {
  months: string[];
  grand_total: number;
  grand_monthly: number[];
  products: Fy2425Product[];
  groups: Fy2425Group[];
}

// SALE tab layout: col B (2) = product code, cols C..N (3..14) = Apr..Mar.
export function buildFy2425(workbook: Workbook): Fy2425 {
  const sheet =
    workbook.getWorksheet("SALE ") ??
    workbook.worksheets.find((w) => w.name.trim() === "SALE");
  if (!sheet) throw new Error('Item-wise sales workbook has no "SALE" tab');

  const products: Fy2425Product[] = [];
  sheet.eachRow((row, r) => {
    if (r < 3) return;
    const code = cellString(row.getCell(2)).toUpperCase();
    if (!code || code === "TOTAL") return;
    const group = PRODUCT_GROUP[code];
    if (!group) return; // skip subtotal / non-product rows
    const monthly: number[] = [];
    let hasValue = false;
    for (let c = 3; c <= 14; c++) {
      const n = cellNumber(row.getCell(c));
      monthly.push(Math.round(n));
      if (n) hasValue = true;
    }
    if (!hasValue) return;
    products.push({
      group,
      product: code,
      monthly,
      annual: monthly.reduce((a, b) => a + b, 0),
    });
  });

  const grandMonthly = Array(12).fill(0);
  for (const p of products) p.monthly.forEach((v, i) => (grandMonthly[i] += v));

  const groupMap = new Map<string, Fy2425Group>();
  for (const p of products) {
    let g = groupMap.get(p.group);
    if (!g) {
      g = { group: p.group, annual: 0, monthly: Array(12).fill(0) };
      groupMap.set(p.group, g);
    }
    g.annual += p.annual;
    p.monthly.forEach((v, i) => (g!.monthly[i] += v));
  }
  const groups = [...groupMap.values()].sort(
    (a, b) =>
      (GROUP_ORDER.indexOf(a.group) + 1 || 99) -
      (GROUP_ORDER.indexOf(b.group) + 1 || 99),
  );

  return {
    months: [...MONTHS],
    grand_total: grandMonthly.reduce((a, b) => a + b, 0),
    grand_monthly: grandMonthly,
    products,
    groups,
  };
}

export interface OrdersMonthly {
  month: string;
  lines: number;
  docs: number;
  customers: number;
  qty: number;
  value_cr: number;
}
export interface OrdersGroup {
  group: string;
  qty: number;
  value_cr: number;
  share: number;
}
export interface ByState {
  state: string;
  head: string;
  retailers: number;
  sales: number;
}
export interface HeadRetail {
  head: string;
  retailers: number;
  sales: number;
  share: number;
}
export interface TopRetailer {
  company: string;
  state: string;
  city: string;
  sales: number;
}
export interface OrdersResult {
  orders_fy2627: { monthly: OrdersMonthly[]; groups: OrdersGroup[] };
  by_state: ByState[];
  heads_retail: HeadRetail[];
  top_retailers: TopRetailer[];
  orders_ytd_cr: number;
  order_customers: number;
}

function isMonthlyTab(ws: Worksheet): boolean {
  const n = ws.name.trim();
  if (/last month|combined|index|report|^wt$/i.test(n)) return false;
  return (MONTHS as readonly string[]).some((m) =>
    n.toLowerCase().startsWith(m.toLowerCase()),
  );
}

// Monthly tab layout: col C(3)=Document No, E(5)=Customer, J(10)=Quantity,
// L(12)=Taxable Value, M(13)=Month, N(14)=GROUP, O(15)=Station, P(16)=State,
// Q(17)=State Head.
export function buildFromOrders(workbook: Workbook): OrdersResult {
  const tabs = workbook.worksheets.filter(isMonthlyTab);

  const monthAgg = new Map<
    string,
    {
      month: string;
      lines: number;
      docs: Set<string>;
      customers: Set<string>;
      qty: number;
      value: number;
    }
  >();
  const groupAgg = new Map<string, { group: string; qty: number; value: number }>();
  const stateAgg = new Map<
    string,
    { state: string; sales: number; customers: Set<string>; heads: Map<string, number> }
  >();
  const headAgg = new Map<
    string,
    { head: string; sales: number; customers: Set<string> }
  >();
  const custAgg = new Map<
    string,
    { company: string; sales: number; states: Map<string, number>; cities: Map<string, number> }
  >();
  let totalValue = 0;

  for (const ws of tabs) {
    ws.eachRow((row, r) => {
      if (r < 2) return;
      const month = cellString(row.getCell(13));
      if (!month || monthIndex(month) < 0) return;
      const customer = cellString(row.getCell(5));
      if (!customer) return;
      const doc = cellString(row.getCell(3));
      const group = cellString(row.getCell(14)) || "Other";
      const qty = cellNumber(row.getCell(10));
      const value = cellNumber(row.getCell(12));
      const station = cellString(row.getCell(15));
      const state = cellString(row.getCell(16));
      const head = cellString(row.getCell(17));

      let m = monthAgg.get(month);
      if (!m) {
        m = { month, lines: 0, docs: new Set(), customers: new Set(), qty: 0, value: 0 };
        monthAgg.set(month, m);
      }
      m.lines++;
      if (doc) m.docs.add(doc);
      m.customers.add(customer);
      m.qty += qty;
      m.value += value;

      let g = groupAgg.get(group);
      if (!g) {
        g = { group, qty: 0, value: 0 };
        groupAgg.set(group, g);
      }
      g.qty += qty;
      g.value += value;
      totalValue += value;

      let s = stateAgg.get(state);
      if (!s) {
        s = { state, sales: 0, customers: new Set(), heads: new Map() };
        stateAgg.set(state, s);
      }
      s.sales += value;
      s.customers.add(customer);
      if (head) s.heads.set(head, (s.heads.get(head) ?? 0) + value);

      let h = headAgg.get(head);
      if (!h) {
        h = { head, sales: 0, customers: new Set() };
        headAgg.set(head, h);
      }
      h.sales += value;
      h.customers.add(customer);

      let c = custAgg.get(customer);
      if (!c) {
        c = { company: customer, sales: 0, states: new Map(), cities: new Map() };
        custAgg.set(customer, c);
      }
      c.sales += value;
      if (state) c.states.set(state, (c.states.get(state) ?? 0) + value);
      if (station) c.cities.set(station, (c.cities.get(station) ?? 0) + value);
    });
  }

  const monthly = [...monthAgg.values()]
    .map((m) => ({
      month: m.month,
      lines: m.lines,
      docs: m.docs.size,
      customers: m.customers.size,
      qty: Math.round(m.qty),
      value_cr: Number((m.value / 1e7).toFixed(2)),
    }))
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month));

  const groups = [...groupAgg.values()]
    .map((g) => ({
      group: g.group,
      qty: Math.round(g.qty),
      value_cr: Number((g.value / 1e7).toFixed(2)),
      share: totalValue ? Number(((g.value / totalValue) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.value_cr - a.value_cr);

  const by_state = [...stateAgg.values()]
    .filter((s) => s.state)
    .map((s) => ({
      state: s.state,
      head: dominant(s.heads),
      retailers: s.customers.size,
      sales: Math.round(s.sales),
    }))
    .sort((a, b) => b.sales - a.sales);

  const heads_retail = [...headAgg.values()]
    .filter((h) => h.head)
    .map((h) => ({
      head: h.head,
      retailers: h.customers.size,
      sales: Math.round(h.sales),
      share: totalValue ? Number(((h.sales / totalValue) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.sales - a.sales);

  const top_retailers = [...custAgg.values()]
    .map((c) => ({
      company: c.company,
      state: dominant(c.states),
      city: dominant(c.cities),
      sales: Math.round(c.sales),
    }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 40);

  return {
    orders_fy2627: { monthly, groups },
    by_state,
    heads_retail,
    top_retailers,
    orders_ytd_cr: Number(monthly.reduce((a, b) => a + b.value_cr, 0).toFixed(2)),
    order_customers: custAgg.size,
  };
}

// ---------------------------------------------------------------------------
// Channel resources: heads_resources, coverage, coverage_totals, channel totals.
//
// Sources:
//  - "Retailer-Distributor Data" workbook:
//      "Retailer" tab    -> registered retailer roster (RET# rows) with
//                           State(10)/District(11)/City(12) -> coverage.
//      "Distributor" tab -> distributor roster (DIST# rows) with
//                           Billing State(8) -> distributor counts per head.
//  - "STATE HEAD DASHBOARD(2026-27)" workbook:
//      "Data" tab -> one row per team member: State Head(1), State(2),
//                    Total Retailers(14). Gives the live state -> head mapping
//                    and the states covered per head.
//      "SECONDARY ORDER BOOKING REPORT " tab -> one row per secondary team
//                    member: State Head(2), Member(3), Total Dealer 26-27(11),
//                    Order Booked 26-27(13). Gives dealer network per head and
//                    the secondary (retail network) order value.

// The same state head appears under different spellings across the order book
// and the state-head dashboard tabs. Canonicalize to the order-book labels so
// heads line up across dashboard sections.
const HEAD_ALIAS: Record<string, string> = {
  "SANDEEP DADHEECH": "DADHEECH JI",
  "SYED AQIL RIZVI": "RIZVI JI",
  "AQIL RIZVI": "RIZVI JI",
  "BIJU C.O": "BIJJU",
  "BIJU CO": "BIJJU",
  "LALAN KUMAR": "LALAN",
  "PAWAN SHARMA": "PAWAN KUMAR",
  "PAWAN KUMAR SHARMA": "PAWAN KUMAR",
  "SULINDAR PAL": "SULINDER PAL",
  "NASIR HUSSAIN KHAN": "NASIR HUSAIN",
};

function canonicalHead(raw: string): string {
  const key = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!key || key === "LEFT TEAM MEMBERS") return "";
  return HEAD_ALIAS[key] ?? key;
}

// Distributor roster billing-state names that differ from the state-head
// dashboard's state names (uppercased on both sides).
const STATE_ALIAS: Record<string, string> = {
  ASSAM: "NORTH EAST",
  PONDICHERRY: "TAMIL NADU",
  "JAMMU AND KASHMIR": "JAMMU AND KASHMIR",
};

function canonicalState(raw: string): string {
  const key = raw
    .trim()
    .toUpperCase()
    .replace(/\s+\d+$/, "") // "Maharashtra 2" -> "MAHARASHTRA"
    .replace(/\s+/g, " ");
  return STATE_ALIAS[key] ?? key;
}

export interface HeadResource {
  head: string;
  distributors: number;
  dealers: number;
  total: number;
  states: string;
}
export interface CoverageRow {
  state: string;
  districts: number;
  cities: number;
  retailers: number;
}
export interface CoverageTotals {
  states: number;
  districts: number;
  cities: number;
  retailers: number;
}
export interface ResourcesResult {
  heads_resources: HeadResource[];
  coverage: CoverageRow[];
  coverage_totals: CoverageTotals;
  state_heads: number;
  distributors: number;
  dealers: number;
  channel_partners: number;
  retailers: number;
  retailer_sales_inr: number;
}

export function buildResources(
  rosterWb: Workbook,
  headDashWb: Workbook,
): ResourcesResult {
  const retailerSheet = rosterWb.getWorksheet("Retailer");
  const distributorSheet = rosterWb.getWorksheet("Distributor");
  if (!retailerSheet || !distributorSheet) {
    throw new Error(
      'Retailer-Distributor workbook is missing the "Retailer" or "Distributor" tab',
    );
  }
  const dataSheet = headDashWb.getWorksheet("Data");
  const secondarySheet = headDashWb.worksheets.find(
    (w) => w.name.trim().toUpperCase() === "SECONDARY ORDER BOOKING REPORT",
  );
  if (!dataSheet || !secondarySheet) {
    throw new Error(
      'State-head dashboard workbook is missing the "Data" or "SECONDARY ORDER BOOKING REPORT" tab',
    );
  }

  // --- State-head dashboard "Data" tab: state -> head, states per head.
  // Header rows occupy 1-3; member rows start at 4.
  const stateHeadVotes = new Map<string, Map<string, number>>();
  const headStates = new Map<string, Set<string>>();
  dataSheet.eachRow((row, r) => {
    if (r < 4) return;
    const head = canonicalHead(cellString(row.getCell(1)));
    if (!head) return;
    const state = cellString(row.getCell(2));
    if (!headStates.has(head)) headStates.set(head, new Set());
    if (!state) return;
    headStates.get(head)!.add(state.replace(/\s+\d+$/, ""));
    const key = canonicalState(state);
    let votes = stateHeadVotes.get(key);
    if (!votes) {
      votes = new Map();
      stateHeadVotes.set(key, votes);
    }
    votes.set(head, (votes.get(head) ?? 0) + 1);
  });
  const stateToHead = new Map<string, string>();
  for (const [state, votes] of stateHeadVotes) {
    stateToHead.set(state, dominant(votes));
  }

  // --- Secondary order booking report: dealers + secondary order value per head.
  // Rows 1-6 are banner/header rows; member rows start at 7.
  const dealersByHead = new Map<string, number>();
  let dealersTotal = 0;
  let secondaryOrderValue = 0;
  secondarySheet.eachRow((row, r) => {
    if (r < 7) return;
    const head = canonicalHead(cellString(row.getCell(2)));
    const member = cellString(row.getCell(3));
    if (!head || !member || /total/i.test(member)) return;
    const dealers = cellNumber(row.getCell(11));
    dealersByHead.set(head, (dealersByHead.get(head) ?? 0) + dealers);
    dealersTotal += dealers;
    secondaryOrderValue += cellNumber(row.getCell(13));
  });

  // --- Distributor roster: distributor counts, attributed to heads by state.
  const distByHead = new Map<string, number>();
  let distributorsTotal = 0;
  distributorSheet.eachRow((row, r) => {
    if (r < 2) return;
    if (!cellString(row.getCell(1)).startsWith("DIST#")) return;
    if (!cellString(row.getCell(2))) return;
    distributorsTotal++;
    const head = stateToHead.get(canonicalState(cellString(row.getCell(8))));
    if (head) distByHead.set(head, (distByHead.get(head) ?? 0) + 1);
  });

  // --- Retailer roster: coverage by state.
  const coverageByState = new Map<
    string,
    { state: string; districts: Set<string>; cities: Set<string>; retailers: number }
  >();
  let retailersTotal = 0;
  retailerSheet.eachRow((row, r) => {
    if (r < 2) return;
    if (!cellString(row.getCell(1)).startsWith("RET#")) return;
    retailersTotal++;
    const state = cellString(row.getCell(10));
    if (!state) return;
    const key = state.toUpperCase();
    let s = coverageByState.get(key);
    if (!s) {
      s = { state: key, districts: new Set(), cities: new Set(), retailers: 0 };
      coverageByState.set(key, s);
    }
    s.retailers++;
    const district = cellString(row.getCell(11)).toUpperCase();
    const city = cellString(row.getCell(12)).toUpperCase();
    if (district && district !== "NA") s.districts.add(district);
    if (city && city !== "NA") s.cities.add(city);
  });

  const coverage = [...coverageByState.values()]
    .map((s) => ({
      state: s.state,
      districts: s.districts.size,
      cities: s.cities.size,
      retailers: s.retailers,
    }))
    .sort((a, b) => b.retailers - a.retailers);
  const coverage_totals = {
    states: coverage.length,
    districts: coverage.reduce((a, c) => a + c.districts, 0),
    cities: coverage.reduce((a, c) => a + c.cities, 0),
    retailers: retailersTotal,
  };

  // --- heads_resources: union of heads seen in any per-head source.
  const headNames = new Set<string>([
    ...headStates.keys(),
    ...dealersByHead.keys(),
    ...distByHead.keys(),
  ]);
  const heads_resources = [...headNames]
    .map((head) => {
      const distributors = distByHead.get(head) ?? 0;
      const dealers = dealersByHead.get(head) ?? 0;
      return {
        head,
        distributors,
        dealers,
        total: distributors + dealers,
        states: [...(headStates.get(head) ?? [])].join(", "),
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    heads_resources,
    coverage,
    coverage_totals,
    state_heads: heads_resources.length,
    distributors: distributorsTotal,
    dealers: dealersTotal,
    channel_partners: distributorsTotal + dealersTotal,
    retailers: retailersTotal,
    retailer_sales_inr: Math.round(secondaryOrderValue),
  };
}
