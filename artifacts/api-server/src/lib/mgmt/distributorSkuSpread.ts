// Phase D3: SKU / segment spread per distributor, from secondary_register_line.
//
// Attribution note: secondary_register_line has no "distributor" column.
// Each row records a retailer purchase (customer field). Distributor attribution
// is derived from the D1 retailer→distributor mapping from member working sheets.
// LOWER(TRIM(customer)) is used for case-insensitive retailer name matching.
//
// "Segment" here = brand_canon from secondary_register_line. These are product-
// line names (e.g. "CPVC DURALIFE", "SWR DRAINTECH"). The secondary register
// does NOT store individual item codes — brand_canon is the finest granularity.
//
// Broad segment = one of the 17 categories in group_map.json. Derived from
// brand_canon via a keyword-first lookup table built from the known universe.
//
// Whitespace ranked easiest → hardest:
//   1. range_depth  — brand_canons the distributor does NOT sell inside broad
//                     segments it ALREADY participates in.
//   2. lost_brand   — brand_canons present in the prior closed FY but absent
//                     in the most recent closed FY.
//   3. peer_whitespace — brands that comparable distributors (same state head)
//                     sell but this one does not; named by peer.
//
// Never console.log — use logger.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import type { DistributorGroup } from "./distributorDeepDive.js";
import { secondaryCoverageNote } from "./skuSpread.js";
import { getRetailerRegistry, normRetailerName } from "./retailerRegistry.js";

// ─── Broad segment universe (17 categories, from group_map.json keys) ─────────

export const ALL_BROAD_SEGMENTS: readonly string[] = [
  "WATER TANK",
  "AGRI",
  "UPVC",
  "CPVC",
  "SWR",
  "PPR",
  "HDPE",
  "Garden Pipe",
  "COLUMN",
  "Corrugated Pipe",
  "PTMT / Faucets",
  "CISTERN",
  "CP (Chrome-Plated)",
  "Sink",
  "Sanitaryware",
  "Connection / Waste",
  "Hardware",
] as const;

export const TOTAL_BROAD_SEGMENTS = ALL_BROAD_SEGMENTS.length; // 17

// Exact-match table for known secondary brand_canon values.
const BRAND_TO_BROAD: Record<string, string> = {
  "P.T.M.T. SYMET": "PTMT / Faucets",
  "CISTERNS & SEAT COVERS": "CISTERN",
  "SWR DRAINTECH": "SWR",
  "UPVC AQUAFRESH": "UPVC",
  "CPVC DURALIFE": "CPVC",
  "P.V.C. GARDEN PIPE": "Garden Pipe",
  "AGRITEC": "AGRI",
  "WATER TANKS": "WATER TANK",
  "S.STEEL SINK": "Sink",
  "SANITARYWARE": "Sanitaryware",
  "WATER HEATER": "Sanitaryware",
  "COLUMN PIPE": "COLUMN",
  "HDPE PIPE": "HDPE",
  "HARDWARE": "Hardware",
  "COCKROACH TRAPS & GRATINGS": "Connection / Waste",
  "MANHOLE COVER": "Connection / Waste",
  "VIGNETTE": "PTMT / Faucets",
};

export function brandToBroad(brand: string): string {
  if (BRAND_TO_BROAD[brand]) return BRAND_TO_BROAD[brand];
  const b = brand.toUpperCase();
  if (/^C\.?P[\s.\-]/.test(b) || b.includes("CDA") || b.includes(" SERIES")) {
    return "CP (Chrome-Plated)";
  }
  if (b.includes("CHROME")) return "CP (Chrome-Plated)";
  if (b.includes("CPVC")) return "CPVC";
  if (b.includes("SWR")) return "SWR";
  if (b.includes("UPVC") || b.includes("OPVC")) return "UPVC";
  if (b.includes("HDPE")) return "HDPE";
  if (b.includes("PPR")) return "PPR";
  if (b.includes("TANK")) return "WATER TANK";
  if (b.includes("GARDEN")) return "Garden Pipe";
  if (b.includes("AGRI")) return "AGRI";
  if (b.includes("COLUMN")) return "COLUMN";
  if (b.includes("CORRUGATED")) return "Corrugated Pipe";
  if (b.includes("PTMT") || b.includes("SYMET") || b.includes("VIGNETTE")) {
    return "PTMT / Faucets";
  }
  if (b.includes("CISTERN") || b.includes("SEAT COVER")) return "CISTERN";
  if (b.includes("SINK") || b.includes("S.STEEL") || b.includes("STAINLESS")) {
    return "Sink";
  }
  if (b.includes("SANITARY") || b.includes("GEYSER") || b.includes("HEATER")) {
    return "Sanitaryware";
  }
  if (
    b.includes("WASTE") ||
    b.includes("CONNECTION") ||
    b.includes("FLOOR TRAP") ||
    b.includes("MANHOLE") ||
    b.includes("COCKROACH") ||
    b.includes("GRATING")
  ) {
    return "Connection / Waste";
  }
  if (b.includes("HARDWARE") || b.includes("TEFLON")) return "Hardware";
  return "(other)";
}

