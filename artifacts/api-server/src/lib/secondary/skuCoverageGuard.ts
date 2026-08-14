/**
 * SKU coverage guard — compares per-member and per-retailer totals between
 * secondary_sku_line (PSCode2 tab) and secondary_register_line (Summary Report).
 *
 * These two tables are loaded from different tabs of the same member workbooks.
 * Company-wide they reconcile to the same totals, but per-member (per head_canon)
 * the SKU table can understate vs the register when:
 *   1. The PSCode2 tab was not fully populated for that member.
 *   2. Retailer names differ between the Summary Report and PSCode2 tabs, causing
 *      rows to land under a different head_canon in secondary_sku_line.
 *
 * When sku_line qty < COVERAGE_THRESHOLD × register qty for a member, a WARN is
 * emitted. This is non-blocking — the ingest is never rolled back — but the
 * discrepancy is surfaced so push recommendations don't fire on stale data.
 *
 * Per-retailer granularity: secondary_register_line.customer ≈ secondary_sku_line.retailer
 * (both refer to the same physical retailer/shop from different tabs of the workbook).
 * The per-retailer query normalises names (lowercase + collapsed whitespace) to join
 * across tabs, so spelling differences are detected as a name-resolution gap rather
 * than a data gap.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

// ── Threshold ─────────────────────────────────────────────────────────────────

/** SKU qty must be ≥ this fraction of register qty before a WARN is emitted. */
export const COVERAGE_THRESHOLD = 0.60;

// ── Per-member coverage ───────────────────────────────────────────────────────

export type MemberCoverageRow = {
  fy: string;
  headCanon: string | null;
  skuQty: number;
  skuNet: number;
  registerQty: number;
  registerNet: number;
  /** sku_qty / register_qty; null when register_qty = 0. */
  qtyRatio: number | null;
  /** sku_net / register_net; null when register_net = 0. */
  netRatio: number | null;
  /**
   * ok         — within threshold (PSCode2 appears sufficiently complete)
   * low        — sku_qty < threshold × register_qty  (PSCode2 appears incomplete)
   * no-sku     — register data exists but zero SKU rows (PSCode2 not loaded)
   * no-register — SKU data exists but zero register rows (member not in register)
   */
  flag: "ok" | "low" | "no-sku" | "no-register";
};

export type SkuMemberCoverageReport = {
  fy: string;
  threshold: number;
  members: MemberCoverageRow[];
  flaggedCount: number;
  totalMembers: number;
};

/**
 * Compare per-member secondary_sku_line totals vs secondary_register_line totals.
 *
 * Logs a WARN for every member below the coverage threshold. Never throws,
 * never modifies any data — safe to call after every PSCode2 ingest.
 */
