// Phase 5: SKU and segment spread from secondary_register_line.
//
// Closed years (FY2024-25, FY2025-26): query the DB for the selected member
// matched by normSecKey applied to head_canon.  Compute segment coverage,
// NET (Sub Total) by segment, cross-sell depth, and HHI concentration.
//
// Live year (FY2026-27): secondary register not yet available — return a
// placeholder object (isLiveYear: true).
//
// Rules:
//  - NET = net_amount (Sub Total), never gross_amount.
//  - "segment" = brand_canon from secondary_register_line.
//  - head_canon is stored as the raw name; match via regexp_replace normalisation
//    so it aligns with normSecKey() used in the rest of the deep-dive pipeline.
//  - Never console.log; use logger.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

export type SegmentNet = {
  segment: string;
  net: number;
  pct: number;
};

export type SkuSpread = {
  isLiveYear: boolean;
  liveYearNote?: string;
  // Present when isLiveYear = false
  totalRows?: number;
  totalNet?: number;
  distinctSegments?: number;
  totalKnownSegments?: number;
  coveragePct?: number;
  netBySegment?: SegmentNet[];
  crossSellDepth?: number;
  concentrationHhi?: number;
};

type RawLine = {
  brand_canon: string | null;
  customer: string | null;
  net_amount: string | null;
};

type BrandRow = {
  brand_canon: string | null;
};

// Live FY — secondary register not ingested yet.
const LIVE_FY = "2026-27";

export async function computeSkuSpread(
  normKey: string,
  fy: string,
): Promise<SkuSpread> {
  if (fy === LIVE_FY) {
    return {
      isLiveYear: true,
      liveYearNote:
        "Segment spread reads the brand-level register table, which is not populated for FY2026-27. (Item-code SKU detail for Apr–Jun 2026 is loaded separately.)",
    };
  }

  // Run member lines + full segment universe in parallel.
  const [memberResult, universeResult] = await Promise.all([
    db.execute<RawLine>(
      sql`
        SELECT brand_canon, customer, net_amount
        FROM   secondary_register_line
        WHERE  fy = ${fy}
          AND  lower(regexp_replace(head_canon, '[^a-zA-Z0-9]', '', 'g')) = ${normKey}
      `,
    ),
    db.execute<BrandRow>(
      sql`
        SELECT DISTINCT brand_canon
        FROM   secondary_register_line
        WHERE  fy = ${fy}
      `,
    ),
  ]);

  const rows = memberResult.rows;
  const totalKnownSegments = universeResult.rows.filter(
    (r) => r.brand_canon != null,
  ).length;

  if (rows.length === 0) {
    logger.info({ normKey, fy }, "skuSpread: no rows for member in closed FY");
    return {
      isLiveYear: false,
      totalRows: 0,
      totalNet: 0,
      distinctSegments: 0,
      totalKnownSegments,
      coveragePct: 0,
      netBySegment: [],
      crossSellDepth: 0,
      concentrationHhi: 0,
    };
  }

  // Aggregate over member rows.
  let totalNet = 0;
  const netBySeg: Record<string, number> = {};
  const brandsByCustomer: Record<string, Set<string>> = {};

  for (const r of rows) {
    const net = Number(r.net_amount ?? 0);
    totalNet += net;
    const seg = r.brand_canon ?? "(unknown)";
    netBySeg[seg] = (netBySeg[seg] ?? 0) + net;
    if (r.customer) {
      if (!brandsByCustomer[r.customer]) brandsByCustomer[r.customer] = new Set();
      brandsByCustomer[r.customer].add(seg);
    }
  }

  const distinctSegments = Object.keys(netBySeg).length;
  const coveragePct =
    totalKnownSegments > 0
      ? Math.round((distinctSegments / totalKnownSegments) * 1000) / 10
      : 0;

  const netBySegment: SegmentNet[] = Object.entries(netBySeg)
    .map(([segment, net]) => ({
      segment,
      net,
      pct: totalNet > 0 ? Math.round((net / totalNet) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.net - a.net);

  const customers = Object.values(brandsByCustomer);
  const crossSellDepth =
    customers.length > 0
      ? Math.round(
          (customers.reduce((s, b) => s + b.size, 0) / customers.length) * 10,
        ) / 10
      : 0;

  // Herfindahl-Hirschman Index: sum of squared share percentages (0–10000).
  const concentrationHhi =
    totalNet > 0
      ? Math.round(
          netBySegment.reduce(
            (s, seg) => s + Math.pow((seg.net / totalNet) * 100, 2),
            0,
          ),
        )
      : 0;

  logger.info(
    {
      normKey,
      fy,
      totalRows: rows.length,
      totalNet: Math.round(totalNet),
      distinctSegments,
      totalKnownSegments,
      coveragePct,
    },
    "skuSpread: computed",
  );

  return {
    isLiveYear: false,
    totalRows: rows.length,
    totalNet,
    distinctSegments,
    totalKnownSegments,
    coveragePct,
    netBySegment,
    crossSellDepth,
    concentrationHhi,
  };
}
