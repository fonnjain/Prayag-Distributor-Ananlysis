// Red Alert — Category S (supply chain) engine.
// S1: a distributor stops buying primary (≥ 3 consecutive zero-primary months)
//     while secondary sell-through continues — the "destocking" signal.
//
// This fires BEFORE the underlying retailers go silent (which happens when
// the distributor's stock is exhausted).  It is a supply-chain alert, not
// a sales performance one.
//
// DATA SOURCES:
//   Primary purchases: customerSale (sale_line_current, territory rows)
//   Secondary sell-through: distSecMonthly (secondary_sku_line by distributor)
//
// LINKAGE:
//   secondary_sku_line.distributor  →  norm2()  →  sale_line_current.customer
//   Two-word normalisation (first two alphabetic words ≥ 4 chars, lowercase)
//   catches name variants between the two sources.

import type { RawAlert, DetectionContext } from "./types.js";

type SConfig = {
  S1_CONSECUTIVE_ZERO_MONTHS: number;
  S1_MIN_SECONDARY_RUPEES: number;
};

// All FY month labels in chronological order.
// e.g. fyMonthLabels("2025-26") → ["Apr-25","May-25",…,"Mar-26"]
function fyMonthLabels(fy: string): string[] {
  const startYear = parseInt(fy.slice(0, 4), 10);
  const names = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  return names.map((name, i) => {
    const year = i < 9 ? startYear : startYear + 1;
    return `${name}-${String(year % 100).padStart(2, "0")}`;
  });
}

function prevFy(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10);
  return `${start - 1}-${String(start % 100).padStart(2, "0")}`;
}

// Two-word normalisation: first two meaningful (≥4 char) alphabetic words, lowercase.
// "Avirasico International"             → "avirasico international"
// "AVIRASICO INTERNATIONAL (KOLKATTA)"  → "avirasico international"   ✓
// "ARADHYA KEDIA DISTRIBUTION HOUSE..."  → "aradhya kedia"
// "ARADHYA KEDIA DISTRIBUTION HOUSE..."  → "aradhya kedia"             ✓
function norm2(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 4)
    .slice(0, 2)
    .join(" ");
}

// Build a map: norm2(customer) → customer name (canonical from sale_line_current)
// When multiple customers share the same norm2 key, keep the one with most total sales.
function buildPrimaryNormMap(ctx: DetectionContext): Map<string, string> {
  const custTotals = new Map<string, { customer: string; total: number }>();
  for (const r of ctx.customerSale) {
    const key = norm2(r.customer);
    if (!key) continue;
    const prev = custTotals.get(key);
    if (!prev) {
      custTotals.set(key, { customer: r.customer, total: r.value });
    } else {
      prev.total += r.value;
    }
  }
  const out = new Map<string, string>();
  for (const [key, { customer }] of custTotals) {
    out.set(key, customer);
  }
  return out;
}

// Monthly primary purchase for a customer across FYs.
// Key: `${fy}|${monthLabel}` → total amount.
function buildPrimaryByKey(ctx: DetectionContext): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of ctx.customerSale) {
    const k = `${r.fy}|${r.monthLabel}`;
    out.set(`${r.customer}|${k}`, (out.get(`${r.customer}|${k}`) ?? 0) + r.value);
  }
  return out;
}

