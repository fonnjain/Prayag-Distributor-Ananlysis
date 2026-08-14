// Red Alert — root coordinator.
//
// detectAlerts(ctx, fy, primaryCompleteMonths) runs all three category engines,
// applies the 10-guard layer, applies cross-suppression rules (B3→B1/B2/B4/B5
// and C5→team), and returns a CalibrationResult.
//
// No routes. No UI. No persisted tables.

import type { RawAlert, CalibrationResult, AlertCode, SuppressedAlert } from "./types.js";
import type { DetectionContext } from "./types.js";
import { runGuards } from "./guards.js";
import { buildCategoryAAlerts } from "./categoryA.js";
import { buildCategoryBAlerts } from "./categoryB.js";
import { buildCategoryCAlerts } from "./categoryC.js";

// Load config at module initialisation via readFileSync so it works both from
// src/ (tsc typecheck) and from dist/ (esbuild output) without resolveJsonModule
// fighting with rootDir restrictions.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type RaConfig = {
  CATEGORY_A_SALESPERSON: {
    A1_THRESHOLD_PCT: number; A1_SUSTAINED_MONTHS: number; A2_NOTE: string;
    A3_THRESHOLD_PCT: number; A3_SUSTAINED_MONTHS: number;
  };
  CATEGORY_B_DEALERS_RETAILERS: {
    B1_REAL_GROWTH_FLOOR_PCT: number;
    B2_NOMINAL_DECLINE_FLOOR_PCT: number; B2_SUSTAINED_PERIODS: number;
    B4_SEGMENT_FLOOR_RUPEES: number;
    B5_BREADTH_DROP_FLOOR_PCT: number; B5_PRIOR_CODE_FLOOR: number;
  };
  CATEGORY_C_TERRITORY_SEGMENT: {
    C1_CONCENTRATION_SHARE_PCT: number; C1_DECLINE_PCT: number;
    C2_STATE_DECLINE_PCT: number; C2_SUSTAINED_PERIODS: number;
    C3_SEGMENT_UNDER_INDEX_PTS: number;
    C4_GROSS_CONTRIBUTION_DROP_PCT: number;
    C5_SHEET_STALENESS_DAYS: number;
  };
  MATERIALITY_FLOORS: {
    DISTRIBUTOR_RUPEES: number; DIRECT_DEALER_RUPEES: number; RETAILER_RUPEES: number;
  };
  GUARD_THRESHOLDS: { PARTIAL_TENURE_WORKING_DAYS: number };
};

function loadConfig(): RaConfig {
  // Works from both src/ (during dev/typecheck, __dirname = src/lib/redAlert)
  // and dist/ (after build, __dirname = dist).
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../config/red_alert_config.json"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../config/red_alert_config.json"),
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, "utf8")) as RaConfig; } catch { /* try next */ }
  }
  throw new Error("red_alert_config.json not found — searched: " + candidates.join(", "));
}

const cfg = loadConfig();

// "2026-27" → "2025-26"
function prevFy(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10);
  return `${start - 1}-${String(start % 100).padStart(2, "0")}`;
}

// Map current-FY months to prior-FY months: ["Apr-26"] → ["Apr-25"]
function toPriorYearMonths(months: string[]): string[] {
  return months.map((m) => {
    const parts = m.split("-");
    if (parts.length !== 2) return m;
    return `${parts[0]}-${String(parseInt(parts[1]!, 10) - 1).padStart(2, "0")}`;
  });
}

// All 12 month labels for a given FY (Apr-YY … Mar-YY+1)
export function fyMonthLabels(fy: string): string[] {
  const startYear = parseInt(fy.slice(0, 4), 10);
  const names = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  return names.map((name, i) => {
    const year = i < 9 ? startYear : startYear + 1;
    return `${name}-${String(year % 100).padStart(2, "0")}`;
  });
}

// Whether an FY is calendar-closed (its March 31 has passed).
function isFyClosed(fy: string, nowDate: Date): boolean {
  const startYear = parseInt(fy.slice(0, 4), 10);
  const fyEnd = Date.UTC(startYear + 1, 2, 31); // March 31, end year
  return nowDate.getTime() > fyEnd;
}

export type DetectAlertsOptions = {
  /** The FY to analyse, e.g. "2026-27". */
  fy: string;
  /**
   * Primary-data complete months (for B/C category).
   * If omitted and the FY is a closed year, all 12 months are assumed complete.
   * For the open FY, pass frozenMonths.get(fy) converted to an array.
   */
  primaryCompleteMonths?: string[];
  /** Defaults to now. Used by guards (Guard 9) and C5 staleness. */
  nowDate?: Date;
  /**
   * Reference date for C5 sheet-staleness calculation.
   * For a closed FY pass the FY-end date (March 31) so that historical sheets
   * are not spuriously flagged stale relative to today.
   * Defaults to nowDate when omitted.
   */
  c5AsOfDate?: Date;
};

