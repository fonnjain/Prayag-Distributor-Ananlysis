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
import { loadSkuFacts, getSkuCapability } from "../lib/sku/skuFacts.js";
import { getCatalogueCounts } from "../lib/sku/catalogue.js";
import { fiscalMonthsToLabels } from "../lib/mgmt/primaryPeriod.js";

const router = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const VALID_LEVELS = new Set(["distributor", "direct_dealer", "retailer"]);
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
      level: level as "distributor" | "direct_dealer" | "retailer",
      scope: scope as "company" | "head" | "customer",
      scopeId,
      monthLabels,
      segment,
    });

    const catalogue = await getCatalogueCounts();

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
      capability: result.capability,
      catalogue: {
        bySegment: catalogue.bySegment,
        mappedCodes: catalogue.mappedCodes,
        unmappedCodes: catalogue.unmappedCount,
        totalCodes: catalogue.totalCodes,
      },
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

router.get("/sku/catalogue", async (_req: Request, res: Response): Promise<void> => {
  try {
    const cat = await getCatalogueCounts();
    res.json({
      bySegment: cat.bySegment,
      mappedCodes: cat.mappedCodes,
      unmappedCodes: cat.unmappedCount,
      totalCodes: cat.totalCodes,
      note: "Derived from item_master.item_group via group_map.json. Never hardcoded.",
    });
  } catch (err) {
    res.status(500).json({ error: "Could not compute catalogue counts." });
  }
});

export default router;
