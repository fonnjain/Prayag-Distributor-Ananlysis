import { pool } from "@workspace/db";
import { buildSeasonalCurveMath } from "./lib/seasonalCurveMath.js";
import { listSeasonalCurves, previewSeasonalCurve } from "./lib/seasonal.js";

type FrozenFingerprint = {
  fy: string;
  rows: string;
  net: string;
};

type AttributionRow = {
  channel: string;
  territory: "true" | "false" | "null";
  rows: string;
  net: string;
};

async function frozenFingerprint(): Promise<FrozenFingerprint[]> {
  const result = await pool.query<FrozenFingerprint>(
    `SELECT fy, COUNT(*)::text AS rows, COALESCE(SUM(amount::numeric), 0)::text AS net
       FROM sale_line_current
       WHERE fy IN ('2023-24', '2024-25', '2025-26')
      GROUP BY fy
      ORDER BY fy`,
  );
  return result.rows;
}

function rounded(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(4)));
}

async function attributionBreakdown(fy: string): Promise<AttributionRow[]> {
  const result = await pool.query<AttributionRow>(
    `SELECT COALESCE(NULLIF(channel, ''), 'NULL') AS channel,
            CASE
              WHEN is_territory IS TRUE THEN 'true'
              WHEN is_territory IS FALSE THEN 'false'
              ELSE 'null'
            END AS territory,
            COUNT(*)::text AS rows,
            COALESCE(SUM(amount::numeric), 0)::text AS net
       FROM sale_line_current
      WHERE fy = $1
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [fy],
  );
  return result.rows;
}

function curveShareThroughJuly(monthlyPct: number[]): number {
  return monthlyPct.slice(0, 4).reduce((sum, value) => sum + value, 0) / 100;
}

async function main(): Promise<void> {
  const before = await frozenFingerprint();
  const preview = await previewSeasonalCurve();
  const after = await frozenFingerprint();
  const [fy202324Attribution, fy202425Attribution, currentAprJul, curveHistory] = await Promise.all([
    attributionBreakdown("2023-24"),
    attributionBreakdown("2024-25"),
    pool.query<{ actual: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0)::text AS actual
         FROM sale_line_current
        WHERE fy = '2026-27'
          AND month_label IN ('Apr-26', 'May-26', 'Jun-26', 'Jul-26')
          AND is_territory = TRUE`,
    ),
    listSeasonalCurves(),
  ]);
  const simulatedFuture = buildSeasonalCurveMath([
    ...preview.sourceYears,
    {
      fy: "2026-27",
      sourceBasis: "simulated",
      rows: preview.sourceYears.at(-1)?.rows ?? 0,
      // A deliberately different monthly shape verifies that a newly frozen
      // fiscal year becomes one equal vote, never a volume-weighted rewrite.
      monthlyNet: (preview.sourceYears.at(-1)?.monthlyNet ?? []).map(
        (value, idx) => value * (idx < 3 ? 1.18 : 0.94),
      ),
    },
  ]);
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const v1Total = preview.baseline.monthWeights.reduce((sum, value) => sum + value, 0);
  const v2Total = preview.multiYear.monthWeights.reduce((sum, value) => sum + value, 0);
  const aprJulActual = Number(currentAprJul.rows[0]?.actual ?? 0);
  const v1AprJulShare = curveShareThroughJuly(preview.baseline.monthWeights);
  const v2AprJulShare = curveShareThroughJuly(preview.multiYear.monthWeights);
  const fy202425HasClassification = fy202425Attribution.some(
    (row) => row.channel !== "NULL" || row.territory !== "null",
  );
  const activeCurve = curveHistory.find((curve) => curve.is_active);
  const activeSourceFys = activeCurve?.fiscal_years_used ?? [];
  const activeSourceBasis = activeCurve?.source_basis ?? {};
  const persistedActiveMatchesSelection =
    JSON.stringify(activeSourceFys) === JSON.stringify(preview.activation.curve.fiscalYearsUsed) &&
    JSON.stringify(activeSourceBasis) === JSON.stringify(preview.activation.curve.sourceBasis);

  const output = {
    status:
      sourceUnchanged &&
      preview.comparison.maxAbsMonthDelta <= 0.1 &&
      Math.abs(v1Total - 100) < 1e-9 &&
      Math.abs(v2Total - 100) < 1e-9 &&
      persistedActiveMatchesSelection &&
      simulatedFuture.fiscalYearsUsed.length === preview.sourceYears.length + 1
        ? "PASS"
        : "FAIL",
    v1_fy2025_26: {
      fiscalYearsUsed: preview.baseline.fiscalYearsUsed,
      monthlyPct: rounded(preview.baseline.monthWeights),
      quarterlyPct: rounded(preview.baseline.quarterWeights),
      q1DeltaPp: Number(preview.comparison.q1Delta.toFixed(4)),
      q4DeltaPp: Number(preview.comparison.q4Delta.toFixed(4)),
      maxAbsMonthDeltaPp: Number(preview.comparison.maxAbsMonthDelta.toFixed(4)),
      withinRoundingTolerance: preview.comparison.maxAbsMonthDelta <= 0.1,
      totalPct: v1Total,
      sourceBasis: preview.baseline.sourceBasis,
    },
    v2_equal_weighted_frozen_years: {
      fiscalYearsUsed: preview.multiYear.fiscalYearsUsed,
      eligibleForActivation: preview.activation.mode === "equal_weighted_multi_year",
      blockedFiscalYears: preview.activation.blockedFiscalYears,
      monthlyPct: rounded(preview.multiYear.monthWeights),
      quarterlyPct: rounded(preview.multiYear.quarterWeights),
      monthShareStddevPp: rounded(preview.multiYear.monthShareStddev),
      monthRangesPct: preview.multiYear.monthRanges.map((range) => rounded(range)),
      sourceRows: preview.multiYear.sourceRows,
      sourceNet: preview.multiYear.sourceNet,
      sourceBasis: preview.multiYear.sourceBasis,
      totalPct: v2Total,
    },
    sourceYearEvidence: preview.sourceYears.map((source) => ({
      fy: source.fy,
      sourceBasis: source.sourceBasis,
      rows: source.rows,
      net: source.monthlyNet.reduce((sum, value) => sum + value, 0),
      monthlyPct: rounded(preview.multiYear.sourceMonthlyShares[source.fy] ?? []),
    })),
    attributionAudit: {
      fy2023_24: fy202324Attribution,
      fy2024_25: {
        rowsByChannelAndTerritory: fy202425Attribution,
        institutionalShareEstimatePct: fy202425HasClassification ? "derive from classified rows" : null,
        note: fy202425HasClassification
          ? "Classification exists and must be reconciled before a new multi-year curve is activated."
          : "Not estimable from this frozen register: every FY2024-25 row remains unclassified. Do not substitute the FY2025-26 institutional share or assume unknown rows are retail.",
      },
    },
    sameAprJulActualsProjection: {
      fy: "2026-27",
      months: ["Apr-26", "May-26", "Jun-26", "Jul-26"],
      territoryActual: aprJulActual,
      v1: {
        sharePct: Number((v1AprJulShare * 100).toFixed(4)),
        projectedYearEnd: v1AprJulShare > 0 ? Number((aprJulActual / v1AprJulShare).toFixed(2)) : null,
      },
      candidateV2: {
        eligibleForActivation: preview.activation.mode === "equal_weighted_multi_year",
        sharePct: Number((v2AprJulShare * 100).toFixed(4)),
        projectedYearEnd: v2AprJulShare > 0 ? Number((aprJulActual / v2AprJulShare).toFixed(2)) : null,
      },
    },
    persistedActivation: {
      activeVersion: activeCurve ? Number(activeCurve.id) : null,
      activeFiscalYears: activeSourceFys,
      activeSourceBasis,
      matchesSafeSelection: persistedActiveMatchesSelection,
      retainedHistoricalVersions: curveHistory
        .filter((curve) => !curve.is_active)
        .map((curve) => ({
          version: Number(curve.id),
          fiscalYearsUsed: curve.fiscal_years_used,
          sourceBasis: curve.source_basis,
        })),
    },
    frozenSourcePreserved: {
      unchanged: sourceUnchanged,
      fingerprint: after,
    },
    simulatedNextFrozenYear: {
      fiscalYearsUsed: simulatedFuture.fiscalYearsUsed,
      totalPct: simulatedFuture.monthWeights.reduce((sum, value) => sum + value, 0),
      inclusionChangedCurve:
        JSON.stringify(rounded(simulatedFuture.monthWeights)) !==
        JSON.stringify(rounded(preview.multiYear.monthWeights)),
    },
  };

  console.log(JSON.stringify(output, null, 2));
  if (output.status !== "PASS") process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });