// Red Alert — Category A (salesperson) engine.
// A1: cumulative OB vs pro-rated target below threshold, 2 consecutive months.
// A2: zero OB in a complete recorded month with a target.
// A3: team-weighted achievement below threshold, 2 consecutive months.

import type { RawAlert, SecHeadMonthRow, DetectionContext } from "./types.js";
import { resolveUniquePersonIdentityKey } from "../employeeCodeIdentity.js";

type AConfig = {
  A1_THRESHOLD_PCT: number;
  A1_SUSTAINED_MONTHS: number;
  A2_NOTE: string;
  A3_THRESHOLD_PCT: number;
  A3_SUSTAINED_MONTHS: number;
};

// All complete (not_yet_recorded=false, not anomaly) months for a member, sorted by monthIdx.
function completeMonthsFor(rows: SecHeadMonthRow[], headCanon: string, fy: string): SecHeadMonthRow[] {
  return rows
    .filter((r) => r.headCanon === headCanon && r.fy === fy && !r.notYetRecorded && !r.isAnomaly)
    .sort((a, b) => a.monthIdx - b.monthIdx);
}

// Returns month labels as the "current" and "prior" windows for an A-category alert.
// For A-category, the prior window is the same calendar months in the prior FY.
function monthLabels(months: SecHeadMonthRow[]): string[] {
  return months.map((m) => m.monthLabel);
}
function priorYearLabels(months: SecHeadMonthRow[]): string[] {
  return months.map((m) => {
    const parts = m.monthLabel.split("-");
    if (parts.length !== 2) return m.monthLabel;
    const yr = parseInt(parts[1]!, 10);
    return `${parts[0]}-${String(yr - 1).padStart(2, "0")}`;
  });
}

