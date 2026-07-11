// FY-level reconciliation + the verified-gate for the SAP primary-sales source.
//
// The gate that flips FY2026-27 analytics onto SAP requires all three to hold:
//   1. the benchmark months (Apr–Jul) reconcile to ~₹73 Cr within tolerance,
//   2. customer match by revenue clears the target (>95%),
//   3. the cross-foot balances (Σ group = Σ head = Σ state = grand, within ₹1).
import { getUploadSummaries } from "./store.js";
import { sapConfig, SAP_FY } from "./config.js";
import type { MonthSummary } from "./derive.js";

export type SapVerifyReport = {
  fy: string;
  uploadedMonths: string[];
  rowsRead: number;
  grandTotal: number;
  match: {
    rowsPct: number;
    revenuePct: number;
    matchedRows: number;
    totalRows: number;
    matchedRevenue: number;
    totalRevenue: number;
    targetPct: number;
  };
  benchmark: {
    months: string[];
    presentMonths: string[];
    actual: number;
    expected: number;
    tolerancePct: number;
    deltaPct: number | null;
    ok: boolean;
  };
  crossFoot: {
    grand: number;
    byGroup: number;
    byHead: number;
    byState: number;
    maxDeltaRupees: number;
    ok: boolean;
  };
  unmatchedCustomers: Array<{ name: string; amount: number }>;
  unmappedGroups: Array<{ key: string; amount: number }>;
  verified: boolean;
};

function combineByKey(
  summaries: MonthSummary[],
  pick: (s: MonthSummary) => Array<{ key: string; amount: number }>,
): number {
  let total = 0;
  for (const s of summaries) for (const e of pick(s)) total += e.amount;
  return total;
}

export function buildReportFromSummaries(
  fy: string,
  summaries: MonthSummary[],
): SapVerifyReport {
  const uploadedMonths = summaries.map((s) => s.monthLabel);
  const rowsRead = summaries.reduce((n, s) => n + s.rowsRead, 0);
  const grandTotal = summaries.reduce((n, s) => n + s.amount, 0);

  const totalRows = summaries.reduce((n, s) => n + s.rowsRead, 0);
  const matchedRows = summaries.reduce((n, s) => n + s.matchedRows, 0);
  const totalRevenue = grandTotal;
  const matchedRevenue = summaries.reduce((n, s) => n + s.matchedRevenue, 0);
  const rowsPct = totalRows === 0 ? 0 : Math.round((matchedRows / totalRows) * 1000) / 10;
  const revenuePct =
    totalRevenue === 0 ? 0 : Math.round((matchedRevenue / totalRevenue) * 1000) / 10;

  const byGroupTotal = combineByKey(summaries, (s) => s.byGroup);
  const byStateTotal = combineByKey(summaries, (s) => s.byState);
  const byHeadTotal = summaries.reduce(
    (n, s) => n + s.byHead.reduce((m, h) => m + h.amount, 0),
    0,
  );
  const maxDeltaRupees = Math.max(
    Math.abs(grandTotal - byGroupTotal),
    Math.abs(grandTotal - byHeadTotal),
    Math.abs(grandTotal - byStateTotal),
  );
  const crossFootOk = maxDeltaRupees <= sapConfig.crossFootToleranceRupees;

  const benchMonths = sapConfig.benchmark.months;
  const present = summaries.filter((s) => benchMonths.includes(s.monthLabel));
  const presentMonths = present.map((s) => s.monthLabel);
  const benchActual = present.reduce((n, s) => n + s.amount, 0);
  const benchExpected = sapConfig.benchmark.amount;
  const allBenchPresent = benchMonths.every((m) => presentMonths.includes(m));
  const deltaPct =
    benchExpected === 0
      ? null
      : Math.round(((benchActual - benchExpected) / benchExpected) * 1000) / 10;
  const benchOk =
    allBenchPresent &&
    deltaPct != null &&
    Math.abs(deltaPct) <= sapConfig.benchmark.tolerancePct;

  // Merge unmatched customers and unmapped groups across months.
  const unmatched = new Map<string, number>();
  const unmapped = new Map<string, number>();
  for (const s of summaries) {
    for (const u of s.unmatchedCustomers) {
      unmatched.set(u.name, (unmatched.get(u.name) ?? 0) + u.amount);
    }
    for (const g of s.unmappedGroups) {
      unmapped.set(g.key, (unmapped.get(g.key) ?? 0) + g.amount);
    }
  }

  const verified =
    summaries.length > 0 &&
    benchOk &&
    revenuePct > sapConfig.matchTargetPct &&
    crossFootOk;

  return {
    fy,
    uploadedMonths,
    rowsRead,
    grandTotal,
    match: {
      rowsPct,
      revenuePct,
      matchedRows,
      totalRows,
      matchedRevenue,
      totalRevenue,
      targetPct: sapConfig.matchTargetPct,
    },
    benchmark: {
      months: benchMonths,
      presentMonths,
      actual: benchActual,
      expected: benchExpected,
      tolerancePct: sapConfig.benchmark.tolerancePct,
      deltaPct,
      ok: benchOk,
    },
    crossFoot: {
      grand: grandTotal,
      byGroup: byGroupTotal,
      byHead: byHeadTotal,
      byState: byStateTotal,
      maxDeltaRupees,
      ok: crossFootOk,
    },
    unmatchedCustomers: [...unmatched.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 100),
    unmappedGroups: [...unmapped.entries()]
      .map(([key, amount]) => ({ key, amount }))
      .sort((a, b) => b.amount - a.amount),
    verified,
  };
}

export async function buildSapVerifyReport(fy: string): Promise<SapVerifyReport> {
  const summaries = await getUploadSummaries(fy);
  return buildReportFromSummaries(fy, summaries);
}

// Cheap gate used by the analytics cutover. Cached briefly so a burst of
// analytics requests does not re-read every upload row.
let verifiedCache: { fy: string; verified: boolean; atMs: number } | null = null;
const VERIFIED_TTL_MS = 30_000;

export async function isSapVerified(fy: string): Promise<boolean> {
  if (fy !== SAP_FY) return false;
  if (
    verifiedCache &&
    verifiedCache.fy === fy &&
    Date.now() - verifiedCache.atMs < VERIFIED_TTL_MS
  ) {
    return verifiedCache.verified;
  }
  const report = await buildSapVerifyReport(fy);
  verifiedCache = { fy, verified: report.verified, atMs: Date.now() };
  return report.verified;
}

export function clearVerifiedCache(): void {
  verifiedCache = null;
}