export function buildCategorySAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  cfg: SConfig,
): RawAlert[] {
  if (currentMonths.length === 0) return [];

  const priorFy = prevFy(currentFy);
  // Full prior FY (closed) + current complete months
  const priorAllMonths = fyMonthLabels(priorFy); // all 12

  // Ordered timeline: prior FY months → current FY months
  const timeline: Array<{ fy: string; month: string }> = [
    ...priorAllMonths.map((m) => ({ fy: priorFy, month: m })),
    ...currentMonths.map((m) => ({ fy: currentFy, month: m })),
  ];

  const primaryNormToCustomer = buildPrimaryNormMap(ctx);
  const primaryByKey = buildPrimaryByKey(ctx);

  // Collect all distributor names that appear in secondary data for current+prior FY
  const distributors = new Set<string>();
  for (const [key] of ctx.distSecMonthly) {
    const parts = key.split("|");
    if (parts.length < 3) continue;
    const fy = parts[1]!;
    if (fy === currentFy || fy === priorFy) {
      distributors.add(parts[0]!);
    }
  }

  const alerts: RawAlert[] = [];

  for (const dist of distributors) {
    const distNorm = norm2(dist);
    if (!distNorm) continue;
    const primaryCustomer = primaryNormToCustomer.get(distNorm);
    if (!primaryCustomer) continue; // no matching primary customer — skip

    // Check that secondary volume is meaningful
    const totalSec = timeline.reduce(
      (s, { fy, month }) => s + (ctx.distSecMonthly.get(`${dist}|${fy}|${month}`) ?? 0),
      0,
    );
    if (totalSec < cfg.S1_MIN_SECONDARY_RUPEES) continue;

    // Build month-by-month timeline
    const monthData = timeline.map(({ fy, month }) => ({
      fy,
      month,
      primary: primaryByKey.get(`${primaryCustomer}|${fy}|${month}`) ?? 0,
      secondary: ctx.distSecMonthly.get(`${dist}|${fy}|${month}`) ?? 0,
    }));

    // Find the LAST primary purchase month (for "months since last primary")
    const lastPrimaryIdx = [...monthData].map((d, i) => ({ ...d, i }))
      .filter((d) => d.primary > 0)
      .at(-1);

    if (lastPrimaryIdx == null) continue; // never bought primary — not a destocking signal

    // Find first run of ≥ S1_CONSECUTIVE_ZERO_MONTHS consecutive zero-primary months
    // where secondary is positive in at least one of those months.
    let consecZeros = 0;
    let alertFireIdx: number | null = null;

    for (let i = 0; i < monthData.length; i++) {
      if (monthData[i]!.primary === 0) {
        consecZeros++;
        if (
          consecZeros >= cfg.S1_CONSECUTIVE_ZERO_MONTHS &&
          alertFireIdx === null
        ) {
          // Confirm secondary was positive in this run
          const runStart = i - consecZeros + 1;
          const runSec = monthData.slice(runStart, i + 1).reduce((s, d) => s + d.secondary, 0);
          if (runSec > 0) {
            alertFireIdx = i;
          }
        }
      } else {
        consecZeros = 0;
      }
    }

    if (alertFireIdx === null) continue; // never hit 3 consecutive zeros with secondary

    // Confirm the streak is STILL ACTIVE (extends into currentMonths window)
    // i.e. the most recent month we have data for is still zero-primary.
    // Check: the last month in currentMonths must be in the zero streak.
    const lastCurrentMonth = currentMonths.length > 0 ? currentMonths[currentMonths.length - 1]! : null;
    const lastCurrentIdx = lastCurrentMonth
      ? monthData.findIndex((d) => d.fy === currentFy && d.month === lastCurrentMonth)
      : -1;
    if (lastCurrentIdx < 0) continue;
    // Walk back from last current month — must be consecutive zeros
    let streakActive = false;
    let streakLen = 0;
    for (let i = lastCurrentIdx; i >= 0; i--) {
      if (monthData[i]!.primary === 0) {
        streakLen++;
        if (streakLen >= cfg.S1_CONSECUTIVE_ZERO_MONTHS) { streakActive = true; break; }
      } else {
        break;
      }
    }
    if (!streakActive) continue; // streak resolved before current window end

    // Compute alert fields
    const lastPrimaryMonth = monthData[lastPrimaryIdx.i]!.month;
    const lastPrimaryFy = monthData[lastPrimaryIdx.i]!.fy;
    const alertFireMonth = monthData[alertFireIdx]!.month;

    // Secondary sold from stock since last primary (inclusive of last-primary month? No — after it)
    const stockSaleStart = lastPrimaryIdx.i + 1;
    const secSoldFromStock = monthData
      .slice(stockSaleStart)
      .reduce((s, d) => s + d.secondary, 0);

    // Month secondary first hits zero after the alert fires
    let firstZeroSecMonth: string | null = null;
    for (let i = alertFireIdx + 1; i < monthData.length; i++) {
      if (monthData[i]!.secondary === 0 && i >= stockSaleStart) {
        firstZeroSecMonth = monthData[i]!.month;
        break;
      }
    }

    // Prior monthly secondary average (months when distributor was also buying primary)
    const priorBuyingMonths = monthData.filter((d) => d.primary > 0);
    const priorSecAvg =
      priorBuyingMonths.length > 0
        ? priorBuyingMonths.reduce((s, d) => s + d.secondary, 0) / priorBuyingMonths.length
        : 0;

    // Months since last primary (from the alert fire point)
    const monthsSinceLastPrimary = alertFireIdx - lastPrimaryIdx.i;

    // currentMonths for this alert = the consecutive zero-primary months in the current FY
    const alertCurrentMonths = monthData
      .filter((d) => d.fy === currentFy && d.primary === 0)
      .map((d) => d.month);
    // priorMonths = same calendar months in the prior-prior FY (convention for calibration)
    const priorPriorFy = prevFy(priorFy);
    const alertPriorMonths = alertCurrentMonths.map((m) => {
      const parts = m.split("-");
      return parts.length === 2
        ? `${parts[0]}-${String(parseInt(parts[1]!, 10) - 1).padStart(2, "0")}`
        : m;
    });

    // Find retailers under this distributor in the prior window
    // (from the retailerDistributors reverse — distributor appears in the sets)
    const retailersUnder = new Set<string>();
    for (const [retailer, monthMap] of ctx.retailerDistributors) {
      for (const [mk, distSet] of monthMap) {
        const [fyPart] = mk.split("|");
        if (fyPart === priorFy && distSet.has(dist)) {
          retailersUnder.add(retailer);
        }
      }
    }

    alerts.push({
      code: "S1",
      category: "S",
      entity: dist,
      entityKey: dist,
      entityType: "distributor",
      currentMonths: alertCurrentMonths.length > 0 ? alertCurrentMonths : [alertFireMonth],
      priorMonths: alertPriorMonths.length > 0 ? alertPriorMonths : [],
      numbers: {
        monthsSinceLastPrimary,
        secSoldFromStock,
        priorSecAvgMonthly: priorSecAvg,
        priorSecAvgCr: priorSecAvg / 1e7,
      },
      rupeesAtStake: secSoldFromStock, // ₹ of secondary that will be lost when stock runs out
      extraForReport: {
        lastPrimaryMonth: `${lastPrimaryMonth} (${lastPrimaryFy})`,
        alertFireMonth,
        firstZeroSecMonth: firstZeroSecMonth ?? "(not yet)",
        primaryCustomer,
        retailersUnder: [...retailersUnder].join(","),
        retailerCount: retailersUnder.size,
      },
    });
  }

  return alerts;
}