export function buildCategoryAAlerts(
  ctx: DetectionContext,
  currentFy: string,
  cfg: AConfig,
): RawAlert[] {
  const alerts: RawAlert[] = [];
  const allRows = ctx.secHeadMonths;
  const fyCurRows = allRows.filter((r) => r.fy === currentFy);

  // All distinct members with data in this FY
  const members = [...new Set(fyCurRows.map((r) => r.headCanon))];

  // ── A1: cumulative OB / pro-rated target below threshold (sustained) ──────
  for (const headCanon of members) {
    const months = completeMonthsFor(allRows, headCanon, currentFy);
    if (months.length < cfg.A1_SUSTAINED_MONTHS) continue;

    // Build cumulative OB and target at each month
    let cumOb = 0, cumTarget = 0;
    const snapshots: Array<{ monthLabel: string; achPct: number; cumOb: number; cumTarget: number }> = [];

    for (const m of months) {
      cumOb += m.orderedAmount ?? 0;
      cumTarget += m.planAmount ?? 0;
      if (cumTarget > 0) {
        snapshots.push({
          monthLabel: m.monthLabel,
          achPct: (cumOb / cumTarget) * 100,
          cumOb,
          cumTarget,
        });
      }
    }

    // Check for 2 consecutive complete months below threshold
    const threshold = cfg.A1_THRESHOLD_PCT;
    for (let i = cfg.A1_SUSTAINED_MONTHS - 1; i < snapshots.length; i++) {
      const window = snapshots.slice(i - cfg.A1_SUSTAINED_MONTHS + 1, i + 1);
      if (window.every((s) => s.achPct < threshold)) {
        const last = window[window.length - 1]!;
        const first = window[0]!;
        // Find canonical name for this member
        const person = resolveUniquePersonIdentityKey(
          headCanon,
          ctx.persons,
          (candidate) => candidate.normKey,
        );
        const name = person?.canonicalName ?? headCanon;
        const stateHead = ctx.secHeadMonths.find((r) => r.headCanon === headCanon)?.stateHead ?? null;

        const alertMonths = months.slice(0, i + 1);
        alerts.push({
          code: "A1",
          category: "A",
          entity: name,
          entityKey: headCanon,
          entityType: "member",
          currentMonths: monthLabels(alertMonths),
          priorMonths: priorYearLabels(alertMonths),
          numbers: {
            achievementPct: last.achPct,
            priorAchievementPct: first.achPct,
            cumulativeOb: last.cumOb,
            cumulativeTarget: last.cumTarget,
          },
          rupeesAtStake: last.cumTarget - last.cumOb,
          extraForReport: {
            stateHead: stateHead ?? "—",
            sustainedFromMonth: first.monthLabel,
            sustainedToMonth: last.monthLabel,
          },
        });
        break; // one alert per member per FY (the first sustained window found)
      }
    }
  }

  // ── A2: zero OB in a complete month with a target ────────────────────────
  for (const headCanon of members) {
    const months = completeMonthsFor(allRows, headCanon, currentFy);
    for (const m of months) {
      if ((m.orderedAmount ?? 0) === 0 && (m.planAmount ?? 0) > 0) {
        const person = resolveUniquePersonIdentityKey(
          headCanon,
          ctx.persons,
          (candidate) => candidate.normKey,
        );
        const name = person?.canonicalName ?? headCanon;
        const stateHead = ctx.secHeadMonths.find((r) => r.headCanon === headCanon)?.stateHead ?? null;
        const allAlertMonths = [m];
        alerts.push({
          code: "A2",
          category: "A",
          entity: name,
          entityKey: headCanon,
          entityType: "member",
          currentMonths: monthLabels(allAlertMonths),
          priorMonths: priorYearLabels(allAlertMonths),
          numbers: {
            orderedAmount: 0,
            planAmount: m.planAmount ?? 0,
          },
          rupeesAtStake: m.planAmount ?? 0,
          extraForReport: { stateHead: stateHead ?? "—", zeroMonth: m.monthLabel },
        });
        break; // one A2 per member (first zero month)
      }
    }
  }

  // ── A3: team achievement below threshold (sustained) ─────────────────────
  // Group members by state head
  const stateHeads = [...new Set(fyCurRows.map((r) => r.stateHead).filter((s): s is string => s != null))];

  for (const stateHead of stateHeads) {
    const teamMembers = [...new Set(
      allRows.filter((r) => r.stateHead === stateHead && r.fy === currentFy).map((r) => r.headCanon),
    )];
    if (teamMembers.length === 0) continue;

    // Get all distinct complete months across the team (union of individual complete months)
    const allTeamMonths = new Map<string, { idx: number; ob: number; target: number; memberCount: number }>();

    for (const headCanon of teamMembers) {
      const months = completeMonthsFor(allRows, headCanon, currentFy);
      for (const m of months) {
        const prev = allTeamMonths.get(m.monthLabel) ?? { idx: m.monthIdx, ob: 0, target: 0, memberCount: 0 };
        prev.ob += m.orderedAmount ?? 0;
        prev.target += m.planAmount ?? 0;
        prev.memberCount += 1;
        allTeamMonths.set(m.monthLabel, prev);
      }
    }

    const sortedTeamMonths = [...allTeamMonths.entries()].sort((a, b) => a[1].idx - b[1].idx);
    if (sortedTeamMonths.length < cfg.A3_SUSTAINED_MONTHS) continue;

    let cumTeamOb = 0, cumTeamTarget = 0;
    const teamSnapshots: Array<{ monthLabel: string; achPct: number }> = [];
    for (const [label, data] of sortedTeamMonths) {
      cumTeamOb += data.ob;
      cumTeamTarget += data.target;
      if (cumTeamTarget > 0) {
        teamSnapshots.push({ monthLabel: label, achPct: (cumTeamOb / cumTeamTarget) * 100 });
      }
    }

    const teamThreshold = cfg.A3_THRESHOLD_PCT;
    for (let i = cfg.A3_SUSTAINED_MONTHS - 1; i < teamSnapshots.length; i++) {
      const window = teamSnapshots.slice(i - cfg.A3_SUSTAINED_MONTHS + 1, i + 1);
      if (window.every((s) => s.achPct < teamThreshold)) {
        const last = window[window.length - 1]!;
        const first = window[0]!;

        // LfL: exclude members who are new (joined during the period) or absent in prior
        // Simple proxy: members with < 2 complete months in current FY
        const lflMembers = teamMembers.filter((h) => completeMonthsFor(allRows, h, currentFy).length >= 2);
        let lflOb = 0, lflTarget = 0;
        for (const h of lflMembers) {
          const mons = completeMonthsFor(allRows, h, currentFy);
          lflOb += mons.reduce((s, m) => s + (m.orderedAmount ?? 0), 0);
          lflTarget += mons.reduce((s, m) => s + (m.planAmount ?? 0), 0);
        }
        const lflAchPct = lflTarget > 0 ? (lflOb / lflTarget) * 100 : null;

        const alertMonths = sortedTeamMonths.slice(0, i + 1).map(([l]) => l);
        alerts.push({
          code: "A3",
          category: "A",
          entity: stateHead,
          entityKey: stateHead,
          entityType: "team",
          currentMonths: alertMonths,
          priorMonths: alertMonths.map((l) => {
            const p = l.split("-");
            return p.length === 2 ? `${p[0]}-${String(parseInt(p[1]!, 10) - 1).padStart(2, "0")}` : l;
          }),
          numbers: {
            achievementPct: last.achPct,
            priorAchievementPct: first.achPct,
            lflAchievementPct: lflAchPct ?? undefined,
            teamMemberCount: teamMembers.length,
            lflMemberCount: lflMembers.length,
          },
          rupeesAtStake: cumTeamTarget - cumTeamOb,
          extraForReport: {
            sustainedFromMonth: first.monthLabel,
            sustainedToMonth: last.monthLabel,
          },
        });
        break;
      }
    }
  }

  return alerts;
}
