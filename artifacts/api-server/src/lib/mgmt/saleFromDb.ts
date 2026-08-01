// Period-filtered Sale (Dispatched) from the sale_line DB table.
//
// Unlike the Sheets-based loadStateHeadSale, this function supports arbitrary
// period slicing: monthLabels controls exactly which months are summed.  Use
// this for the primary "Sale (Dispatched)" tile whenever sale_line contains
// data for the requested FY, and fall back to the Sheets loader otherwise.
//
// headCanon in sale_line stores the normalised form of the state-head name.
// After reading from the DB we resolve those norm keys to canonical display
// names via buildHeadResolver (same lookup the Sheets loader uses) so that
// headSales[rosterHead] lookups always succeed in the frontend.

import { db, saleLines } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildHeadResolver } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

export type SaleFromDbResult = {
  /** Canonical display-name → Σ amount (rupees).  Includes "Non-territory" key. */
  byHead: Map<string, number>;
  /** Company total across all heads (territory + non-territory). */
  total: number;
  /** Human-readable source label for the tile sub-line. */
  source: string;
  /** Non-null when the load failed or returned no data. */
  error: string | null;
  /**
   * false when the FY's register rows have no state-head attribution
   * (head_canon NULL on >90% of rows) — total is still period-exact, but
   * byHead is empty and per-head figures must come from another source.
   */
  headsAvailable: boolean;
};

/**
 * Loads dispatched sale (Taxable Value) from sale_line for the given FY and
 * list of month_label strings (e.g. ["Apr-26", "May-26", "Jun-26"]).
 */
export async function loadDispatchSaleFromDb(
  fy: string,
  monthLabels: string[],
): Promise<SaleFromDbResult> {
  if (monthLabels.length === 0) {
    return { byHead: new Map(), total: 0, source: "", error: "no months requested", headsAvailable: false };
  }
  try {
    const rows = await db
      .select({
        headCanon: saleLines.headCanon,
        isTerritory: saleLines.isTerritory,
        amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      })
      .from(saleLines)
      .where(
        and(
          eq(saleLines.fy, fy),
          inArray(saleLines.monthLabel, monthLabels),
          eq(saleLines.versionStatus, "current"),
        ),
      )
      .groupBy(saleLines.headCanon, saleLines.isTerritory);

    if (rows.length === 0) {
      return {
        byHead: new Map(),
        total: 0,
        source: "",
        error: `no rows in sale_line for ${fy} / ${monthLabels.join(",")}`,
        headsAvailable: false,
      };
    }

    // Separate territory (per-head) from non-territory (bucket total).
    const byNormKey = new Map<string, number>();
    let nonTerritoryTotal = 0;
    let total = 0;

    for (const row of rows) {
      const amt = row.amount ?? 0;
      if (amt <= 0) continue;
      total += amt;
      if (row.isTerritory === false) {
        nonTerritoryTotal += amt;
      } else {
        const key = row.headCanon ?? "unmapped";
        byNormKey.set(key, (byNormKey.get(key) ?? 0) + amt);
      }
    }

    if (total === 0) {
      return {
        byHead: new Map(),
        total: 0,
        source: "",
        error: `all amounts are zero in sale_line for ${fy} / ${monthLabels.join(",")}`,
        headsAvailable: false,
      };
    }

    // Head-attribution guard: FYs loaded from registers WITHOUT a state-head
    // column (FY2024-25 / FY2025-26 are 11-col sheets) have head_canon NULL on
    // every row, which lands entirely under "unmapped" here. A per-head answer
    // where >90% is "unmapped" is useless — return an error so the caller falls
    // through to the Sheets-based State Head Sale loader, which has real heads.
    const unmappedAmt = byNormKey.get("unmapped") ?? 0;
    if (unmappedAmt > 0.9 * total) {
      // Totals-only path: the period-exact company total is still valid even
      // though per-head attribution is impossible for this FY. Return it with
      // an empty byHead so callers keep exact period filtering and source
      // per-head figures elsewhere (or omit them).
      const plabel =
        monthLabels.length === 1
          ? monthLabels[0]
          : `${monthLabels[0]}–${monthLabels[monthLabels.length - 1]}`;
      logger.info(
        { fy, months: monthLabels.length, total },
        "saleFromDb: totals-only (no head attribution for this FY)",
      );
      return {
        byHead: new Map(),
        total,
        source: `sale_line (${plabel}; company total — no head split)`,
        error: null,
        headsAvailable: false,
      };
    }

    // Resolve normHead keys → canonical display names (same as roster's stateHead).
    const byHead = new Map<string, number>();
    try {
      const roster = await loadRoster();
      const canonicalHeads = new Set(
        roster.members.map((m) => m.stateHead).filter((h) => h.trim() !== ""),
      );
      const resolve = buildHeadResolver(canonicalHeads);
      for (const [key, amt] of byNormKey) {
        const display = resolve(key) ?? key;
        byHead.set(display, (byHead.get(display) ?? 0) + amt);
      }
    } catch {
      // Roster unavailable — use normHead keys as-is.
      for (const [key, amt] of byNormKey) {
        byHead.set(key, amt);
      }
    }
    if (nonTerritoryTotal > 0) {
      byHead.set("Non-territory", (byHead.get("Non-territory") ?? 0) + nonTerritoryTotal);
    }

    const periodLabel =
      monthLabels.length === 1
        ? monthLabels[0]
        : `${monthLabels[0]}–${monthLabels[monthLabels.length - 1]}`;
    const source = `sale_line (${periodLabel})`;

    logger.info(
      { fy, months: monthLabels.length, total, heads: byHead.size },
      "saleFromDb: period-filtered sale loaded",
    );

    return { byHead, total, source, error: null, headsAvailable: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err, fy }, "saleFromDb: DB query failed");
    return { byHead: new Map(), total: 0, source: "", error, headsAvailable: false };
  }
}
