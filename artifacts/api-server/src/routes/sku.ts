/**
 * SKU Deep Dive routes — Phase K1.
 *
 * GET /api/sku/facts
 *   Returns item-code level ordering facts for the selected FY, level, period and scope.
 *
 * GET /api/sku/capability
 *   Returns which levels are available for each FY (quick capability check without facts).
 *
 * GET /api/sku/catalogue
 *   Returns the item-master code counts per canonical segment group (the denominator
 *   for every breadth figure).
 *
 * ── Level semantics ──
 *   distributor   — sale_line_current, type_raw null or not matching '%direct%'
 *   direct_dealer — sale_line_current, type_raw ILIKE '%direct%'
 *   retailer      — secondary_sku_line; NOT_AVAILABLE for any FY with no loaded register
 *
 * ── Segment source ──
 *   Primary (distributor/direct_dealer): COALESCE(group_canon, group_raw, 'Unmapped')
 *   Secondary (retailer): segment_canon derived from Segment column via group_map.json
 *   type_raw is NEVER used as a segment source.
 *
 * ── NET definition ──
 *   Primary: sale_line.amount (= taxable value / net invoice amount)
 *   Secondary: secondary_sku_line.net_amount (= Sub Total column from register)
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { loadSkuFacts, getSkuCapability, getSkuTrend } from "../lib/sku/skuFacts.js";
import type { SkuLevel, SkuScope } from "../lib/sku/skuFacts.js";
import { getSkuRecommendations } from "../lib/sku/skuRecommendations.js";
import { getDistributorList, getSkuPushList } from "../lib/sku/skuPushList.js";
import {
  getCatalogueCounts,
  getCatalogueCompleteness,
  getFySegmentDistribution,
  getNeverSoldCatalogueItems,
  getItemMasterGapForFy,
} from "../lib/sku/catalogue.js";
import { fiscalMonthsToLabels } from "../lib/mgmt/primaryPeriod.js";
import {
  getPrimaryDiscountByCode,
  getSecondaryDiscountByCode,
  getSeasonality,
  getPeakQuarterMap,
  getDiscountNormFlags,
  getBreadthTrend,
  getFirstOrderCodes,
  getLostCodes,
  getBlockedCapabilities,
  clearK4Cache,
} from "../lib/sku/skuK4.js";

const router = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const VALID_LEVELS = new Set(["distributor", "direct_dealer", "retailer", "project"]);
const VALID_SCOPES = new Set(["company", "head", "customer"]);

function intParam(
  req: Request,
  key: string,
  lo: number,
  hi: number,
  dflt: number,
): number {
  const v = Number(req.query[key]);
  return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : dflt;
}

// ── GET /api/sku/facts ────────────────────────────────────────────────────────

router.get("/sku/facts", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";

  const level = typeof req.query.level === "string" ? req.query.level.trim() : "distributor";
  if (!VALID_LEVELS.has(level)) {
    res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(", ")}` });
    return;
  }

  const scope = typeof req.query.scope === "string" ? req.query.scope.trim() : "company";
  if (!VALID_SCOPES.has(scope)) {
    res.status(400).json({ error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` });
    return;
  }

  const scopeId =
    scope !== "company" && typeof req.query.scopeId === "string" && req.query.scopeId.trim()
      ? req.query.scopeId.trim()
      : undefined;

  if (scope !== "company" && !scopeId) {
    res.status(400).json({ error: "scopeId is required when scope is 'head' or 'customer'" });
    return;
  }

  const monthFrom = intParam(req, "monthFrom", 1, 12, 1);
  const monthTo   = intParam(req, "monthTo", monthFrom, 12, 12);
  const monthLabels = fiscalMonthsToLabels(fy, monthFrom, monthTo);

  const segment =
    typeof req.query.segment === "string" && req.query.segment.trim()
      ? req.query.segment.trim()
      : undefined;

  try {
    const result = await loadSkuFacts({
      fy,
      level: level as SkuLevel,
      scope: scope as "company" | "head" | "customer",
      scopeId,
      monthLabels,
      segment,
    });

    res.json({
      fy,
      monthFrom,
      monthTo,
      level,
      scope,
      scopeId: scopeId ?? null,
      segment: segment ?? null,
      // NET source documented explicitly (acceptance criterion).
      netSource:
        level === "retailer"
          ? "secondary_sku_line.net_amount (Sub Total column from secondary register)"
          : "sale_line.amount (taxable value / net invoice amount)",
      segmentSource:
        level === "retailer"
          ? "secondary_sku_line.segment_canon derived from Segment column via group_map.json"
          : "COALESCE(sale_line.group_canon, sale_line.group_raw, 'Unmapped') — never type_raw",
      // breadthDenominator: codesEverSold per segment (cross-FY distinct codes in
      // sale_line). Each SkuSegmentFact carries its own codesEverSold + codesInCatalogue.
      capability: result.capability,
      facts: result.facts,
    });
  } catch (err) {
    req.log.error({ err, fy, level }, "sku facts failed");
    res.status(500).json({ error: "Could not load SKU facts." });
  }
});

// ── GET /api/sku/capability ───────────────────────────────────────────────────

router.get("/sku/capability", async (req: Request, res: Response): Promise<void> => {
  const fys =
    typeof req.query.fy === "string"
      ? [req.query.fy.trim()].filter((f) => FY_PATTERN.test(f))
      : ["2024-25", "2025-26", "2026-27"];

  try {
    const results = await Promise.all(
      fys.map(async (fy) => ({ fy, capability: await getSkuCapability(fy) })),
    );
    res.json({ capabilities: results });
  } catch (err) {
    req.log.error({ err }, "sku capability check failed");
    res.status(500).json({ error: "Could not check SKU capability." });
  }
});

// ── GET /api/sku/catalogue ────────────────────────────────────────────────────
//
// Query params:
//   fy  (optional) — if provided, also returns segment distribution for that FY
//                    so callers can inspect unmapped/raw_only rows for a specific year.

router.get("/sku/catalogue", async (req: Request, res: Response): Promise<void> => {
  try {
    const fyParam =
      typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
        ? req.query.fy.trim()
        : null;

    const [cat, completeness, neverSold, fyDist, itemMasterGap] = await Promise.all([
      getCatalogueCounts(),
      getCatalogueCompleteness(),
      getNeverSoldCatalogueItems(),
      fyParam ? getFySegmentDistribution(fyParam) : Promise.resolve(null),
      getItemMasterGapForFy(fyParam ?? undefined),
    ]);

    const unmappedLines = (fyDist ?? []).filter(
      (r) => r.segment === "Unmapped" || r.mappingStatus !== "mapped_via_canon",
    );
    const unmappedLineCount  = unmappedLines.reduce((s, r) => s + r.lineCount, 0);
    const unmappedCodeCount  = unmappedLines.reduce((s, r) => s + r.distinctCodes, 0);
    const unmappedValue      = unmappedLines.reduce((s, r) => s + r.totalNet, 0);

    res.json({
      // ── item_master reference counts ─────────────────────────────────────
      // NOT used as breadth denominator (item_master is an incomplete snapshot).
      // Use completeness.rows[seg].codesEverSold for the breadth denominator.
      itemMaster: {
        bySegment: cat.bySegment,
        mappedCodes: cat.mappedCodes,
        unmappedCodes: cat.unmappedCount,
        totalCodes: cat.totalCodes,
      },

      // ── Codes in item_master that have never been sold ───────────────────
      // These are genuine catalogue items with no transaction history.
      // bySegment lists canonical segment → { count, itemGroups }.
      // unmapped = item_groups not covered by item_group_map.json.
      neverSold: {
        total: neverSold.total,
        bySegment: neverSold.bySegment,
        unmapped: neverSold.unmapped,
      },

      // ── Completeness assertion ───────────────────────────────────────────
      // codesAvailable (item_master) vs codesEverSold (sale_line, all FYs).
      // Shortfall = codesEverSold − codesAvailable.  Only SWR passes today.
      completeness: {
        passing: completeness.passing,
        failing: completeness.failing,
        totalShortfall: completeness.totalShortfall,
        unmappedSegments: completeness.unmappedSegments,
        rows: completeness.rows,
      },

      // ── Per-FY segment distribution (only when ?fy= is provided) ────────
      fyDistribution: fyDist
        ? {
            fy: fyParam,
            rows: fyDist,
            unmappedSummary: {
              lineCount:  unmappedLineCount,
              codeCount:  unmappedCodeCount,
              totalNet:   unmappedValue,
              pct: fyDist.reduce((s, r) => s + r.totalNet, 0) > 0
                ? (unmappedValue / fyDist.reduce((s, r) => s + r.totalNet, 0)) * 100
                : 0,
            },
          }
        : null,

      // ── item_master gap disclosure ─────────────────────────────────────
      // Codes that transacted in the target FY but are invisible to the
      // mrp > 0 catalogue gate — either unpriced (mrp null/0) or absent
      // from item_master entirely.  Reported here so the caller can surface
      // the gap rather than silently omit ₹40+ Cr of live sales.
      //
      // fy defaults to the latest FY in sale_line_all when ?fy= is omitted.
      // Segment is taken from sale_line_all (group_canon / group_raw) —
      // NOT from item_master, which is precisely what is incomplete here.
      // Per-segment code counts may not sum to the top-level distinct total
      // if a code appears under two group_canon values across invoices.
      itemMasterGap: {
        fy: itemMasterGap.fy,
        unpriced: itemMasterGap.unpriced,
        notInMaster: itemMasterGap.notInMaster,
        total: itemMasterGap.total,
        bySegment: itemMasterGap.bySegment,
      },

      note: "item_master reference via item_group_map.json. Breadth denominator = codesEverSold in sale_line. itemMasterGap lists live codes excluded by the mrp > 0 gate.",
    });
  } catch (err) {
    req.log.error({ err }, "catalogue endpoint failed");
    res.status(500).json({ error: "Could not compute catalogue counts." });
  }
});

// ── GET /api/sku/trend ────────────────────────────────────────────────────────
//
// Returns per-FY-month and per-FY breadth aggregates across all loaded fiscal
// years.  No FY or period filter — the whole time series is always returned.
//
// Query params:
//   level    (required)  distributor | direct_dealer | retailer
//   scope    (optional)  company (default) | head | customer
//   scopeId  (required when scope != company)
//   segment  (optional)  filter to a single canonical segment

router.get("/sku/trend", async (req: Request, res: Response): Promise<void> => {
  const level = typeof req.query.level === "string" ? req.query.level.trim() : "distributor";
  if (!VALID_LEVELS.has(level)) {
    res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(", ")}` });
    return;
  }

  const scope = typeof req.query.scope === "string" ? req.query.scope.trim() : "company";
  if (!VALID_SCOPES.has(scope)) {
    res.status(400).json({ error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` });
    return;
  }

  const scopeId =
    scope !== "company" && typeof req.query.scopeId === "string" && req.query.scopeId.trim()
      ? req.query.scopeId.trim()
      : undefined;

  if (scope !== "company" && !scopeId) {
    res.status(400).json({ error: "scopeId is required when scope is 'head' or 'customer'" });
    return;
  }

  const segment =
    typeof req.query.segment === "string" && req.query.segment.trim()
      ? req.query.segment.trim()
      : undefined;

  try {
    const result = await getSkuTrend({
      level: level as SkuLevel,
      scope: scope as SkuScope,
      scopeId,
      segment,
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err, level }, "sku trend failed");
    res.status(500).json({ error: "Could not load SKU trend data." });
  }
});

// ── GET /api/sku/recommendations ─────────────────────────────────────────────
//
// Returns a ranked push list: segments with gap codes, each with top-N gap
// codes by prior same-period net.  Same params as /api/sku/facts except no
// `segment` filter (always company-wide segments).
//
// Query params:
//   fy        (required)  e.g. 2026-27
//   level     (required)  distributor | direct_dealer | retailer | project
//   scope     (optional)  company (default) | head | customer
//   scopeId   (required when scope != company)
//   monthFrom (optional)  1–12, default 1
//   monthTo   (optional)  monthFrom–12, default 12

router.get("/sku/recommendations", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";

  const level = typeof req.query.level === "string" ? req.query.level.trim() : "distributor";
  if (!VALID_LEVELS.has(level)) {
    res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(", ")}` });
    return;
  }

  const scope = typeof req.query.scope === "string" ? req.query.scope.trim() : "company";
  if (!VALID_SCOPES.has(scope)) {
    res.status(400).json({ error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` });
    return;
  }

  const scopeId =
    scope !== "company" && typeof req.query.scopeId === "string" && req.query.scopeId.trim()
      ? req.query.scopeId.trim()
      : undefined;

  if (scope !== "company" && !scopeId) {
    res.status(400).json({ error: "scopeId is required when scope is 'head' or 'customer'" });
    return;
  }

  const monthFrom = intParam(req, "monthFrom", 1, 12, 1);
  const monthTo   = intParam(req, "monthTo", monthFrom, 12, 12);
  const monthLabels = fiscalMonthsToLabels(fy, monthFrom, monthTo);

  try {
    const result = await getSkuRecommendations({
      fy,
      monthLabels,
      level: level as SkuLevel,
      scope: scope as SkuScope,
      scopeId,
    });
    res.json({ fy, monthFrom, monthTo, level, scope, scopeId: scopeId ?? null, ...result });
  } catch (err) {
    req.log.error({ err, fy, level }, "sku recommendations failed");
    res.status(500).json({ error: "Could not load SKU recommendations." });
  }
});

// ── GET /api/sku/distributors ─────────────────────────────────────────────────
//
// Returns all non-project distributors for the given level + active FY,
// enriched with their FY2025-26 cohort quintile.  Used to populate the Push
// tab selector.
//
// Query params:
//   fy     (required)  active FY for discovering newly-onboarded distributors
//   level  (optional)  distributor (default) | direct_dealer

router.get("/sku/distributors", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";
  const level = typeof req.query.level === "string" ? req.query.level.trim() : "distributor";
  if (!VALID_LEVELS.has(level)) {
    res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(", ")}` });
    return;
  }
  try {
    const list = await getDistributorList(fy, level as SkuLevel);
    res.json({ fy, level, count: list.length, distributors: list });
  } catch (err) {
    req.log.error({ err, fy, level }, "sku distributors failed");
    res.status(500).json({ error: "Could not load distributor list." });
  }
});

// ── GET /api/sku/push-list ────────────────────────────────────────────────────
//
// Per-distributor peer-cohort push list.  Returns gap codes that ≥ 3 peers
// are buying in the query period but the target distributor is not.
//
// Query params:
//   fy              (required)  e.g. 2026-27
//   level           (optional)  distributor (default)
//   monthFrom       (optional)  1–12, default 1
//   monthTo         (optional)  monthFrom–12, default 12
//   distributorKey  (required)  exact customer name from sale_line_current

router.get("/sku/push-list", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";
  const level = typeof req.query.level === "string" ? req.query.level.trim() : "distributor";
  if (!VALID_LEVELS.has(level)) {
    res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(", ")}` });
    return;
  }
  const distributorKey =
    typeof req.query.distributorKey === "string" && req.query.distributorKey.trim()
      ? req.query.distributorKey.trim()
      : null;
  if (!distributorKey) {
    res.status(400).json({ error: "distributorKey is required" });
    return;
  }
  const monthFrom = intParam(req, "monthFrom", 1, 12, 1);
  const monthTo   = intParam(req, "monthTo", monthFrom, 12, 12);
  const monthLabels = fiscalMonthsToLabels(fy, monthFrom, monthTo);
  try {
    const result = await getSkuPushList({
      fy,
      monthLabels,
      level: level as SkuLevel,
      distributorKey,
    });

    // K4 enrichment: segment peak quarter + discount-above-norm flags.
    try {
      const peakMap = await getPeakQuarterMap();
      const allCodes = new Set<string>();
      for (const seg of result.segments ?? []) {
        for (const c of seg.topCodes ?? []) allCodes.add(c.code);
      }
      const flags = await getDiscountNormFlags(fy, [...allCodes], monthLabels);

      // Season-aware ranking: a salesperson works the list TODAY, so segments
      // whose season is now (or next quarter) lead; Q-far segments are kept but
      // labelled as groundwork for their peak. Current fiscal quarter from the
      // server date (Q1 = Apr–Jun … Q4 = Jan–Mar).
      const nowMonth = new Date().getMonth() + 1; // 1-12
      const currentQuarter = Math.floor(((nowMonth + 8) % 12) / 3) + 1;
      const QUARTER_LABELS = ["Q1 (Apr–Jun)", "Q2 (Jul–Sep)", "Q3 (Oct–Dec)", "Q4 (Jan–Mar)"];
      // Most of the catalogue peaks Q4, so peak quarter alone is degenerate as
      // a ranking signal. Instead use the segment's revenue share in the
      // CURRENT quarter (its 3-closed-year seasonal curve): ≥27% = in season
      // now (flat baseline is 25%); peak-next-quarter = build now; else the
      // segment is groundwork for its later peak.
      const seasonality = await getSeasonality();
      const curveBySeg = new Map(seasonality.segments.map((s) => [s.segment, s]));
      for (const seg of result.segments ?? []) {
        const peak = peakMap.get(seg.segment);
        const curve = curveBySeg.get(seg.segment);
        const curShare = curve ? curve.quarterShare[currentQuarter - 1] : null;
        (seg as Record<string, unknown>).peakQuarter = peak?.peakQuarter ?? null;
        (seg as Record<string, unknown>).peakQuarterLabel = peak?.peakQuarterLabel ?? null;
        (seg as Record<string, unknown>).peakQuarterShare = peak?.quarterShare ?? null;
        (seg as Record<string, unknown>).currentQuarterShare = curShare;
        const peakQ = peak?.peakQuarter ?? null;
        const rank =
          peakQ == null || curShare == null
            ? 1
            : peakQ === currentQuarter || curShare >= 0.27
              ? 0
              : peakQ === (currentQuarter % 4) + 1
                ? 1
                : 2;
        (seg as Record<string, unknown>).seasonRank = rank;
        (seg as Record<string, unknown>).seasonStatus =
          rank === 0 ? "in_season" : rank === 1 ? "next_quarter" : "groundwork";
        (seg as Record<string, unknown>).seasonNote =
          peak == null || curShare == null
            ? "No seasonality baseline for this segment."
            : rank === 0
              ? `In season now — ${(curShare * 100).toFixed(0)}% of this segment's year lands in ${QUARTER_LABELS[currentQuarter - 1]} (peak ${peak.peakQuarterLabel}).`
              : rank === 1
                ? `Season builds next quarter (peak ${peak.peakQuarterLabel}) — place listings now.`
                : `Groundwork — only ${(curShare * 100).toFixed(0)}% of this segment's year lands in ${QUARTER_LABELS[currentQuarter - 1]}; peak is ${peak.peakQuarterLabel}. Placements made now pay off then.`;
        for (const c of seg.topCodes ?? []) {
          const f = flags.get(c.code);
          (c as Record<string, unknown>).discountAboveNorm = f
            ? {
                currentPct: Math.round(f.currentAvgDiscount * 1000) / 10,
                normPct: Math.round(f.normAvgDiscount * 1000) / 10,
                aboveNormPts: Math.round(f.aboveNormPts * 10) / 10,
              }
            : null;
        }
      }
      // Stable re-rank: in-season first, then next-quarter, then groundwork;
      // the underlying gap-value order is preserved within each band.
      if (Array.isArray(result.segments)) {
        result.segments = result.segments
          .map((seg, i) => ({ seg, i }))
          .sort((a, b) => {
            const ra = ((a.seg as Record<string, unknown>).seasonRank as number) ?? 1;
            const rb = ((b.seg as Record<string, unknown>).seasonRank as number) ?? 1;
            if (ra !== rb) return ra - rb;
            const sa = ((a.seg as Record<string, unknown>).currentQuarterShare as number) ?? 0;
            const sb = ((b.seg as Record<string, unknown>).currentQuarterShare as number) ?? 0;
            return sb - sa || a.i - b.i;
          })
          .map((x) => x.seg);
      }
      (result as Record<string, unknown>).seasonContext = {
        currentQuarter,
        currentQuarterLabel: QUARTER_LABELS[currentQuarter - 1],
        note: "Segments are ordered season-first: in-season, next-quarter, then groundwork for a later peak. Within each band, segments doing more of their year in the current quarter come first.",
      };
    } catch (err) {
      req.log.warn({ err }, "sku push-list K4 enrichment failed — serving base list");
    }

    res.json({ fy, monthFrom, monthTo, level, ...result });
  } catch (err) {
    req.log.error({ err, fy, level, distributorKey }, "sku push-list failed");
    res.status(500).json({ error: "Could not load SKU push list." });
  }
});

// ── K4: Discounts ─────────────────────────────────────────────────────────────
// Two SEPARATE measures, never merged: primary (MRP discount, sale_line) and
// secondary (register Discount column, closed years only).

router.get("/sku/discounts", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";
  const channel = req.query.channel === "project" ? "project" : "territory";
  const monthFrom = intParam(req, "monthFrom", 1, 12, 0);
  const monthTo = intParam(req, "monthTo", monthFrom || 1, 12, 0);
  const monthLabels =
    monthFrom >= 1 && monthTo >= monthFrom ? fiscalMonthsToLabels(fy, monthFrom, monthTo) : null;
  try {
    const [primary, secondary, blocked] = await Promise.all([
      getPrimaryDiscountByCode(fy, channel, monthLabels),
      getSecondaryDiscountByCode(fy),
      getBlockedCapabilities(),
    ]);
    res.json({ fy, channel, primary, secondary, blocked });
  } catch (err) {
    req.log.error({ err, fy }, "sku discounts failed");
    res.status(500).json({ error: "Could not compute SKU discounts." });
  }
});

// ── K4: Seasonality per segment ───────────────────────────────────────────────

router.get("/sku/seasonality", async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getSeasonality());
  } catch (err) {
    req.log.error({ err }, "sku seasonality failed");
    res.status(500).json({ error: "Could not compute seasonality." });
  }
});

// ── K4: Breadth trend (largest narrowers by value) ────────────────────────────

router.get("/sku/breadth-trend", async (req: Request, res: Response): Promise<void> => {
  const latestFy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2025-26";
  const priorFy = prevFy(latestFy);
  try {
    res.json(await getBreadthTrend(latestFy, priorFy));
  } catch (err) {
    req.log.error({ err, latestFy }, "sku breadth-trend failed");
    res.status(500).json({ error: "Could not compute breadth trend." });
  }
});

// ── K4: First-order codes ─────────────────────────────────────────────────────

router.get("/sku/first-orders", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";
  const monthFrom = intParam(req, "monthFrom", 1, 12, 0);
  const monthTo = intParam(req, "monthTo", monthFrom || 1, 12, 0);
  const monthLabels =
    monthFrom >= 1 && monthTo >= monthFrom ? fiscalMonthsToLabels(fy, monthFrom, monthTo) : null;
  const customer =
    typeof req.query.customer === "string" && req.query.customer.trim()
      ? req.query.customer.trim()
      : null;
  try {
    res.json(await getFirstOrderCodes(fy, monthLabels, customer));
  } catch (err) {
    req.log.error({ err, fy }, "sku first-orders failed");
    res.status(500).json({ error: "Could not compute first-order codes." });
  }
});

// ── K4: Lost codes ────────────────────────────────────────────────────────────

router.get("/sku/lost-codes", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
      ? req.query.fy.trim()
      : "2026-27";
  const priorFy = prevFy(fy);
  try {
    res.json(await getLostCodes(fy, priorFy));
  } catch (err) {
    req.log.error({ err, fy }, "sku lost-codes failed");
    res.status(500).json({ error: "Could not compute lost codes." });
  }
});

// ── K4: secondary SKU backfill trigger (runs in-process; shell-run CLIs get
// reaped by the environment). Fire-and-forget; poll GET for status.

const _skuBackfill: { running: boolean; log: string[] } = { running: false, log: [] };

const BACKFILL_ALLOWED_FYS = new Set(["2023-24", "2024-25", "2025-26"]);

router.post("/sku/secondary-backfill", async (req: Request, res: Response): Promise<void> => {
  // Deliberate-action guard, matching the frozen-register convention:
  // requires ?confirm=true&reason=<text>. FYs are allowlisted to the three
  // closed years with configured SKU sheets — nothing else is loadable.
  if (req.query.confirm !== "true" || typeof req.query.reason !== "string" || !req.query.reason.trim()) {
    res.status(423).json({
      error: "secondary backfill requires ?confirm=true&reason=<text> (deliberate action guard)",
    });
    return;
  }
  if (_skuBackfill.running) {
    res.status(409).json({ error: "backfill already running", log: _skuBackfill.log });
    return;
  }
  const fys = (
    typeof req.query.fys === "string" && req.query.fys.trim()
      ? req.query.fys.split(",").map((s) => s.trim())
      : [...BACKFILL_ALLOWED_FYS]
  ).filter((f) => BACKFILL_ALLOWED_FYS.has(f));
  if (fys.length === 0) {
    res.status(400).json({ error: `fys must be from: ${[...BACKFILL_ALLOWED_FYS].join(", ")}` });
    return;
  }
  req.log.info({ fys, reason: req.query.reason }, "sku secondary backfill triggered");
  _skuBackfill.running = true;
  _skuBackfill.log = [`started ${new Date().toISOString()} for ${fys.join(", ")}`];
  void (async () => {
    const { loadSecSkuFromSheets, SKU_SHEET_IDS: sheetIds } = await import(
      "../lib/secondary/skuLoader.js"
    );
    for (const fy of fys) {
      try {
        const sheetId = sheetIds[fy];
        if (!sheetId) {
          _skuBackfill.log.push(`${fy}: no SKU sheet configured — skipped`);
          continue;
        }
        const r = await loadSecSkuFromSheets(fy, sheetId, false);
        _skuBackfill.log.push(
          `${fy}: parsed=${r.rowsParsed} inserted=${r.rowsInserted} tabs=${r.tabsWithItemCodes}/${r.tabs}`,
        );
      } catch (err) {
        _skuBackfill.log.push(`${fy}: FAILED — ${String(err)}`);
      }
    }
    _skuBackfill.log.push(`done ${new Date().toISOString()}`);
    _skuBackfill.running = false;
    clearK4Cache();
  })();
  res.json({ started: true, fys });
});

router.get("/sku/secondary-backfill", (_req: Request, res: Response): void => {
  res.json(_skuBackfill);
});

function prevFy(fy: string): string {
  const start = parseInt(fy.split("-")[0], 10) - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export default router;
