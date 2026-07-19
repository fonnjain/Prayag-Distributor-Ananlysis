// State Head Dashboard → secondary_head_month persistence.
// Wraps the existing stateDashboard.ts loader and converts its SecDashboard
// result into SecHeadMonthRow objects ready for DB upsert.
//
// This is the ONLY path that should write secondary_head_month rows for
// FY2025-26 and FY2026-27. Earlier FYs (FY2021-22 → FY2024-25) are loaded
// from xlsx registers via loader.ts.
import { logger } from "../logger.js";
import { loadStateDashboard } from "../mgmt/stateDashboard.js";
import { computeAchievement, isAnomalous, isMonthClosed } from "./rules.js";
import type { SecHeadMonthRow, SecDryRunSummary, AnomalySummary } from "./types.js";
import { runSecDashboardValidators } from "./validate.js";
import { upsertSecHeadMonths, recordSecIngestRun, buildSecIngestRun } from "./ingest.js";
import type { InsertSecHeadMonth } from "@workspace/db";
import sheetsConfig from "../../../config/secondary_sheets.json";

const MONTH_LABELS_SHORT = [
  "Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar",
];

// ── Conversion helper ─────────────────────────────────────────────────────────

// Convert a stateDashboard.ts SecDashboard into SecHeadMonthRow objects,
// applying calculation rules:
//   1. achievement_recomputed  (received / plan, never ordered / plan)
//   3. anomaly_flag            (salesAmount > orderedAmount × 1.5)
//   2. ytd_closed_months_only  (notYetRecorded flag for open months)
function dashboardToHeadMonthRows(
  fy: string,
  sheetId: string,
  // Imported type from stateDashboard.ts — use structural typing to avoid
  // cross-package import.
  members: Array<{
    name: string;
    normKey: string;
    stateHead: string;
    months: Array<{
      planAmount: number | null;
      orderedAmount: number | null;
      salesAmount: number | null;
      notYetRecorded: boolean;
    }>;
  }>,
): SecHeadMonthRow[] {
  const rows: SecHeadMonthRow[] = [];
  const now = Date.now();

  for (const member of members) {
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const m = member.months[monthIdx];
      if (!m) continue;

      const closed = isMonthClosed(monthIdx, fy, now);
      const notYetRecorded = !closed && m.notYetRecorded;

      // Apply rule 1: recompute achievement
      const achievementPct = computeAchievement(m.salesAmount, m.planAmount);

      // Apply rule 3: anomaly flag
      const anomaly = isAnomalous(m.salesAmount, m.orderedAmount);

      // Build month label: e.g. "Apr-25" for fy "2025-26" monthIdx 0
      const startYear = Number(fy.slice(0, 4));
      const calYear = monthIdx <= 8 ? startYear : startYear + 1;
      const monthLabel = `${MONTH_LABELS_SHORT[monthIdx]}-${String(calYear % 100).padStart(2, "0")}`;

      rows.push({
        fy,
        headRaw: member.name,
        headCanon: member.normKey,
        stateHead: member.stateHead || null,
        monthLabel,
        monthIdx,
        planAmount: m.planAmount,
        orderedAmount: m.orderedAmount,
        receivedAmount: m.salesAmount,
        achievementPct,
        isAnomaly: anomaly,
        notYetRecorded,
        sourceSheetId: sheetId,
      });
    }
  }
  return rows;
}

// ── Public loader ─────────────────────────────────────────────────────────────

