// Per-state-head GP Margin summary for the management workbook.
//
// Queries sale_line joined with cost_master for a given FY; groups by
// headCanon + groupCanon to produce per-head margin data.
//
// Returns an empty Map when cost_master is empty (no fallback allowed —
// Purchase Price must never be used as cost).

import { db, saleLines, costMaster } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export type HeadGroupMargin = {
  group: string;
  revenue: number;
  coveredRevenue: number;
  cost: number;
  gpAmount: number;
  gpPct: number | null;
};

export type HeadMarginSummary = {
  headCanon: string;
  totalRevenue: number;
  coveredRevenue: number;
  totalCost: number;
  gpAmount: number;
  gpPct: number | null;
  byGroup: HeadGroupMargin[];
};

// Returns Map<headCanon, HeadMarginSummary>.  Map is empty when cost_master
// is not populated.
export async function loadMgmtMargins(
  fy: string,
): Promise<Map<string, HeadMarginSummary>> {
  // Quick guard: if cost_master is empty, return immediately.
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(costMaster);
  if (!countRow || countRow.n === 0) return new Map();

  const rows = await db
    .select({
      headCanon: saleLines.headCanon,
      groupCanon: saleLines.groupCanon,
      revenue: sql<number>`coalesce(sum(${saleLines.amount}::float8), 0)`,
      cost: sql<number>`coalesce(sum(
        case when ${costMaster.code} is not null
          then ${saleLines.qty}::float8 * ${costMaster.fgCost}::float8
          else 0
        end
      ), 0)`,
      coveredRevenue: sql<number>`coalesce(sum(
        case when ${costMaster.code} is not null
          then ${saleLines.amount}::float8
          else 0
        end
      ), 0)`,
    })
    .from(saleLines)
    .leftJoin(costMaster, eq(saleLines.code, costMaster.code))
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(saleLines.headCanon, saleLines.groupCanon);

  const byHead = new Map<string, HeadMarginSummary>();

  for (const r of rows) {
    const headKey = r.headCanon ?? "";
    if (!headKey) continue;

    const gpAmt = r.coveredRevenue - r.cost;
    const gpPct = r.coveredRevenue > 0 ? gpAmt / r.coveredRevenue : null;

    let summary = byHead.get(headKey);
    if (!summary) {
      summary = {
        headCanon: headKey,
        totalRevenue: 0,
        coveredRevenue: 0,
        totalCost: 0,
        gpAmount: 0,
        gpPct: null,
        byGroup: [],
      };
      byHead.set(headKey, summary);
    }

    summary.totalRevenue += r.revenue;
    summary.coveredRevenue += r.coveredRevenue;
    summary.totalCost += r.cost;
    summary.gpAmount += gpAmt;

    if (r.revenue > 0 || r.cost > 0) {
      summary.byGroup.push({
        group: r.groupCanon ?? "Unknown",
        revenue: r.revenue,
        coveredRevenue: r.coveredRevenue,
        cost: r.cost,
        gpAmount: gpAmt,
        gpPct,
      });
    }
  }

  for (const [, s] of byHead) {
    s.gpPct = s.coveredRevenue > 0 ? s.gpAmount / s.coveredRevenue : null;
    s.byGroup.sort((a, b) => b.revenue - a.revenue);
  }

  return byHead;
}
