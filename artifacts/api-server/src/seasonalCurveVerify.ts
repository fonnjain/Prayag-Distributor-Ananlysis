import { pool } from "@workspace/db";
import { buildSeasonalCurveMath } from "./lib/seasonalCurveMath.js";
import { previewSeasonalCurve } from "./lib/seasonal.js";

type FrozenFingerprint = {
  fy: string;
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

async function main(): Promise<void> {
  const before = await frozenFingerprint();
  const preview = await previewSeasonalCurve();
  const after = await frozenFingerprint();
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

  const output = {
    status:
      sourceUnchanged &&
      preview.comparison.maxAbsMonthDelta <= 0.1 &&
      Math.abs(v1Total - 100) < 1e-9 &&
      Math.abs(v2Total - 100) < 1e-9 &&
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
      monthlyPct: rounded(preview.multiYear.monthWeights),
      quarterlyPct: rounded(preview.multiYear.quarterWeights),
      monthShareStddevPp: rounded(preview.multiYear.monthShareStddev),
      monthRangesPct: preview.multiYear.monthRanges.map((range) => rounded(range)),
      sourceRows: preview.multiYear.sourceRows,
      sourceNet: preview.multiYear.sourceNet,
      sourceBasis: preview.multiYear.sourceBasis,
      totalPct: v2Total,
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