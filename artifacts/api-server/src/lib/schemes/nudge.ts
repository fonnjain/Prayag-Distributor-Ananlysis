// Scheme Nudge Engine — core computation.
//
// THE MECHANIC (from the spec):
//   A slab pays a % on the distributor's ENTIRE billing for the period —
//   not just the amount above the threshold. So crossing a slab is worth far
//   more than the top-up that gets you there.
//
//   they_earn = (next_threshold × next_rate) − (billed_so_far × current_rate)
//   gap       = next_threshold − billed_so_far
//   roi       = they_earn / gap
//
// ROI FILTER: suppress nudges where roi < roi_threshold (default 5%).
// A nudge engine that cries wolf gets ignored and the whole feature is dead.
//
// CONDITIONS (all applied before any nudge is shown):
//   1. Slab base = SALE (dispatched), not order booking — we query sale_line.
//   2. Exclude is_territory = false (non-territory, Govt, Project etc).
//   3. Exclude customers matching GOVT/GEM/JJM/PROJECT patterns in name.
//   4. BLOCKED = distributor with overdue bills (from dues fetcher).
//   5. Deadline = 25th of the last month of the quarter, not end of month.
import { pool } from "@workspace/db";
import schemeMaster from "../../../config/scheme_master.json";

export type SchemeSlab = {
  threshold: number;
  rate: number | null;
  reward?: string | null;
  rewardType: "pct" | "trip" | "pct_or_trip";
};

export type SchemeConfig = {
  id: string;
  name: string;
  basis: string;
  slabs: SchemeSlab[];
  stateRestriction?: string[];
};

// Quarter → month labels for a given FY
export function getQuarterMonths(fy: string, q: "Q1" | "Q2" | "Q3" | "Q4"): string[] {
  const [startYr] = fy.split("-").map(Number);
  const endYrSuffix = String(startYr + 1).slice(-2);
  const startSuffix = String(startYr).slice(-2);
  const map: Record<string, string[]> = {
    Q1: [`Apr-${startSuffix}`, `May-${startSuffix}`, `Jun-${startSuffix}`],
    Q2: [`Jul-${startSuffix}`, `Aug-${startSuffix}`, `Sep-${startSuffix}`],
    Q3: [`Oct-${startSuffix}`, `Nov-${startSuffix}`, `Dec-${startSuffix}`],
    Q4: [`Jan-${endYrSuffix}`, `Feb-${endYrSuffix}`, `Mar-${endYrSuffix}`],
  };
  return map[q] ?? map.Q1;
}

export function getCurrentQuarter(fy: string): "Q1" | "Q2" | "Q3" | "Q4" {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  if (month >= 4 && month <= 6) return "Q1";
  if (month >= 7 && month <= 9) return "Q2";
  if (month >= 10 && month <= 12) return "Q3";
  return "Q4";
}

export function getQuarterDeadline(fy: string, q: "Q1" | "Q2" | "Q3" | "Q4"): Date {
  const [startYr] = fy.split("-").map(Number);
  const deadlineMap: Record<string, [number, number]> = {
    Q1: [startYr, 6],  // 25 Jun
    Q2: [startYr, 9],  // 25 Sep
    Q3: [startYr, 12], // 25 Dec
    Q4: [startYr + 1, 3], // 25 Mar
  };
  const [yr, mo] = deadlineMap[q] ?? deadlineMap.Q2;
  return new Date(yr, mo - 1, 25);
}

// Find the slab the customer is currently in (highest threshold crossed)
function getCurrentSlab(slabs: SchemeSlab[], amount: number): SchemeSlab | null {
  let current: SchemeSlab | null = null;
  for (const s of slabs) {
    if (amount >= s.threshold) current = s;
    else break;
  }
  return current;
}

// Find the next slab threshold above current billing
function getNextSlab(slabs: SchemeSlab[], amount: number): SchemeSlab | null {
  for (const s of slabs) {
    if (s.threshold > amount) return s;
  }
  return null;
}

export type NudgeRow = {
  customer: string;
  stateHead: string | null;
  schemeId: string;
  basketName: string;
  billedSoFar: number;
  currentRate: number;
  currentEarnings: number;
  nextSlab: number;
  nextRate: number | null;
  gap: number;
  theyEarn: number | null;
  roi: number | null;
  rewardType: "pct" | "trip" | "pct_or_trip";
  tripLabel: string | null;
  status: "NUDGE" | "BLOCKED" | "AT_MAX" | "TRIP_ZONE";
  blockedReason: string | null;
};

// Exclude non-retail customers by name pattern
const EXCLUDE_PATTERNS = (schemeMaster.conditions.excludePatterns as string[]).map(
  (p) => p.toUpperCase(),
);