// FY end date: March 31 of the year after start. e.g. "2025-26" → 2026-03-31
function fyEndDate(fy: string): Date {
  const startYear = parseInt(fy.slice(0, 4), 10);
  return new Date(Date.UTC(startYear + 1, 2, 31)); // month 2 = March (0-indexed)
}

export function detectAlerts(
  ctx: DetectionContext,
  opts: DetectAlertsOptions,
): CalibrationResult {
  const { fy } = opts;
  const nowDate = opts.nowDate ?? new Date(Date.now());
  // C5 asOf: use explicit override, or FY-end for closed FYs, or now for the open FY
  const c5AsOfDate = opts.c5AsOfDate
    ?? (isFyClosed(fy, nowDate) ? fyEndDate(fy) : nowDate);
  const priorFy = prevFy(fy);

  // ── Resolve primary-complete months (B/C) ──────────────────────────────────
  let primaryCompleteMonths: string[];
  if (opts.primaryCompleteMonths != null) {
    primaryCompleteMonths = opts.primaryCompleteMonths;
  } else if (isFyClosed(fy, nowDate)) {
    // Closed FY → all 12 months are primary-complete
    primaryCompleteMonths = fyMonthLabels(fy);
  } else {
    // Open FY — use whatever is frozen
    primaryCompleteMonths = [...(ctx.frozenMonths.get(fy) ?? [])].sort();
  }

  const priorMonths = toPriorYearMonths(primaryCompleteMonths);

  // ── Generate raw alert candidates from all three engines ───────────────────
  const aAlerts = buildCategoryAAlerts(ctx, fy, {
    A1_THRESHOLD_PCT: cfg.CATEGORY_A_SALESPERSON.A1_THRESHOLD_PCT,
    A1_SUSTAINED_MONTHS: cfg.CATEGORY_A_SALESPERSON.A1_SUSTAINED_MONTHS,
    A2_NOTE: cfg.CATEGORY_A_SALESPERSON.A2_NOTE,
    A3_THRESHOLD_PCT: cfg.CATEGORY_A_SALESPERSON.A3_THRESHOLD_PCT,
    A3_SUSTAINED_MONTHS: cfg.CATEGORY_A_SALESPERSON.A3_SUSTAINED_MONTHS,
  });

  const bAlerts = buildCategoryBAlerts(ctx, fy, primaryCompleteMonths, {
    B1_REAL_GROWTH_FLOOR_PCT: cfg.CATEGORY_B_DEALERS_RETAILERS.B1_REAL_GROWTH_FLOOR_PCT,
    B2_NOMINAL_DECLINE_FLOOR_PCT: cfg.CATEGORY_B_DEALERS_RETAILERS.B2_NOMINAL_DECLINE_FLOOR_PCT,
    B2_SUSTAINED_PERIODS: cfg.CATEGORY_B_DEALERS_RETAILERS.B2_SUSTAINED_PERIODS,
    B4_SEGMENT_FLOOR_RUPEES: cfg.CATEGORY_B_DEALERS_RETAILERS.B4_SEGMENT_FLOOR_RUPEES,
    B5_BREADTH_DROP_FLOOR_PCT: cfg.CATEGORY_B_DEALERS_RETAILERS.B5_BREADTH_DROP_FLOOR_PCT,
    B5_PRIOR_CODE_FLOOR: cfg.CATEGORY_B_DEALERS_RETAILERS.B5_PRIOR_CODE_FLOOR,
    MATERIALITY_FLOORS: {
      DISTRIBUTOR_RUPEES: cfg.MATERIALITY_FLOORS.DISTRIBUTOR_RUPEES,
      DIRECT_DEALER_RUPEES: cfg.MATERIALITY_FLOORS.DIRECT_DEALER_RUPEES,
      RETAILER_RUPEES: cfg.MATERIALITY_FLOORS.RETAILER_RUPEES,
    },
  });

  const cAlerts = buildCategoryCAlerts(ctx, fy, primaryCompleteMonths, {
    C1_CONCENTRATION_SHARE_PCT: cfg.CATEGORY_C_TERRITORY_SEGMENT.C1_CONCENTRATION_SHARE_PCT,
    C1_DECLINE_PCT: cfg.CATEGORY_C_TERRITORY_SEGMENT.C1_DECLINE_PCT,
    C2_STATE_DECLINE_PCT: cfg.CATEGORY_C_TERRITORY_SEGMENT.C2_STATE_DECLINE_PCT,
    C2_SUSTAINED_PERIODS: cfg.CATEGORY_C_TERRITORY_SEGMENT.C2_SUSTAINED_PERIODS,
    C3_SEGMENT_UNDER_INDEX_PTS: cfg.CATEGORY_C_TERRITORY_SEGMENT.C3_SEGMENT_UNDER_INDEX_PTS,
    C4_GROSS_CONTRIBUTION_DROP_PCT: cfg.CATEGORY_C_TERRITORY_SEGMENT.C4_GROSS_CONTRIBUTION_DROP_PCT,
    C5_SHEET_STALENESS_DAYS: cfg.CATEGORY_C_TERRITORY_SEGMENT.C5_SHEET_STALENESS_DAYS,
  }, c5AsOfDate);

  const allCandidates: RawAlert[] = [...aAlerts, ...bAlerts, ...cAlerts];

  // ── Run guards ──────────────────────────────────────────────────────────────
  const minWorkingDays = cfg.GUARD_THRESHOLDS.PARTIAL_TENURE_WORKING_DAYS;
  const passedAlerts: RawAlert[] = [];
  const guardSuppressed: SuppressedAlert[] = [];
  const suppressedByGuard: Record<number, number> = {};

  for (const alert of allCandidates) {
    const result = runGuards(alert, ctx, fy, priorFy, nowDate, minWorkingDays);
    if (result.pass) {
      passedAlerts.push(alert);
    } else {
      guardSuppressed.push({ alert, guard: result.guard, reason: result.reason });
      suppressedByGuard[result.guard] = (suppressedByGuard[result.guard] ?? 0) + 1;
    }
  }

  // ── Apply cross-suppression ─────────────────────────────────────────────────
  // Rule 1: B3 fired for a customer → suppress B1, B2, B4, B5 for that customer.
  const b3Customers = new Set(
    passedAlerts.filter((a) => a.code === "B3").map((a) => a.entityKey),
  );

  // Rule 2: C5 fired for a member → suppress ALL alerts for that member's team.
  // C5 entity is the member; find their stateHead.
  const c5Teams = new Set<string>();
  for (const alert of passedAlerts) {
    if (alert.code === "C5") {
      const stateHead = ctx.secHeadMonths.find((r) => r.headCanon === alert.entityKey)?.stateHead;
      if (stateHead) c5Teams.add(stateHead);
    }
  }
  // Build a map of headCanon → stateHead for suppression lookup
  const headToStateHead = new Map<string, string>();
  for (const r of ctx.secHeadMonths) {
    if (r.stateHead) headToStateHead.set(r.headCanon, r.stateHead);
  }

  const finalAlerts: RawAlert[] = [];
  const crossSuppressed: SuppressedAlert[] = [];

  for (const alert of passedAlerts) {
    // B3 cross-suppression
    if (
      b3Customers.has(alert.entityKey) &&
      ["B1", "B2", "B4", "B5"].includes(alert.code)
    ) {
      crossSuppressed.push({
        alert,
        guard: 0,
        reason: `B3 (stopped buying entirely) fired for this customer — B${alert.code.slice(1)} superseded`,
        suppressingCode: "B3",
      });
      continue;
    }

    // C5 cross-suppression: if any team member has C5, suppress all A-category alerts for that team
    if (alert.category === "A") {
      const memberStateHead = headToStateHead.get(alert.entityKey);
      if (memberStateHead && c5Teams.has(memberStateHead)) {
        crossSuppressed.push({
          alert,
          guard: 0,
          reason: `C5 (data blackout) fired for a member of team "${memberStateHead}" — performance alert suppressed`,
          suppressingCode: "C5",
        });
        continue;
      }
      // A3 team-level: suppress if the team itself has C5
      if (alert.code === "A3" && c5Teams.has(alert.entityKey)) {
        crossSuppressed.push({
          alert,
          guard: 0,
          reason: `C5 (data blackout) fired in team "${alert.entityKey}" — team performance alert suppressed`,
          suppressingCode: "C5",
        });
        continue;
      }
    }

    finalAlerts.push(alert);
  }

  // ── Build by-code summary ───────────────────────────────────────────────────
  const byCode = {} as Record<AlertCode, { count: number; rupeesAtStake: number }>;
  const allCodes: AlertCode[] = ["A1","A2","A3","B1","B2","B3","B4","B5","C1","C2","C3","C4","C5"];
  for (const code of allCodes) {
    byCode[code] = { count: 0, rupeesAtStake: 0 };
  }
  for (const alert of finalAlerts) {
    byCode[alert.code].count += 1;
    byCode[alert.code].rupeesAtStake += alert.rupeesAtStake;
  }

  const allSuppressed = [...guardSuppressed, ...crossSuppressed];

  return {
    fy,
    currentMonths: primaryCompleteMonths,
    priorMonths,
    alerts: finalAlerts,
    suppressed: allSuppressed,
    suppressedByGuard,
    crossSuppressed: crossSuppressed.length,
    byCode,
  };
}