// Ordered FYs — most recent last so priorFy derivation is trivial.
// FY2026-27 is included: the PSCode_3 register was backfilled into
// secondary_register_line at brand level (source='pscode3_brand_rollup').
const ANALYSIS_FYS = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26", "2026-27"];

// ─── Public types ─────────────────────────────────────────────────────────────

export type DistributorSegmentNet = {
  segment: string;      // brand_canon (product-line name)
  net: number;
  pct: number;
};

export type WhitespaceHint = {
  type: "range_depth" | "lost_brand" | "peer_whitespace";
  brand: string;              // brand_canon being suggested
  broadSegment: string;       // mapped broad segment
  evidence: string;           // human-readable evidence string
  peerNames?: string[];       // peer distributor names (peer_whitespace only)
  peerNet?: number;           // combined NET at peers in the most recent FY
};

export type DistributorSkuSpread = {
  isLiveYear: boolean;
  liveYearNote?: string;
  totalBroadSegments: number;           // denominator — always 17
  // All fields below are present only when isLiveYear=false and matchedRetailers>0
  recentFy?: string;
  totalNet?: number;
  distinctBrands?: number;              // distinct brand_canon values in recentFy
  broadSegmentsCovered?: number;        // distinct broad segments in recentFy
  netByBrand?: DistributorSegmentNet[]; // top brand_canons by net (recentFy)
  netByBroadSegment?: DistributorSegmentNet[]; // aggregated by broad segment (recentFy)
  crossSellDepth?: number;              // avg distinct brand_canons per retailer
  concentrationHhi?: number;           // HHI (0–10000)
  matchedRetailers?: number;           // D1 retailers that appeared in secondary data
  whitespace?: WhitespaceHint[];       // ranked easiest first
  /**
   * D1 retailer names that the retailer registry knows map to MULTIPLE
   * distinct RET#s (task 172). secondary_register_line carries no RET#, so
   * name-keyed matching for these names may include rows belonging to a
   * different retailer with the same name — surfaced, never silently merged.
   */
  ambiguousRetailerNames?: number;
};

// ─── Internal aggregation types ───────────────────────────────────────────────

type RawSecRow = {
  customer: string;
  brand_canon: string | null;
  fy: string;
  net: string | null;
};