export async function checkSkuVsRegisterCoverage(
  fy: string,
  opts: { threshold?: number } = {},
): Promise<SkuMemberCoverageReport> {
  const threshold = opts.threshold ?? COVERAGE_THRESHOLD;

  // Aggregate secondary_sku_line per member (head_canon)
  const skuRows = await db.execute<{
    head_canon: string | null;
    sku_qty: string;
    sku_net: string;
  }>(sql`
    SELECT
      head_canon,
      SUM(COALESCE(qty::numeric, 0))        AS sku_qty,
      SUM(COALESCE(net_amount::numeric, 0)) AS sku_net
    FROM secondary_sku_line
    WHERE fy = ${fy}
    GROUP BY head_canon
  `);

  // Aggregate secondary_register_line per member (head_canon)
  const regRows = await db.execute<{
    head_canon: string | null;
    reg_qty: string;
    reg_net: string;
  }>(sql`
    SELECT
      head_canon,
      SUM(COALESCE(qty::numeric, 0))        AS reg_qty,
      SUM(COALESCE(net_amount::numeric, 0)) AS reg_net
    FROM secondary_register_line
    WHERE fy = ${fy}
    GROUP BY head_canon
  `);

  // Build lookup maps (null key is valid — rows with no head_canon)
  const skuByHead = new Map<string, { qty: number; net: number }>();
  for (const r of skuRows.rows) {
    const key = r.head_canon ?? "__null__";
    skuByHead.set(key, { qty: parseFloat(r.sku_qty) || 0, net: parseFloat(r.sku_net) || 0 });
  }
  const regByHead = new Map<string, { qty: number; net: number }>();
  for (const r of regRows.rows) {
    const key = r.head_canon ?? "__null__";
    regByHead.set(key, { qty: parseFloat(r.reg_qty) || 0, net: parseFloat(r.reg_net) || 0 });
  }

  // Union of all head_canon keys
  const allKeys = new Set<string>([...skuByHead.keys(), ...regByHead.keys()]);

  const members: MemberCoverageRow[] = [];
  for (const key of allKeys) {
    const headCanon = key === "__null__" ? null : key;
    const sku = skuByHead.get(key) ?? { qty: 0, net: 0 };
    const reg = regByHead.get(key) ?? { qty: 0, net: 0 };

    const qtyRatio = reg.qty > 0 ? sku.qty / reg.qty : null;
    const netRatio = reg.net > 0 ? sku.net / reg.net : null;

    let flag: MemberCoverageRow["flag"];
    if (reg.qty === 0 && sku.qty > 0) {
      flag = "no-register";
    } else if (reg.qty === 0 && sku.qty === 0) {
      flag = "no-register"; // nothing to check
    } else if (sku.qty === 0) {
      flag = "no-sku";
    } else if (qtyRatio !== null && qtyRatio < threshold) {
      flag = "low";
    } else {
      flag = "ok";
    }

    members.push({ fy, headCanon, skuQty: sku.qty, skuNet: sku.net, registerQty: reg.qty, registerNet: reg.net, qtyRatio, netRatio, flag });
  }

  // Sort: flagged first (low, no-sku, no-register, ok); within flag by ratio ascending
  const ORDER: Record<MemberCoverageRow["flag"], number> = { low: 0, "no-sku": 1, "no-register": 2, ok: 3 };
  members.sort((a, b) => {
    const fo = ORDER[a.flag] - ORDER[b.flag];
    if (fo !== 0) return fo;
    return (a.qtyRatio ?? 0) - (b.qtyRatio ?? 0);
  });

  const flaggedCount = members.filter((m) => m.flag === "low" || m.flag === "no-sku").length;

  // Emit structured warnings for every flagged member
  for (const m of members) {
    if (m.flag === "low") {
      logger.warn(
        {
          fy,
          headCanon: m.headCanon,
          skuQty: m.skuQty,
          registerQty: m.registerQty,
          qtyRatio: m.qtyRatio?.toFixed(3),
          skuNet: Math.round(m.skuNet),
          registerNet: Math.round(m.registerNet),
          netRatio: m.netRatio?.toFixed(3),
          threshold,
        },
        "skuCoverageGuard: PSCode2 tab appears incomplete — sku_line qty is below threshold; K3 push recommendations may fire on items the retailer already stocks",
      );
    } else if (m.flag === "no-sku") {
      logger.warn(
        {
          fy,
          headCanon: m.headCanon,
          registerQty: m.registerQty,
          registerNet: Math.round(m.registerNet),
        },
        "skuCoverageGuard: member has register data but zero SKU rows — PSCode2 tab was not loaded for this member",
      );
    }
  }

  logger.info(
    { fy, threshold, totalMembers: members.length, flaggedCount },
    "skuCoverageGuard: per-member coverage check complete",
  );

  return { fy, threshold, members, flaggedCount, totalMembers: members.length };
}

// ── Per-retailer gap ──────────────────────────────────────────────────────────

export type RetailerGapRow = {
  fy: string;
  /** Normalised (lowercase + collapsed whitespace) retailer name used for the join. */
  retailer: string;
  skuQty: number;
  registerQty: number;
  /** sku_qty / register_qty; null when register_qty = 0. */
  qtyRatio: number | null;
  skuLines: number;
  registerLines: number;
  /**
   * low      — sku_qty < threshold × register_qty (PSCode2 has fewer item lines for this retailer)
   * no-sku   — retailer is in register but absent from sku_line (name mismatch or missing rows)
   * ok       — sku_qty ≥ threshold × register_qty
   */
  flag: "low" | "no-sku" | "ok";
};