function isExcluded(customer: string): boolean {
  const upper = customer.toUpperCase();
  return EXCLUDE_PATTERNS.some((p) => upper.includes(p));
}

const BASKET_MAP = schemeMaster.basketMap as Record<string, string>;
const SCHEMES: SchemeConfig[] = schemeMaster.schemes as SchemeConfig[];
const SCHEME_MAP = new Map(SCHEMES.map((s) => [s.id, s]));

export type NudgeResult = {
  fy: string;
  quarter: string;
  months: string[];
  deadline: string;
  daysToDeadline: number;
  totalOpportunity: number;
  totalSchemeCost: number;
  nudgeCount: number;
  nudges: NudgeRow[];
  blocked: string[];
  duesDataAvailable: boolean;
};

export async function computeNudgeList(
  fy: string,
  q: "Q1" | "Q2" | "Q3" | "Q4",
  blockedCustomers: Set<string>,
  duesDataAvailable: boolean,
  roiThreshold: number = schemeMaster.conditions.defaultRoiThreshold,
): Promise<NudgeResult> {
  const months = getQuarterMonths(fy, q);
  const deadline = getQuarterDeadline(fy, q);
  const daysToDeadline = Math.ceil(
    (deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );

  // Build a VALUES list of (group, scheme_id) for the join
  const basketEntries = Object.entries(BASKET_MAP);
  if (!basketEntries.length) {
    return {
      fy, quarter: q, months, deadline: deadline.toDateString(),
      daysToDeadline, totalOpportunity: 0, totalSchemeCost: 0,
      nudgeCount: 0, nudges: [], blocked: [], duesDataAvailable,
    };
  }

  // Quarterly cumulative schemes only (not single-bill or annual — those are separate)
  const quarterlySchemeIds = SCHEMES
    .filter((s) => s.basis === "cumulative_quarter")
    .map((s) => s.id);

  const quarterlyGroups = basketEntries
    .filter(([, sid]) => quarterlySchemeIds.includes(sid))
    .map(([g]) => g);

  if (!quarterlyGroups.length || !months.length) {
    return {
      fy, quarter: q, months, deadline: deadline.toDateString(),
      daysToDeadline, totalOpportunity: 0, totalSchemeCost: 0,
      nudgeCount: 0, nudges: [], blocked: [], duesDataAvailable,
    };
  }

  const monthPlaceholders = months.map((_, i) => `$${i + 2}`).join(", ");
  const groupPlaceholders = quarterlyGroups
    .map((_, i) => `$${months.length + 2 + i}`)
    .join(", ");

  const sql = `
    SELECT
      sl.customer,
      sl.group_raw   AS group_raw,
      sl.head_canon  AS state_head,
      SUM(sl.amount::numeric) AS total_amount
    FROM sale_line_current sl
    WHERE sl.fy = $1
      AND sl.month_label IN (${monthPlaceholders})
      AND sl.group_raw IN (${groupPlaceholders})
      AND (sl.is_territory IS NULL OR sl.is_territory = true)
    GROUP BY sl.customer, sl.group_raw, sl.head_canon
    ORDER BY SUM(sl.amount::numeric) DESC
  `;

  const params = [fy, ...months, ...quarterlyGroups];
  const { rows } = await pool.query<{
    customer: string;
    group_raw: string;
    state_head: string | null;
    total_amount: string;
  }>(sql, params);

  // Group by (customer, scheme_id) — a customer may buy multiple groups in the same basket
  const buckets = new Map<string, {
    customer: string;
    schemeId: string;
    stateHead: string | null;
    total: number;
  }>();

  for (const row of rows) {
    const customer = row.customer ?? "";
    if (!customer || isExcluded(customer)) continue;
    const rawUpper = (row.group_raw ?? "").toUpperCase().trim();
    const schemeId = BASKET_MAP[row.group_raw] ?? BASKET_MAP[rawUpper];
    if (!schemeId) continue;
    const key = `${customer}|${schemeId}`;
    const existing = buckets.get(key);
    const amount = parseFloat(row.total_amount ?? "0");
    if (existing) {
      existing.total += amount;
    } else {
      buckets.set(key, {
        customer,
        schemeId,
        stateHead: row.state_head,
        total: amount,
      });
    }
  }

  const nudges: NudgeRow[] = [];
  const blocked: string[] = [];
  let totalOpportunity = 0;
  let totalSchemeCost = 0;

  for (const { customer, schemeId, stateHead, total: billedSoFar } of buckets.values()) {
    const scheme = SCHEME_MAP.get(schemeId);
    if (!scheme) continue;

    const isBlocked = blockedCustomers.has(customer.toUpperCase().trim());

    const currentSlab = getCurrentSlab(scheme.slabs, billedSoFar);
    const nextSlab = getNextSlab(scheme.slabs, billedSoFar);

    const currentRate = currentSlab?.rate ?? 0;
    const currentEarnings = currentRate * billedSoFar;
    totalSchemeCost += currentEarnings;

    if (isBlocked) {
      if (!blocked.includes(customer)) blocked.push(customer);
      nudges.push({
        customer, stateHead, schemeId, basketName: scheme.name,
        billedSoFar, currentRate, currentEarnings,
        nextSlab: nextSlab?.threshold ?? 0, nextRate: nextSlab?.rate ?? null,
        gap: nextSlab ? nextSlab.threshold - billedSoFar : 0,
        theyEarn: null, roi: null,
        rewardType: nextSlab?.rewardType ?? "pct",
        tripLabel: nextSlab?.reward ?? null,
        status: "BLOCKED",
        blockedReason: "OVERDUE_BILLS",
      });
      continue;
    }

    if (!nextSlab) {
      nudges.push({
        customer, stateHead, schemeId, basketName: scheme.name,
        billedSoFar, currentRate, currentEarnings,
        nextSlab: 0, nextRate: null, gap: 0,
        theyEarn: null, roi: null, rewardType: "pct",
        tripLabel: null, status: "AT_MAX", blockedReason: null,
      });
      continue;
    }

    const gap = nextSlab.threshold - billedSoFar;

    if (nextSlab.rewardType === "trip") {
      nudges.push({
        customer, stateHead, schemeId, basketName: scheme.name,
        billedSoFar, currentRate, currentEarnings,
        nextSlab: nextSlab.threshold, nextRate: null, gap,
        theyEarn: null, roi: null, rewardType: "trip",
        tripLabel: nextSlab.reward ?? null,
        status: "TRIP_ZONE", blockedReason: null,
      });
      totalOpportunity += gap;
      continue;
    }

    const nextRate = nextSlab.rate ?? 0;
    const theyEarn = nextSlab.threshold * nextRate - billedSoFar * currentRate;
    const roi = gap > 0 ? theyEarn / gap : 0;

    if (roi < roiThreshold) continue; // Below ROI threshold — suppress

    totalOpportunity += gap;
    nudges.push({
      customer, stateHead, schemeId, basketName: scheme.name,
      billedSoFar, currentRate, currentEarnings,
      nextSlab: nextSlab.threshold, nextRate, gap,
      theyEarn, roi, rewardType: "pct",
      tripLabel: null, status: "NUDGE", blockedReason: null,
    });
  }

  // Sort by theyEarn descending (nulls last)
  nudges.sort((a, b) => {
    if (a.status === "BLOCKED" && b.status !== "BLOCKED") return 1;
    if (b.status === "BLOCKED" && a.status !== "BLOCKED") return -1;
    return (b.theyEarn ?? 0) - (a.theyEarn ?? 0);
  });

  return {
    fy, quarter: q, months,
    deadline: deadline.toISOString().slice(0, 10),
    daysToDeadline,
    totalOpportunity,
    totalSchemeCost,
    nudgeCount: nudges.filter((n) => n.status === "NUDGE").length,
    nudges,
    blocked,
    duesDataAvailable,
  };
}

// ── Cockpit (management summary) ─────────────────────────────────────────────

export type CockpitRow = {
  schemeId: string;
  schemeName: string;
  participantCount: number;
  totalBilled: number;
  totalEarned: number;
  nudgeCount: number;
  opportunityAmount: number;
};

export type CockpitResult = {
  fy: string;
  quarter: string;
  deadline: string;
  daysToDeadline: number;
  totalLiveOpportunity: number;
  totalSchemeCost: number;
  totalNudges: number;
  byScheme: CockpitRow[];
};

export function buildCockpit(nudgeResult: NudgeResult): CockpitResult {
  const byScheme = new Map<string, CockpitRow>();
  for (const n of nudgeResult.nudges) {
    if (!byScheme.has(n.schemeId)) {
      byScheme.set(n.schemeId, {
        schemeId: n.schemeId,
        schemeName: n.basketName,
        participantCount: 0,
        totalBilled: 0,
        totalEarned: 0,
        nudgeCount: 0,
        opportunityAmount: 0,
      });
    }
    const row = byScheme.get(n.schemeId)!;
    row.participantCount++;
    row.totalBilled += n.billedSoFar;
    row.totalEarned += n.currentEarnings;
    if (n.status === "NUDGE") {
      row.nudgeCount++;
      row.opportunityAmount += n.gap;
    }
  }
  return {
    fy: nudgeResult.fy,
    quarter: nudgeResult.quarter,
    deadline: nudgeResult.deadline,
    daysToDeadline: nudgeResult.daysToDeadline,
    totalLiveOpportunity: nudgeResult.totalOpportunity,
    totalSchemeCost: nudgeResult.totalSchemeCost,
    totalNudges: nudgeResult.nudgeCount,
    byScheme: [...byScheme.values()].sort((a, b) => b.opportunityAmount - a.opportunityAmount),
  };
}

// ── Annual Tracker ────────────────────────────────────────────────────────────

export type AnnualRow = {
  customer: string;
  stateHead: string | null;
  fyTotal: number;
  lyTotal: number;
  seasonalityPctElapsed: number;
  projectedTotal: number;
  projectedVsLyPct: number | null;
  atRisk: boolean;
  currentSlabIdx: number;
  currentRate: number | null;
  schemeId: "A_DIST";
};

export async function computeAnnualTracker(
  fy: string,
  completeMonths: string[],
): Promise<AnnualRow[]> {
  if (!completeMonths.length) return [];
  const [startYr] = fy.split("-").map(Number);
  const priorFy = `${startYr - 1}-${String(startYr).slice(-2)}`;

  const seasonality = schemeMaster.seasonality as Record<string, number>;

  // Elapsed seasonality share
  const elapsedPct = completeMonths.reduce((sum, ml) => {
    const mon = ml.slice(0, 3); // 'Apr' from 'Apr-26'
    return sum + (seasonality[mon] ?? 0);
  }, 0);

  const monthPlaceholders = completeMonths.map((_, i) => `$${i + 2}`).join(", ");
  const priorMonths = completeMonths.map((ml) => {
    const [mon] = ml.split("-");
    const [pStartYr] = priorFy.split("-").map(Number);
    return `${mon}-${String(pStartYr).slice(-2)}`;
  });
  const priorPlaceholders = priorMonths.map((_, i) => `$${completeMonths.length + i + 3}`).join(", ");

  // The annual scheme applies to all groups — sum all territory sale
  const sql = `
    WITH cy AS (
      SELECT customer, head_canon AS state_head, SUM(amount::numeric) AS total
      FROM sale_line
      WHERE fy = $1
        AND month_label IN (${monthPlaceholders})
        AND (is_territory IS NULL OR is_territory = true)
      GROUP BY customer, head_canon
    ),
    ly AS (
      SELECT customer, SUM(amount::numeric) AS total
      FROM sale_line
      WHERE fy = $${completeMonths.length + 2}
        AND month_label IN (${priorPlaceholders})
        AND (is_territory IS NULL OR is_territory = true)
      GROUP BY customer
    )
    SELECT
      cy.customer,
      cy.state_head,
      cy.total AS cy_total,
      COALESCE(ly.total, 0) AS ly_total
    FROM cy
    LEFT JOIN ly USING (customer)
    WHERE cy.total >= 100000
    ORDER BY cy.total DESC
    LIMIT 500
  `;

  const params = [fy, ...completeMonths, priorFy, ...priorMonths];
  const { rows } = await pool.query<{
    customer: string;
    state_head: string | null;
    cy_total: string;
    ly_total: string;
  }>(sql, params);

  const aDistScheme = SCHEME_MAP.get("A_DIST");
  if (!aDistScheme) return [];

  return rows.map((row) => {
    const cyTotal = parseFloat(row.cy_total ?? "0");
    const lyTotal = parseFloat(row.ly_total ?? "0");

    // Annualise: projected = cyTotal / elapsed% × 100
    const projectedTotal =
      elapsedPct > 0 ? (cyTotal / elapsedPct) * 100 : cyTotal;

    const projectedVsLyPct =
      lyTotal > 0 ? (projectedTotal - lyTotal) / lyTotal : null;

    const atRisk = lyTotal > 0 && projectedTotal < lyTotal;

    const currentSlab = getCurrentSlab(aDistScheme.slabs, cyTotal);
    const slabIdx = currentSlab
      ? aDistScheme.slabs.indexOf(currentSlab)
      : -1;

    return {
      customer: row.customer,
      stateHead: row.state_head,
      fyTotal: cyTotal,
      lyTotal,
      seasonalityPctElapsed: elapsedPct,
      projectedTotal,
      projectedVsLyPct,
      atRisk,
      currentSlabIdx: slabIdx,
      currentRate: currentSlab?.rate ?? null,
      schemeId: "A_DIST" as const,
    };
  });
}