type DistAgg = {
  // brand → fy → net
  brandFyNet: Map<string, Map<string, number>>;
  // retailer → brand set (for cross-sell depth, scoped to recentFy)
  retailerBrands: Map<string, Set<string>>;
  matchedRetailers: number;
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute and attach skuSpread to every DistributorGroup in place.
 * For the live FY, returns a placeholder immediately without querying the DB.
 * All DB errors are swallowed — skuSpread stays undefined on failure.
 */
export async function loadDistributorSkuSpread(
  fy: string,
  distGroups: DistributorGroup[],
): Promise<void> {
  if (!distGroups.length) return;

  // ── Collect all retailer names ─────────────────────────────────────────────
  // normRetailer (LOWER TRIM) → distributor normKey.
  // If a retailer appears under multiple distributors (shared), last-write wins;
  // shared retailers are already handled in D1 and are rare.
  const normToDistKey = new Map<string, string>();
  for (const g of distGroups) {
    for (const r of g.retailers) {
      const norm = r.name.toLowerCase().trim();
      normToDistKey.set(norm, g.normKey);
    }
  }

  if (normToDistKey.size === 0) return;

  // ── Retailer identity check (task 172) ─────────────────────────────────────
  // secondary_register_line has no RET#, so matching below is name-keyed
  // (name+distributor fallback). Consult the registry for names that are
  // KNOWN to map to multiple distinct RET#s and count them per distributor —
  // never silently merged, always surfaced.
  const ambiguousByDist = new Map<string, number>();
  try {
    const registry = await getRetailerRegistry();
    const ambiguous = registry.ambiguousNameKeys();
    for (const g of distGroups) {
      let n = 0;
      for (const r of g.retailers) {
        if (ambiguous.has(normRetailerName(r.name))) n++;
      }
      if (n > 0) ambiguousByDist.set(g.normKey, n);
    }
    if (ambiguousByDist.size > 0) {
      logger.warn(
        {
          fy,
          distributorsAffected: ambiguousByDist.size,
          totalAmbiguousNames: [...ambiguousByDist.values()].reduce((s, n) => s + n, 0),
        },
        "distributorSkuSpread: retailer names mapping to multiple RET#s — name-keyed rows may include a different retailer",
      );
    }
  } catch (err) {
    logger.warn({ err }, "distributorSkuSpread: retailer registry unavailable — ambiguity check skipped");
  }

  const normRetailerList = [...normToDistKey.keys()];

  // ── Batch DB query ─────────────────────────────────────────────────────────
  let rows: RawSecRow[];
  try {
    const result = await db.execute<RawSecRow>(
      sql`
        SELECT  customer,
                brand_canon,
                fy,
                SUM(net_amount::float8)::text AS net
        FROM    secondary_register_line
        WHERE   LOWER(TRIM(customer)) IN (
                  ${sql.join(
                    normRetailerList.map((n) => sql`${n}`),
                    sql`, `,
                  )}
                )
          AND   fy IN (
                  ${sql.join(
                    ANALYSIS_FYS.map((f) => sql`${f}`),
                    sql`, `,
                  )}
                )
        GROUP BY customer, brand_canon, fy
        HAVING  SUM(net_amount::float8) > 0
      `,
    );
    rows = result.rows;
  } catch (err) {
    logger.warn({ err }, "distributorSkuSpread: DB query failed");
    return;
  }

  if (rows.length === 0) {
    logger.info(
      { normRetailerCount: normRetailerList.length },
      "distributorSkuSpread: no secondary rows matched any retailer",
    );
    for (const g of distGroups) {
      (g as DistributorGroup & { skuSpread?: DistributorSkuSpread }).skuSpread = {
        isLiveYear: false,
        totalBroadSegments: TOTAL_BROAD_SEGMENTS,
        matchedRetailers: 0,
      };
    }
    return;
  }

  // ── Group rows by distributor ──────────────────────────────────────────────
  const distAggs = new Map<string, DistAgg>();
  for (const g of distGroups) {
    distAggs.set(g.normKey, {
      brandFyNet: new Map(),
      retailerBrands: new Map(),
      matchedRetailers: 0,
    });
  }

  // Track which retailers we've counted already (per distributor)
  const seenRetailers = new Map<string, Set<string>>(); // distKey → set of norm customers seen

  for (const row of rows) {
    const normCustomer = row.customer.toLowerCase().trim();
    const distKey = normToDistKey.get(normCustomer);
    if (!distKey) continue;

    const agg = distAggs.get(distKey);
    if (!agg) continue;

    const net = Number(row.net ?? 0);
    const brand = row.brand_canon ?? "(unknown)";
    const rowFy = row.fy;

    // brand → fy → net
    if (!agg.brandFyNet.has(brand)) agg.brandFyNet.set(brand, new Map());
    const fyMap = agg.brandFyNet.get(brand)!;
    fyMap.set(rowFy, (fyMap.get(rowFy) ?? 0) + net);

    // retailer brand sets (for cross-sell depth — use all FYs for max signal)
    if (!agg.retailerBrands.has(normCustomer)) {
      agg.retailerBrands.set(normCustomer, new Set());
    }
    agg.retailerBrands.get(normCustomer)!.add(brand);

    // count matched retailers once per dist
    if (!seenRetailers.has(distKey)) seenRetailers.set(distKey, new Set());
    const seen = seenRetailers.get(distKey)!;
    if (!seen.has(normCustomer)) {
      seen.add(normCustomer);
      agg.matchedRetailers++;
    }
  }

  // ── Determine most recent FY (global — most recent with any data) ──
  const fysWithData = new Set(rows.map((r) => r.fy));
  const recentFy =
    [...ANALYSIS_FYS].reverse().find((f) => fysWithData.has(f)) ?? ANALYSIS_FYS.at(-1)!;
  const priorFyIdx = ANALYSIS_FYS.indexOf(recentFy) - 1;
  const priorFy = priorFyIdx >= 0 ? ANALYSIS_FYS[priorFyIdx] : null;
  // Derived from the actual loaded months (cached), never a hard-coded range.
  const coverageNote = await secondaryCoverageNote(recentFy);

  // ── Build per-distributor spread objects ──────────────────────────────────
  // We also build a cross-distributor brand map for peer whitespace.
  // distBrandsInRecentFy: distKey → Set<brand>
  const distBrandsInRecentFy = new Map<string, Set<brand>>();

  type brand = string;
  const spreads = new Map<string, DistributorSkuSpread>();

  for (const g of distGroups) {
    const agg = distAggs.get(g.normKey);
    if (!agg || agg.matchedRetailers === 0) {
      spreads.set(g.normKey, {
        isLiveYear: false,
        totalBroadSegments: TOTAL_BROAD_SEGMENTS,
        matchedRetailers: 0,
      });
      distBrandsInRecentFy.set(g.normKey, new Set());
      continue;
    }

    // Aggregate for recentFy
    let totalNet = 0;
    const brandNetMap = new Map<string, number>();
    for (const [brand, fyMap] of agg.brandFyNet) {
      const n = fyMap.get(recentFy) ?? 0;
      if (n > 0) {
        brandNetMap.set(brand, n);
        totalNet += n;
      }
    }

    if (totalNet === 0) {
      // Has secondary history but nothing in recentFy — show prior FY instead
      spreads.set(g.normKey, {
        isLiveYear: false,
        totalBroadSegments: TOTAL_BROAD_SEGMENTS,
        matchedRetailers: agg.matchedRetailers,
        recentFy,
        totalNet: 0,
        distinctBrands: 0,
        broadSegmentsCovered: 0,
        netByBrand: [],
        netByBroadSegment: [],
        crossSellDepth: 0,
        concentrationHhi: 0,
        whitespace: [],
      });
      distBrandsInRecentFy.set(g.normKey, new Set());
      continue;
    }

    // brand → net, pct
    const netByBrand: DistributorSegmentNet[] = [...brandNetMap.entries()]
      .map(([segment, net]) => ({
        segment,
        net,
        pct: Math.round((net / totalNet) * 1000) / 10,
      }))
      .sort((a, b) => b.net - a.net);

    const soldBrands = new Set(brandNetMap.keys());
    distBrandsInRecentFy.set(g.normKey, soldBrands);

    // Broad segment rollup
    const broadNetMap = new Map<string, number>();
    for (const [brand, net] of brandNetMap) {
      const broad = brandToBroad(brand);
      broadNetMap.set(broad, (broadNetMap.get(broad) ?? 0) + net);
    }
    const netByBroadSegment: DistributorSegmentNet[] = [...broadNetMap.entries()]
      .map(([segment, net]) => ({
        segment,
        net,
        pct: Math.round((net / totalNet) * 1000) / 10,
      }))
      .sort((a, b) => b.net - a.net);

    const broadSegmentsCovered = new Set(
      [...soldBrands].map(brandToBroad).filter((b) => b !== "(other)"),
    ).size;

    // Cross-sell depth (avg distinct brand_canons per retailer, all FYs)
    const retailerBrandCounts = [...agg.retailerBrands.values()].map((s) => s.size);
    const crossSellDepth =
      retailerBrandCounts.length > 0
        ? Math.round(
            (retailerBrandCounts.reduce((s, c) => s + c, 0) / retailerBrandCounts.length) * 10,
          ) / 10
        : 0;

    // HHI over brand_canon shares in recentFy
    const concentrationHhi =
      totalNet > 0
        ? Math.round(
            netByBrand.reduce(
              (s, seg) => s + Math.pow((seg.net / totalNet) * 100, 2),
              0,
            ),
          )
        : 0;

    spreads.set(g.normKey, {
      isLiveYear: false,
      liveYearNote: coverageNote,
      totalBroadSegments: TOTAL_BROAD_SEGMENTS,
      recentFy,
      totalNet: Math.round(totalNet),
      distinctBrands: soldBrands.size,
      broadSegmentsCovered,
      netByBrand,
      netByBroadSegment,
      crossSellDepth,
      concentrationHhi,
      matchedRetailers: agg.matchedRetailers,
      whitespace: [], // filled in next pass
    });
  }

  // ── Whitespace — cross-distributor pass ────────────────────────────────────
  // Build: broadSeg → all brand_canons sold by ANY distributor in recentFy
  const broadToBrandsAnywhere = new Map<string, Map<string, number>>(); // broadSeg → brand → sumNet
  for (const [distKey, brandSet] of distBrandsInRecentFy) {
    const agg = distAggs.get(distKey);
    if (!agg) continue;
    for (const brand of brandSet) {
      const net = agg.brandFyNet.get(brand)?.get(recentFy) ?? 0;
      const broad = brandToBroad(brand);
      if (!broadToBrandsAnywhere.has(broad)) broadToBrandsAnywhere.set(broad, new Map());
      const m = broadToBrandsAnywhere.get(broad)!;
      m.set(brand, (m.get(brand) ?? 0) + net);
    }
  }

  for (const g of distGroups) {
    const spread = spreads.get(g.normKey);
    if (!spread || spread.matchedRetailers === 0 || !spread.totalNet) continue;

    const agg = distAggs.get(g.normKey)!;
    const mySoldBrands = distBrandsInRecentFy.get(g.normKey) ?? new Set<string>();
    const myBroadSegments = new Set([...mySoldBrands].map(brandToBroad));
    const hints: WhitespaceHint[] = [];

    // 1. Range depth: broad segments I'm in → brand_canons I'm missing
    for (const [broad, brandsAny] of broadToBrandsAnywhere) {
      if (!myBroadSegments.has(broad)) continue; // not in this segment yet
      for (const [brand, peerNet] of brandsAny) {
        if (mySoldBrands.has(brand)) continue; // already sell it
        hints.push({
          type: "range_depth",
          brand,
          broadSegment: broad,
          evidence: `already sells in ${broad} but not this line`,
          peerNet,
        });
      }
    }

    // 2. Lost brands: in priorFy but absent in recentFy
    if (priorFy) {
      for (const [brand, fyMap] of agg.brandFyNet) {
        const priorNet = fyMap.get(priorFy) ?? 0;
        const recentNet = fyMap.get(recentFy) ?? 0;
        if (priorNet > 0 && recentNet === 0) {
          hints.push({
            type: "lost_brand",
            brand,
            broadSegment: brandToBroad(brand),
            evidence: `sold in ${priorFy} (${fmtL(priorNet)}) but not in ${recentFy}`,
          });
        }
      }
    }

    // 3. Peer whitespace: brands peers sell that I don't (same state head)
    const peerNetByBrand = new Map<string, { net: number; peers: string[] }>();
    for (const other of distGroups) {
      if (other.normKey === g.normKey) continue;
      const otherBrands = distBrandsInRecentFy.get(other.normKey) ?? new Set<string>();
      const otherAgg = distAggs.get(other.normKey);
      for (const brand of otherBrands) {
        if (mySoldBrands.has(brand)) continue;
        const net = otherAgg?.brandFyNet.get(brand)?.get(recentFy) ?? 0;
        if (!peerNetByBrand.has(brand)) {
          peerNetByBrand.set(brand, { net: 0, peers: [] });
        }
        const entry = peerNetByBrand.get(brand)!;
        entry.net += net;
        entry.peers.push(other.name);
      }
    }
    for (const [brand, { net: peerNet, peers }] of peerNetByBrand) {
      // Avoid duplicating range_depth suggestions
      if (hints.some((h) => h.type === "range_depth" && h.brand === brand)) continue;
      hints.push({
        type: "peer_whitespace",
        brand,
        broadSegment: brandToBroad(brand),
        evidence: `peer${peers.length > 1 ? "s" : ""} ${peers.slice(0, 3).join(", ")} sell${peers.length === 1 ? "s" : ""} this (${fmtL(peerNet)} combined)`,
        peerNames: peers,
        peerNet: Math.round(peerNet),
      });
    }

    // Sort: range_depth first, lost_brand second, peer_whitespace third,
    //       within type: by peerNet desc for range_depth/peer, priorNet implicit for lost.
    const typeOrder: Record<WhitespaceHint["type"], number> = {
      range_depth: 0,
      lost_brand: 1,
      peer_whitespace: 2,
    };
    hints.sort((a, b) => {
      const td = typeOrder[a.type] - typeOrder[b.type];
      if (td !== 0) return td;
      return (b.peerNet ?? 0) - (a.peerNet ?? 0);
    });

    spread.whitespace = hints.slice(0, 12); // cap for readability
  }

  // ── Attach results ─────────────────────────────────────────────────────────
  for (const g of distGroups) {
    const spread = spreads.get(g.normKey);
    if (spread) {
      const amb = ambiguousByDist.get(g.normKey);
      if (amb) spread.ambiguousRetailerNames = amb;
      (g as DistributorGroup & { skuSpread?: DistributorSkuSpread }).skuSpread = spread;
    }
  }

  logger.info(
    {
      recentFy,
      distCount: distGroups.length,
      rowsMatched: rows.length,
    },
    "distributorSkuSpread: complete",
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtL(n: number): string {
  const l = n / 100000;
  return `₹${l.toFixed(2)}L`;
}
