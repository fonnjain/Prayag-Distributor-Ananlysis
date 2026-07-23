// Phase D6: Customer concentration and new vs. repeat business.
//
// Pure sync, no I/O. Derives everything from the retailer rows already loaded by D1.
//
// Two questions answered:
//   1. Where is the business actually coming from?  (top-N customer concentration)
//   2. Is the salesperson generating new business or recycling the same customers?
//      (retained / reactivated / at-risk / never classification)

// ── Row shape fed by D1 aggregation ─────────────────────────────────────────

export type D6RetailerInput = {
  name:          string;
  orderBooking:  number;        // current-FY OB (ORDERBOOK / OB column)
  sale:          number;        // prior-FY reference OB (SALE / OLDPARTYOB column)
  visits:        number | null;
  channel:       string;        // distributor name, "Direct Dealer", or "Unassigned"
  isDirectDealer: boolean;      // true only for blank-distributor direct-channel rows
};

// ── Output shapes ────────────────────────────────────────────────────────────

export type TopCustomerEntry = {
  rank:          number;
  name:          string;
  orderBooking:  number;
  sharePct:      number;
  cumulativePct: number;
  visits:        number | null;
  channel:       string;
  isDirectDealer: boolean;
};

export type CustomerState = "retained" | "reactivated" | "at_risk" | "never";

export type CustomerStateGroup = {
  state:         CustomerState;
  label:         string;         // human-readable title
  count:         number;
  obThisYear:    number;
  obLastYear:    number;
  visits:        number | null;
  bizPerVisit:   number | null;
  visitSharePct: number | null;  // this group's visits / total visits × 100
  obSharePct:    number | null;  // this group's OB / total (retained+reactivated) OB × 100
};

export type CustomerConcentration = {
  totalOb:              number;
  totalVisits:          number | null;
  overallBizPerVisit:   number | null;
  top5Ob:               number;
  top5SharePct:         number | null;
  top10Ob:              number;
  top10SharePct:        number | null;
  topCustomers:         TopCustomerEntry[];       // up to 10
  customerStates:       CustomerStateGroup[];     // 4 entries in fixed order
  dataCutoffLabel:      string;                   // e.g. "30 Jun 2026"
  dataCutoffMonthsElapsed: number;               // e.g. 3
  newRetailersOnboarded:   number | null;        // from dashboard (totalRetailers - totalOldRetailers)
  newPartyOrderBooking:    number | null;        // from dashboard kpis
};

// ── Cutoff helper ─────────────────────────────────────────────────────────────

// Returns the last day of the last fully-elapsed month in the FY, relative to today.
// For FY2026-27 on Jul 23 2026: { label:"30 Jun 2026", monthsElapsed:3 }
function computeDataCutoff(fy: string): { label: string; monthsElapsed: number } {
  const startYear = parseInt(fy.split("-")[0], 10);
  if (isNaN(startYear)) return { label: "Unknown", monthsElapsed: 0 };

  const today = new Date();
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  let monthsElapsed = 0;
  let cutoffLabel = "";

  // FY runs Apr (calendar month 3) … Mar next year (calendar month 2)
  for (let i = 0; i < 12; i++) {
    const calMonth = (3 + i) % 12;                // 0-based calendar month (0=Jan)
    const year     = calMonth < 3 ? startYear + 1 : startYear;
    const lastDay  = new Date(year, calMonth + 1, 0); // last moment of the month
    if (lastDay < today) {
      monthsElapsed = i + 1;
      const d = lastDay.getDate();
      cutoffLabel = `${d} ${MONTH_NAMES[calMonth]} ${year}`;
    } else {
      break;
    }
  }

  return { label: cutoffLabel || "No complete months", monthsElapsed };
}

// ── Main computation ─────────────────────────────────────────────────────────