export async function loadAndPersistStateDashboard(
  fy: string,
  dryRun = false,
): Promise<SecDryRunSummary> {
  const sheetCfg = (
    sheetsConfig as {
      state_head_dashboards: Record<
        string,
        { sheet_id: string; tab_prefix: string }
      >;
    }
  ).state_head_dashboards[fy];

  if (!sheetCfg) {
    return {
      fy,
      source: "state_head_dashboard",
      rowsRead: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      assertions: [
        {
          name: "sheet_configured",
          passed: false,
          detail: `no state_head_dashboard config for FY ${fy} in secondary_sheets.json`,
        },
      ],
      unmapped: { unmapped_heads: {}, unmapped_states: {}, unmapped_brands: {} },
      anomalies: [],
      errors: [`FY ${fy} is not configured in secondary_sheets.json`],
    };
  }

  logger.info({ fy, sheetId: sheetCfg.sheet_id, dryRun }, "sec: loading state head dashboard");

  const dashboard = await loadStateDashboard(fy);
  if (!dashboard) {
    return {
      fy,
      source: "state_head_dashboard",
      rowsRead: 0,
      rowsToInsert: 0,
      existingInDb: 0,
      assertions: [
        {
          name: "sheet_reachable",
          passed: false,
          detail: `could not load state head dashboard for FY ${fy} (sheet unreachable or tab not found)`,
        },
      ],
      unmapped: { unmapped_heads: {}, unmapped_states: {}, unmapped_brands: {} },
      anomalies: [],
      errors: [`state head dashboard for FY ${fy} returned null`],
    };
  }

  const headMonthRows = dashboardToHeadMonthRows(
    fy,
    sheetCfg.sheet_id,
    dashboard.members,
  );

  // Run validators
  const assertions = runSecDashboardValidators(headMonthRows, fy);
  const anyFailed = assertions.some((a) => !a.passed);
  const status = dryRun ? "dry_run" : anyFailed ? "fail" : "ok";

  // Collect anomalies for summary
  const anomalies: AnomalySummary[] = headMonthRows
    .filter((r) => r.isAnomaly)
    .map((r) => ({
      head: r.headCanon,
      monthLabel: r.monthLabel,
      salesAmount: r.receivedAmount ?? 0,
      orderedAmount: r.orderedAmount ?? 0,
      ratio:
        (r.orderedAmount ?? 0) > 0
          ? (r.receivedAmount ?? 0) / (r.orderedAmount ?? 1)
          : 0,
    }));

  let rowsUpserted = 0;
  if (!dryRun && !anyFailed) {
    const insertRows: InsertSecHeadMonth[] = headMonthRows.map((r) => ({
      fy: r.fy,
      headRaw: r.headRaw,
      headCanon: r.headCanon,
      stateHead: r.stateHead,
      monthLabel: r.monthLabel,
      monthIdx: r.monthIdx,
      planAmount: r.planAmount != null ? String(r.planAmount) : null,
      orderedAmount: r.orderedAmount != null ? String(r.orderedAmount) : null,
      receivedAmount: r.receivedAmount != null ? String(r.receivedAmount) : null,
      achievementPct: r.achievementPct != null ? String(r.achievementPct) : null,
      isAnomaly: r.isAnomaly,
      notYetRecorded: r.notYetRecorded,
      sourceSheetId: r.sourceSheetId,
    }));
    const result = await upsertSecHeadMonths(insertRows);
    rowsUpserted = result.upserted;
  }

  await recordSecIngestRun(
    buildSecIngestRun({
      source: "state_head_dashboard",
      fy,
      rowsRead: dashboard.rowsRead,
      rowsInserted: rowsUpserted,
      rowsSkipped: headMonthRows.length - rowsUpserted,
      unmapped: {},
      assertions,
      status,
    }),
    dryRun,
  );

  logger.info(
    { fy, rowsRead: dashboard.rowsRead, headMonthRows: headMonthRows.length, dryRun, status },
    "sec: state head dashboard loaded",
  );

  return {
    fy,
    source: "state_head_dashboard",
    rowsRead: dashboard.rowsRead,
    rowsToInsert: headMonthRows.length,
    existingInDb: 0,
    assertions,
    unmapped: { unmapped_heads: {}, unmapped_states: {}, unmapped_brands: {} },
    anomalies,
    errors: [],
  };
}
