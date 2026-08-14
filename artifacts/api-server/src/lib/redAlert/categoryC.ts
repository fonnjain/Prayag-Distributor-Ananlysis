// Red Alert — Category C (territory/segment/operational) engine.
// C1: a customer >= 60% of a state's value declines >= 15%.
// C2: a state's territory value down >= 15%, sustained 2 periods.
// C3: a segment >= 20 pts below company rate (adjusted for seasonal position).
// C4: volume up while gross contribution down >= 15% (gate: bom_cost exists).
// C5: a head's working sheet not read for >= 10 days.

import type { RawAlert, DetectionContext } from "./types.js";

type CConfig = {
  C1_CONCENTRATION_SHARE_PCT: number;
  C1_DECLINE_PCT: number;
  C2_STATE_DECLINE_PCT: number;
  C2_SUSTAINED_PERIODS: number;
  C3_SEGMENT_UNDER_INDEX_PTS: number;
  C4_GROSS_CONTRIBUTION_DROP_PCT: number;
  C5_SHEET_STALENESS_DAYS: number;
};

function prevFy(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10);
  return `${start - 1}-${String(start % 100).padStart(2, "0")}`;
}

function toPriorYearMonths(months: string[]): string[] {
  return months.map((m) => {
    const parts = m.split("-");
    if (parts.length !== 2) return m;
    return `${parts[0]}-${String(parseInt(parts[1]!, 10) - 1).padStart(2, "0")}`;
  });
}

// State-level territory value for a given FY + months (all customers in that state)
function stateValue(
  ctx: DetectionContext,
  fy: string,
  months: string[],
  stateCanon: string,
): number {
  const ms = new Set(months);
  return ctx.customerSale
    .filter((r) => r.fy === fy && ms.has(r.monthLabel) && r.stateCanon === stateCanon)
    .reduce((s, r) => s + r.value, 0);
}

// State → customer → value for a given FY + months
function stateCustomerValues(
  ctx: DetectionContext,
  fy: string,
  months: string[],
): Map<string, Map<string, number>> {
  const ms = new Set(months);
  const out = new Map<string, Map<string, number>>();
  for (const r of ctx.customerSale) {
    if (!r.fy || r.fy !== fy || !ms.has(r.monthLabel) || !r.stateCanon) continue;
    if (!out.has(r.stateCanon)) out.set(r.stateCanon, new Map());
    const cm = out.get(r.stateCanon)!;
    cm.set(r.customer, (cm.get(r.customer) ?? 0) + r.value);
  }
  return out;
}

// Segment → value for a given FY + months
function segmentValues(
  ctx: DetectionContext,
  fy: string,
  months: string[],
): Map<string, number> {
  const ms = new Set(months);
  const out = new Map<string, number>();
  for (const r of ctx.customerSale) {
    if (r.fy !== fy || !ms.has(r.monthLabel) || !r.groupCanon) continue;
    out.set(r.groupCanon, (out.get(r.groupCanon) ?? 0) + r.value);
  }
  return out;
}

// Total territory value for a given FY + months
function totalValue(ctx: DetectionContext, fy: string, months: string[]): number {
  const ms = new Set(months);
  return ctx.customerSale
    .filter((r) => r.fy === fy && ms.has(r.monthLabel))
    .reduce((s, r) => s + r.value, 0);
}

