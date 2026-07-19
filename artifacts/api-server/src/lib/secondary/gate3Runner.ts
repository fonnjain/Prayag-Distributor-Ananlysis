// Gate 3 runner: queries the live DB, assembles inputs for the seven pure check
// functions in gate3.ts, and returns a Gate3Report.
// This is the only file in the secondary lib that performs DB reads.

import { sql } from "drizzle-orm";
import { db, secondaryRegisterLines, secondaryHeadMonths } from "@workspace/db";
import {
  checkR1AchievementRecomputed,
  checkR2YtdClosedMonthsOnly,
  checkR3AnomalyFlagConsistent,
  checkR4TerritorySplitPopulated,
  checkR5CrossFootByHead,
  checkR6CompleteMonthsYoY,
  checkR7NoDoubleCount,
  buildGate3Report,
} from "./gate3.js";
import type {
  Gate3Report,
  HeadMonthRow,
  FyTerritoryStats,
  FyHeadGross,
  FyMonthData,
  SourceCount,
} from "./gate3.js";

const MONTH_LABELS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];

function monthLabelToIdx(label: string): number {
  const abbr = label.slice(0, 3);
  return MONTH_LABELS.indexOf(abbr);
}

// ── R1 / R2 / R3 ─────────────────────────────────────────────────────────────

async function fetchHeadMonthRows(): Promise<HeadMonthRow[]> {
  const rows = await db
    .select({
      fy: secondaryHeadMonths.fy,
      headCanon: secondaryHeadMonths.headCanon,
      monthLabel: secondaryHeadMonths.monthLabel,
      monthIdx: secondaryHeadMonths.monthIdx,
      planAmount: secondaryHeadMonths.planAmount,
      orderedAmount: secondaryHeadMonths.orderedAmount,
      receivedAmount: secondaryHeadMonths.receivedAmount,
      achievementPct: secondaryHeadMonths.achievementPct,
      isAnomaly: secondaryHeadMonths.isAnomaly,
      notYetRecorded: secondaryHeadMonths.notYetRecorded,
    })
    .from(secondaryHeadMonths);

  return rows.map((r) => ({
    fy: r.fy,
    headCanon: r.headCanon,
    monthLabel: r.monthLabel,
    monthIdx: r.monthIdx,
    planAmount: r.planAmount != null ? Number(r.planAmount) : null,
    orderedAmount: r.orderedAmount != null ? Number(r.orderedAmount) : null,
    receivedAmount: r.receivedAmount != null ? Number(r.receivedAmount) : null,
    storedAchievementPct: r.achievementPct != null ? Number(r.achievementPct) : null,
    isAnomaly: r.isAnomaly,
    notYetRecorded: r.notYetRecorded,
  }));
}

// ── R4 ───────────────────────────────────────────────────────────────────────

async function fetchTerritoryStats(): Promise<FyTerritoryStats[]> {
  const rows = await db.execute<{
    fy: string;
    null_count: string;
    territory_count: string;
    non_territory_count: string;
  }>(sql`
    SELECT
      fy,
      COUNT(*) FILTER (WHERE is_territory IS NULL)    AS null_count,
      COUNT(*) FILTER (WHERE is_territory = true)     AS territory_count,
      COUNT(*) FILTER (WHERE is_territory = false)    AS non_territory_count
    FROM secondary_register_line
    GROUP BY fy
    ORDER BY fy
  `);
  return rows.rows.map((r) => ({
    fy: r.fy,
    nullCount: Number(r.null_count),
    territoryCount: Number(r.territory_count),
    nonTerritoryCount: Number(r.non_territory_count),
  }));
}

// ── R5 ───────────────────────────────────────────────────────────────────────

async function fetchHeadGross(): Promise<FyHeadGross[]> {
  // Grand total per FY
  const grandRows = await db.execute<{ fy: string; grand: string }>(sql`
    SELECT fy, SUM(gross_amount) AS grand
    FROM secondary_register_line
    GROUP BY fy
    ORDER BY fy
  `);
  const grands = new Map(grandRows.rows.map((r) => [r.fy, Number(r.grand)]));

  // Per-head totals: rows with head_canon go into their canon bucket;
  // rows with no head_canon but a non-blank head_raw go into "(unmapped)";
  // rows with both null go into "(blank)".
  const headRows = await db.execute<{
    fy: string;
    head_bucket: string;
    gross: string;
  }>(sql`
    SELECT
      fy,
      COALESCE(
        head_canon,
        CASE WHEN head_raw IS NOT NULL AND TRIM(head_raw) <> '' THEN '(unmapped)' ELSE '(blank)' END
      ) AS head_bucket,
      SUM(gross_amount) AS gross
    FROM secondary_register_line
    GROUP BY fy, head_bucket
    ORDER BY fy, head_bucket
  `);

  const byFy = new Map<string, Array<{ headBucket: string; gross: number }>>();
  for (const r of headRows.rows) {
    if (!byFy.has(r.fy)) byFy.set(r.fy, []);
    byFy.get(r.fy)!.push({ headBucket: r.head_bucket, gross: Number(r.gross) });
  }

  return [...grands.entries()].map(([fy, grandTotal]) => ({
    fy,
    grandTotal,
    headTotals: byFy.get(fy) ?? [],
  }));
}

// ── R6 ───────────────────────────────────────────────────────────────────────

async function fetchFyMonthData(): Promise<FyMonthData[]> {
  const rows = await db.execute<{ fy: string; month_label: string }>(sql`
    SELECT DISTINCT fy, month_label
    FROM secondary_register_line
    ORDER BY fy, month_label
  `);

  const byFy = new Map<string, number[]>();
  for (const r of rows.rows) {
    if (!byFy.has(r.fy)) byFy.set(r.fy, []);
    const idx = monthLabelToIdx(r.month_label);
    if (idx >= 0) byFy.get(r.fy)!.push(idx);
  }

  return [...byFy.entries()].map(([fy, idxs]) => ({
    fy,
    monthIdxsPresent: [...new Set(idxs)].sort((a, b) => a - b),
  }));
}

// ── R7 ───────────────────────────────────────────────────────────────────────

async function fetchSourceCounts(): Promise<SourceCount[]> {
  const rows = await db.execute<{ source: string; count: string }>(sql`
    SELECT source, COUNT(*) AS count
    FROM secondary_register_line
    GROUP BY source
    ORDER BY source
  `);
  return rows.rows.map((r) => ({ source: r.source, count: Number(r.count) }));
}

// ── Top-level runner ──────────────────────────────────────────────────────────

export async function runGate3(nowMs = Date.now()): Promise<Gate3Report> {
  const [headMonthRows, territoryStats, headGross, fyMonths, sources] =
    await Promise.all([
      fetchHeadMonthRows(),
      fetchTerritoryStats(),
      fetchHeadGross(),
      fetchFyMonthData(),
      fetchSourceCounts(),
    ]);

  const checks = [
    checkR1AchievementRecomputed(headMonthRows),
    checkR2YtdClosedMonthsOnly(headMonthRows),
    checkR3AnomalyFlagConsistent(headMonthRows),
    checkR4TerritorySplitPopulated(territoryStats),
    checkR5CrossFootByHead(headGross),
    checkR6CompleteMonthsYoY(fyMonths, nowMs),
    checkR7NoDoubleCount(sources),
  ];

  return buildGate3Report(checks);
}

export type { Gate3Report };