export function computeCustomerConcentration(
  rows:                  D6RetailerInput[],
  fy:                    string,
  newPartyOrderBooking:  number | null,
  newRetailersOnboarded: number | null,
): CustomerConcentration {
  const cutoff = computeDataCutoff(fy);

  // ── Top-N customers ──────────────────────────────────────────────────────
  const totalOb = rows.reduce((s, r) => s + r.orderBooking, 0);

  const visitRows = rows.filter((r) => r.visits !== null);
  const totalVisits =
    visitRows.length > 0 ? visitRows.reduce((s, r) => s + (r.visits ?? 0), 0) : null;

  const overallBizPerVisit =
    totalVisits != null && totalVisits > 0 && totalOb > 0
      ? Math.round(totalOb / totalVisits)
      : null;

  // Sort all rows by current-year OB desc; only include rows with OB > 0 in
  // the top-N list (retailers with no business this year are not "top customers").
  const byOb = [...rows]
    .filter((r) => r.orderBooking > 0)
    .sort((a, b) => b.orderBooking - a.orderBooking);

  const top5Ob  = byOb.slice(0, 5).reduce((s, r) => s + r.orderBooking, 0);
  const top10Ob = byOb.slice(0, 10).reduce((s, r) => s + r.orderBooking, 0);

  const top5SharePct  = totalOb > 0 ? (top5Ob  / totalOb) * 100 : null;
  const top10SharePct = totalOb > 0 ? (top10Ob / totalOb) * 100 : null;

  let cumulative = 0;
  const topCustomers: TopCustomerEntry[] = byOb.slice(0, 10).map((r, idx) => {
    const share = totalOb > 0 ? (r.orderBooking / totalOb) * 100 : 0;
    cumulative += share;
    return {
      rank:           idx + 1,
      name:           r.name,
      orderBooking:   r.orderBooking,
      sharePct:       share,
      cumulativePct:  cumulative,
      visits:         r.visits,
      channel:        r.channel,
      isDirectDealer: r.isDirectDealer,
    };
  });

  // ── Customer state classification ────────────────────────────────────────
  // RETAINED    — OB > 0 this year AND sale > 0 last year
  // REACTIVATED — OB > 0 this year AND sale = 0 last year  (was dormant, now active)
  // AT RISK     — OB = 0 this year AND sale > 0 last year  (not yet converted)
  // NEVER       — OB = 0 this year AND sale = 0 last year  (no business either year)

  type StateAccum = {
    count: number; obThis: number; obLast: number;
    visits: number | null;
  };
  const accum: Record<CustomerState, StateAccum> = {
    retained:    { count: 0, obThis: 0, obLast: 0, visits: null },
    reactivated: { count: 0, obThis: 0, obLast: 0, visits: null },
    at_risk:     { count: 0, obThis: 0, obLast: 0, visits: null },
    never:       { count: 0, obThis: 0, obLast: 0, visits: null },
  };

  function addVisit(acc: StateAccum, v: number | null) {
    if (v === null) return;
    acc.visits = (acc.visits ?? 0) + v;
  }

  for (const r of rows) {
    const hasThis = r.orderBooking > 0;
    const hasLast = r.sale > 0;
    const state: CustomerState =
      hasThis && hasLast  ? "retained"
      : hasThis           ? "reactivated"
      : hasLast           ? "at_risk"
      :                     "never";
    const a = accum[state];
    a.count++;
    a.obThis += r.orderBooking;
    a.obLast += r.sale;
    addVisit(a, r.visits);
  }

  const totalActiveOb = accum.retained.obThis + accum.reactivated.obThis; // OB from converting groups

  function buildGroup(state: CustomerState, label: string): CustomerStateGroup {
    const a  = accum[state];
    const bv = a.visits != null && a.visits > 0 && a.obThis > 0
      ? Math.round(a.obThis / a.visits)
      : null;
    const visitSharePct = totalVisits != null && totalVisits > 0 && a.visits != null
      ? (a.visits / totalVisits) * 100
      : null;
    const obSharePct = totalOb > 0 && a.obThis > 0
      ? (a.obThis / totalOb) * 100
      : null;
    return { state, label, count: a.count, obThisYear: a.obThis, obLastYear: a.obLast,
             visits: a.visits, bizPerVisit: bv, visitSharePct, obSharePct };
  }

  // AT RISK label includes cutoff date; never calls it "lost".
  const atRiskLabel = cutoff.monthsElapsed > 0
    ? `AT RISK — not yet converted this year (data to ${cutoff.label}, ${cutoff.monthsElapsed} month${cutoff.monthsElapsed === 1 ? "" : "s"} elapsed)`
    : "AT RISK — not yet converted this year";

  const customerStates: CustomerStateGroup[] = [
    buildGroup("retained",    "RETAINED"),
    buildGroup("reactivated", "REACTIVATED"),
    buildGroup("at_risk",     atRiskLabel),
    buildGroup("never",       "NEVER"),
  ];

  void totalActiveOb; // computed for future use (e.g. share within active set)

  return {
    totalOb,
    totalVisits,
    overallBizPerVisit,
    top5Ob,
    top5SharePct,
    top10Ob,
    top10SharePct,
    topCustomers,
    customerStates,
    dataCutoffLabel:       cutoff.label,
    dataCutoffMonthsElapsed: cutoff.monthsElapsed,
    newRetailersOnboarded,
    newPartyOrderBooking,
  };
}