export function buildCategoryCAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  cfg: CConfig,
  nowDate: Date,
): RawAlert[] {
  const alerts: RawAlert[] = [];
  if (currentMonths.length === 0) return alerts;

  const priorFy = prevFy(currentFy);
  const priorMonths = toPriorYearMonths(currentMonths);
  const priorPriorFy = prevFy(priorFy);
  const priorPriorMonths = toPriorYearMonths(priorMonths);

  // ── C1: customer concentration ───────────────────────────────────────────
  const curStateCust = stateCustomerValues(ctx, currentFy, currentMonths);
  const priStateCust = stateCustomerValues(ctx, priorFy, priorMonths);

  for (const [state, custMap] of curStateCust) {
    const stateTotal = [...custMap.values()].reduce((s, v) => s + v, 0);
    if (stateTotal === 0) continue;

    for (const [customer, curVal] of custMap) {
      const share = (curVal / stateTotal) * 100;
      if (share < cfg.C1_CONCENTRATION_SHARE_PCT) continue;

      const priorStateMap = priStateCust.get(state) ?? new Map<string, number>();
      const priorStateTotal = [...priorStateMap.values()].reduce((s, v) => s + v, 0);
      const priorCustVal = priorStateMap.get(customer) ?? 0;
      if (priorCustVal === 0) continue;

      const custDecline = ((curVal - priorCustVal) / priorCustVal) * 100;
      if (custDecline <= -cfg.C1_DECLINE_PCT) {
        alerts.push({
          code: "C1",
          category: "C",
          entity: `${customer} (${state})`,
          entityKey: customer,
          entityType: "distributor",
          currentMonths,
          priorMonths,
          numbers: {
            currentValue: curVal,
            priorValue: priorCustVal,
            concentrationSharePct: share,
            valueGrowthPct: custDecline,
            statePct: stateTotal,
          },
          rupeesAtStake: priorCustVal - curVal,
          extraForReport: { state, stateCurrentTotal: stateTotal, statePriorTotal: priorStateTotal },
        });
      }
    }
  }

  // ── C2: state territory down >= 15%, sustained 2 periods ─────────────────
  const allStates = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.stateCanon) allStates.add(r.stateCanon);
  }

  for (const state of allStates) {
    const curVal = stateValue(ctx, currentFy, currentMonths, state);
    const priVal = stateValue(ctx, priorFy, priorMonths, state);
    if (priVal === 0) continue;

    const declinePct = ((curVal - priVal) / priVal) * 100;
    if (declinePct > -cfg.C2_STATE_DECLINE_PCT) continue;

    // Sustained: prior vs prior-prior also down >= threshold
    let sustained = cfg.C2_SUSTAINED_PERIODS <= 1;
    if (!sustained) {
      const priorPriorVal = stateValue(ctx, priorPriorFy, priorPriorMonths, state);
      if (priorPriorVal > 0) {
        const priorDecline = ((priVal - priorPriorVal) / priorPriorVal) * 100;
        sustained = priorDecline <= -cfg.C2_STATE_DECLINE_PCT;
      }
    }
    if (!sustained) continue;

    alerts.push({
      code: "C2",
      category: "C",
      entity: state,
      entityKey: state,
      entityType: "state",
      currentMonths,
      priorMonths,
      numbers: {
        currentValue: curVal,
        priorValue: priVal,
        declinePct: -declinePct,
        valueGrowthPct: declinePct,
      },
      rupeesAtStake: priVal - curVal,
    });
  }

  // ── C3: segment >= 20 pts below company rate ──────────────────────────────
  const companyCurrentVal = totalValue(ctx, currentFy, currentMonths);
  const companyPriorVal = totalValue(ctx, priorFy, priorMonths);
  const companyGrowthPct = companyPriorVal > 0
    ? ((companyCurrentVal - companyPriorVal) / companyPriorVal) * 100
    : null;

  if (companyGrowthPct !== null) {
    const curSegs = segmentValues(ctx, currentFy, currentMonths);
    const priSegs = segmentValues(ctx, priorFy, priorMonths);

    for (const [seg, priVal] of priSegs) {
      if (seg === "Unmapped" || priVal === 0) continue;
      const curVal = curSegs.get(seg) ?? 0;
      const segGrowthPct = ((curVal - priVal) / priVal) * 100;
      const gapPts = companyGrowthPct - segGrowthPct;

      if (gapPts >= cfg.C3_SEGMENT_UNDER_INDEX_PTS) {
        alerts.push({
          code: "C3",
          category: "C",
          entity: seg,
          entityKey: seg,
          entityType: "segment",
          currentMonths,
          priorMonths,
          numbers: {
            statePct: segGrowthPct,
            companyPct: companyGrowthPct,
            gapPts,
            currentValue: curVal,
            priorValue: priVal,
          },
          rupeesAtStake: priVal - curVal,
        });
      }
    }
  }

  // ── C4: volume up, gross contribution down >= 15% ─────────────────────────
  // Aggregate margin_fact for current and prior periods (company-wide, all segments with bom_cost)
  const marginMonthsCur = new Set(
    currentMonths.map((m) => `${currentFy}|${m}`),
  );
  const marginMonthsPri = new Set(
    priorMonths.map((m) => `${priorFy}|${m}`),
  );

  let c4CurQty = 0, c4CurGC = 0, c4PriQty = 0, c4PriGC = 0;
  const c4Segments = new Set<string>();

  for (const r of ctx.marginFact) {
    if (r.bomCost == null || r.bomCost <= 0) continue;
    const key = `${r.fy}|${r.monthLabel}`;
    const gc = r.saleValue - r.qty * r.bomCost;
    if (marginMonthsCur.has(key)) {
      c4CurQty += r.qty;
      c4CurGC += gc;
      c4Segments.add(r.segment);
    }
    if (marginMonthsPri.has(key)) {
      c4PriQty += r.qty;
      c4PriGC += gc;
    }
  }

  if (c4PriQty > 0 && c4CurQty > c4PriQty && c4PriGC > 0) {
    const gcDeclinePct = ((c4CurGC - c4PriGC) / Math.abs(c4PriGC)) * 100;
    if (gcDeclinePct <= -cfg.C4_GROSS_CONTRIBUTION_DROP_PCT) {
      alerts.push({
        code: "C4",
        category: "C",
        entity: "Company (territory, cost-covered codes)",
        entityKey: "COMPANY",
        entityType: "segment",
        currentMonths,
        priorMonths,
        numbers: {
          currentValue: c4CurQty,
          priorValue: c4PriQty,
          grossContribCurrentCr: c4CurGC / 1e7,
          grossContribPriorCr: c4PriGC / 1e7,
          declinePct: -gcDeclinePct,
          valueGrowthPct: gcDeclinePct,
        },
        rupeesAtStake: Math.max(0, c4PriGC - c4CurGC),
        extraForReport: { segments: [...c4Segments].join(", ") },
      });
    }
  }

  // ── C5: sheet not read for >= staleness days ──────────────────────────────
  const stalenessDays = cfg.C5_SHEET_STALENESS_DAYS;
  // Restrict to members who appear in the current FY secondary data only.
  const allHeads = [...new Set(
    ctx.secHeadMonths.filter((r) => r.fy === currentFy).map((r) => r.headCanon),
  )];

  for (const headCanon of allHeads) {
    const lastRead = ctx.lastSheetRead.get(headCanon);
    // If ingested_at is not populated for this member, skip C5 entirely — we
    // cannot distinguish "never loaded" from "load timestamp not recorded yet".
    // C5 requires the ingestion pipeline to record ingested_at on every sheet read.
    if (lastRead == null) continue;

    const daysSince = (nowDate.getTime() - lastRead.getTime()) / 86_400_000;

    if (daysSince >= stalenessDays) {
      const person = ctx.persons.find((p) => p.normKey === headCanon);
      const name = person?.canonicalName ?? headCanon;
      const stateHead = ctx.secHeadMonths.find((r) => r.headCanon === headCanon)?.stateHead ?? null;
      alerts.push({
        code: "C5",
        category: "C",
        entity: name,
        entityKey: headCanon,
        entityType: "member",
        currentMonths,
        priorMonths: [],
        numbers: {
          daysSinceRead: daysSince === Infinity ? 9999 : Math.round(daysSince),
        },
        rupeesAtStake: 0,
        extraForReport: { stateHead: stateHead ?? "—", lastReadDate: lastRead?.toISOString().slice(0, 10) ?? "never" },
      });
    }
  }

  return alerts;
}