export type RetailerGapReport = {
  fy: string;
  threshold: number;
  minRegisterQty: number;
  retailers: RetailerGapRow[];
  flaggedCount: number;
  totalRetailers: number;
};

/**
 * Produce a per-retailer gap report.
 *
 * Compares secondary_register_line.customer (Summary Report) vs
 * secondary_sku_line.retailer (PSCode2 tab), joined on normalised name.
 * Returns retailers where sku_line appears to understate the register,
 * ranked by severity (ratio ascending, then register qty descending).
 *
 * @param minRegisterQty Minimum register qty to include in the report (filters noise).
 */
export async function computeRetailerGap(
  fy: string,
  opts: { threshold?: number; minRegisterQty?: number } = {},
): Promise<RetailerGapReport> {
  const threshold = opts.threshold ?? COVERAGE_THRESHOLD;
  const minRegisterQty = opts.minRegisterQty ?? 100;

  const rows = await db.execute<{
    retailer: string;
    sku_qty: string;
    sku_lines: string;
    reg_qty: string;
    reg_lines: string;
  }>(sql`
    WITH sku AS (
      SELECT
        LOWER(TRIM(REGEXP_REPLACE(retailer, E'\\s+', ' ', 'g'))) AS norm_name,
        SUM(COALESCE(qty::numeric, 0))                            AS sku_qty,
        COUNT(*)::int                                             AS sku_lines
      FROM secondary_sku_line
      WHERE fy = ${fy}
        AND retailer IS NOT NULL AND retailer <> ''
      GROUP BY LOWER(TRIM(REGEXP_REPLACE(retailer, E'\\s+', ' ', 'g')))
    ),
    reg AS (
      SELECT
        LOWER(TRIM(REGEXP_REPLACE(customer, E'\\s+', ' ', 'g'))) AS norm_name,
        SUM(COALESCE(qty::numeric, 0))                            AS reg_qty,
        COUNT(*)::int                                             AS reg_lines
      FROM secondary_register_line
      WHERE fy = ${fy}
        AND customer IS NOT NULL AND customer <> ''
      GROUP BY LOWER(TRIM(REGEXP_REPLACE(customer, E'\\s+', ' ', 'g')))
    )
    SELECT
      COALESCE(r.norm_name, s.norm_name)  AS retailer,
      COALESCE(s.sku_qty,   0)::text      AS sku_qty,
      COALESCE(s.sku_lines, 0)::text      AS sku_lines,
      COALESCE(r.reg_qty,   0)::text      AS reg_qty,
      COALESCE(r.reg_lines, 0)::text      AS reg_lines
    FROM reg r
    FULL OUTER JOIN sku s ON s.norm_name = r.norm_name
    WHERE COALESCE(r.reg_qty, 0)::numeric >= ${minRegisterQty}
    ORDER BY
      CASE
        WHEN COALESCE(r.reg_qty, 0)::numeric > 0
          THEN COALESCE(s.sku_qty, 0)::numeric / COALESCE(r.reg_qty, 0)::numeric
        ELSE 1
      END ASC,
      COALESCE(r.reg_qty, 0)::numeric DESC
  `);

  const retailers: RetailerGapRow[] = rows.rows.map((r) => {
    const skuQty = parseFloat(r.sku_qty) || 0;
    const regQty = parseFloat(r.reg_qty) || 0;
    const qtyRatio = regQty > 0 ? skuQty / regQty : null;
    const flag: RetailerGapRow["flag"] =
      skuQty === 0 ? "no-sku" :
      qtyRatio !== null && qtyRatio < threshold ? "low" : "ok";
    return {
      fy,
      retailer: r.retailer,
      skuQty,
      registerQty: regQty,
      qtyRatio,
      skuLines: parseInt(r.sku_lines, 10) || 0,
      registerLines: parseInt(r.reg_lines, 10) || 0,
      flag,
    };
  });

  const flaggedCount = retailers.filter((r) => r.flag !== "ok").length;
  logger.info(
    { fy, threshold, minRegisterQty, totalRetailers: retailers.length, flaggedCount },
    "skuCoverageGuard: per-retailer gap report complete",
  );

  return { fy, threshold, minRegisterQty, retailers, flaggedCount, totalRetailers: retailers.length };
}

// ── Coverage warning type (consumed by the K3 recommendation path) ────────────

/**
 * Attached to the SKU facts response when one or more members have PSCode2
 * (secondary_sku_line) qty below the threshold relative to their Summary Report
 * (secondary_register_line) qty.
 *
 * When present, the `unboughtValue` and gap-code figures in the facts payload
 * may include items the retailer already stocks, because secondary_sku_line is
 * missing rows.  Callers must not treat those gap figures as authoritative.
 */
export type CoverageWarning = {
  /** Members with flag="low" or "no-sku". */
  flaggedMemberCount: number;
  /** Total members in the comparison (register + sku union). */
  totalMembers: number;
  /** Threshold applied (default COVERAGE_THRESHOLD = 0.60). */
  threshold: number;
  /** Per-flagged-member detail. */
  flaggedMembers: Array<{
    headCanon: string | null;
    qtyRatio: number | null;
    flag: "low" | "no-sku";
  }>;
  /**
   * Human-readable explanation. Suitable for surfacing in API responses and
   * UI warnings.
   */
  note: string;
};

// ── Pure helpers (unit-testable without DB) ────────────────────────────────────

/**
 * Classify a single member's coverage given its sku and register totals.
 * Pure function — used in tests and by the DB-backed check.
 */
export function classifyMemberCoverage(
  skuQty: number,
  registerQty: number,
  threshold: number = COVERAGE_THRESHOLD,
): MemberCoverageRow["flag"] {
  if (registerQty === 0 && skuQty === 0) return "no-register";
  if (registerQty === 0) return "no-register";
  if (skuQty === 0) return "no-sku";
  if (skuQty / registerQty < threshold) return "low";
  return "ok";
}

// ── Coverage status ───────────────────────────────────────────────────────────

/**
 * Three-state coverage verdict used by the K3 recommendation path:
 *   "verified"    — coverage check ran and every member passed; recommendations are trustworthy.
 *   "insufficient" — one or more members failed the threshold; recommendations suppressed.
 *   "unverified"   — the coverage check query failed; recommendations suppressed (fail-closed).
 */
export type CoverageStatus = "verified" | "insufficient" | "unverified";

/**
 * Pure: derive a CoverageStatus from a member list returned by
 * checkSkuVsRegisterCoverage.  "unverified" cannot be derived here (it
 * requires the caller to catch a query failure) — use "unverified" in
 * catch blocks and this function in the happy path.
 */
export function buildCoverageStatus(
  members: MemberCoverageRow[],
  threshold?: number,
): "verified" | "insufficient" {
  return buildCoverageWarning(members, threshold) ? "insufficient" : "verified";
}

/**
 * Pure: given a list of MemberCoverageRow results (from checkSkuVsRegisterCoverage),
 * build a CoverageWarning when any member is flagged (flag="low" or "no-sku").
 * Returns null when every member passes (coverage is adequate).
 *
 * This function is the bridge between the DB-backed coverage check and the
 * K3 recommendation path — it is unit-testable without a DB connection.
 */
export function buildCoverageWarning(
  members: MemberCoverageRow[],
  threshold: number = COVERAGE_THRESHOLD,
): CoverageWarning | null {
  const flagged = members.filter((m) => m.flag === "low" || m.flag === "no-sku");
  if (flagged.length === 0) return null;

  const pct = Math.round(threshold * 100);
  return {
    flaggedMemberCount: flagged.length,
    totalMembers: members.length,
    threshold,
    flaggedMembers: flagged.map((m) => ({
      headCanon: m.headCanon,
      qtyRatio: m.qtyRatio,
      flag: m.flag as "low" | "no-sku",
    })),
    note:
      `${flagged.length} of ${members.length} member${flagged.length === 1 ? "" : "s"} ` +
      `have PSCode2 (secondary_sku_line) qty below ${pct}% of their Summary Report ` +
      `(secondary_register_line) qty. Gap codes and unbought values for these members ` +
      `may include items the retailer already stocks — PSCode2 tabs may be incomplete, ` +
      `or retailer names may differ between tabs.`,
  };
}
