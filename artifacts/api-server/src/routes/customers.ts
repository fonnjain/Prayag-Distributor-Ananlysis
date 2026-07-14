// Customer Performance API routes.
//
// All analytics lead with QUANTITY (pcs). Realized price = Value / Qty.
// Primary (distributor/dealer) and secondary (retailer) are never blended.
import { Router } from "express";
import {
  listCustomers,
  getCustomerCategories,
  getCustomerProducts,
  getAtRisk,
  getNewCustomers,
  getPriceShrinkers,
  getCustomerHistory,
  getAvailableMonths,
  getCompleteMonths,
  toLyMonths,
  calcPctElapsed,
  SEASONAL_TOTAL,
  getDistributorRisk,
  type EntityType,
} from "../lib/customers/analytics.js";
import {
  ensureRegisterSynced,
  getRegisterSyncState,
  getLastSyncedAt,
} from "../lib/customers/registerSync.js";
import { computeAllMultipliers } from "../lib/customers/laspeyres.js";
import {
  listSchemes,
  getScheme,
  createScheme,
  updateScheme,
  deleteScheme,
  computeSchemeTracking,
  getPushList,
} from "../lib/customers/schemes.js";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseMonthList(val: unknown): string[] {
  if (typeof val !== "string" || !val) return [];
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseEntityType(val: unknown): EntityType {
  const valid: EntityType[] = ["all", "distributor", "direct_dealer", "retailer"];
  return valid.includes(val as EntityType) ? (val as EntityType) : "all";
}

// ── Available months for a FY ──────────────────────────────────────────────────

router.get("/customers/months", async (req, res) => {
  const fy = req.query.fy as string;
  if (!fy) {
    res.status(400).json({ error: "fy is required" });
    return;
  }
  try {
    const [months, completeMonths] = await Promise.all([
      getAvailableMonths(fy),
      getCompleteMonths(fy),
    ]);
    if (months.length === 0) {
      // Trigger a background sync if one is not already in progress.
      ensureRegisterSynced(fy);
    }
    const sync = getRegisterSyncState(fy);
    const syncing = months.length === 0 && sync.phase === "syncing";
    const syncError =
      months.length === 0 && sync.phase === "error" ? sync.error : undefined;
    res.json({
      fy,
      months,
      completeMonths,
      syncing,
      syncError,
      lastSyncedAt: getLastSyncedAt(fy),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch months" });
  }
});

// ── Customer rankings with YoY ─────────────────────────────────────────────────

router.get("/customers/performance", async (req, res) => {
  const fyCy = (req.query.fyCy as string) || "2026-27";
  const fyLy = (req.query.fyLy as string) || "2025-26";
  const monthsCyParam = parseMonthList(req.query.monthsCy);
  const entityType = parseEntityType(req.query.entityType);

  let monthsCy = monthsCyParam;
  let monthsLy: string[];

  try {
    // If no months specified, use all available months for the CY
    if (!monthsCy.length) {
      monthsCy = await getAvailableMonths(fyCy);
    }
    monthsLy = parseMonthList(req.query.monthsLy) || toLyMonths(monthsCy);
    if (!monthsLy.length) monthsLy = toLyMonths(monthsCy);

    const rows = await listCustomers({ fyCy, fyLy, monthsCy, monthsLy, entityType });
    const elapsed = calcPctElapsed(monthsCy);
    const projectFactor = elapsed > 0 ? SEASONAL_TOTAL / elapsed : null;
    res.json({
      fyCy, fyLy, monthsCy, monthsLy, entityType, data: rows,
      seasonalProjection: {
        completedMonths: monthsCy,
        pctElapsed: Math.round(elapsed * 10) / 10,
        projectFactor: projectFactor != null ? Math.round(projectFactor * 100) / 100 : null,
      },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch customer performance" });
  }
});

// ── Customer detail — categories then products ─────────────────────────────────

router.get("/customers/detail", async (req, res) => {
  const customer = req.query.customer as string;
  if (!customer) {
    res.status(400).json({ error: "customer is required" });
    return;
  }
  const fyCy = (req.query.fyCy as string) || "2026-27";
  const fyLy = (req.query.fyLy as string) || "2025-26";
  const monthsCyParam = parseMonthList(req.query.monthsCy);
  const category = req.query.category as string | undefined;

  try {
    let monthsCy = monthsCyParam;
    if (!monthsCy.length) monthsCy = await getAvailableMonths(fyCy);
    const monthsLy = parseMonthList(req.query.monthsLy) || toLyMonths(monthsCy);

    if (category) {
      // Product-level drill
      const products = await getCustomerProducts({ customer, category, fyCy, fyLy, monthsCy, monthsLy });
      res.json({ customer, fyCy, fyLy, monthsCy, monthsLy, category, level: "product", data: products });
    } else {
      // Category-level
      const categories = await getCustomerCategories({ customer, fyCy, fyLy, monthsCy, monthsLy });
      res.json({ customer, fyCy, fyLy, monthsCy, monthsLy, level: "category", data: categories });
    }
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch customer detail" });
  }
});

// ── Multi-year history for a customer ─────────────────────────────────────────

router.get("/customers/history", async (req, res) => {
  const customer = req.query.customer as string;
  if (!customer) {
    res.status(400).json({ error: "customer is required" });
    return;
  }
  const fys = parseMonthList(req.query.fys); // comma-separated FYs
  const monthFilter = parseMonthList(req.query.monthNames); // e.g. "Apr,May,Jun"

  if (!fys.length) {
    res.status(400).json({ error: "fys is required (comma-separated list of fiscal years)" });
    return;
  }

  try {
    const history = await getCustomerHistory({ customer, fys, monthFilter: monthFilter.length ? monthFilter : undefined });
    res.json({ customer, fys, history });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch customer history" });
  }
});

// ── At-risk scoring + new customers ────────────────────────────────────────────
//
// "Churned" (binary) is replaced by at-risk scoring: customers are scored
// against their own historical median inter-order gap. Seasonal buyers whose
// normal gap is longer than the current period are not flagged.

router.get("/customers/churn", async (req, res) => {
  const fyCy = (req.query.fyCy as string) || "2026-27";
  const fyLy = (req.query.fyLy as string) || "2025-26";
  const monthsCyParam = parseMonthList(req.query.monthsCy);
  const entityType = parseEntityType(req.query.entityType);

  try {
    let monthsCy = monthsCyParam;
    if (!monthsCy.length) monthsCy = await getAvailableMonths(fyCy);
    const monthsLy = parseMonthList(req.query.monthsLy) || toLyMonths(monthsCy);

    const [atRisk, newCustomers] = await Promise.all([
      getAtRisk({ entityType }),
      getNewCustomers({ fyCy, fyLy, monthsCy, monthsLy, entityType }),
    ]);
    res.json({ fyCy, fyLy, monthsCy, monthsLy, atRisk, newCustomers });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch at-risk data" });
  }
});

// ── Revenue-up, volume-down flag list ──────────────────────────────────────────

router.get("/customers/shrinkers", async (req, res) => {
  const fyCy = (req.query.fyCy as string) || "2026-27";
  const fyLy = (req.query.fyLy as string) || "2025-26";
  const monthsCyParam = parseMonthList(req.query.monthsCy);
  const entityType = parseEntityType(req.query.entityType);
  const grainRaw = req.query.grain as string;
  const grain =
    grainRaw === "category" || grainRaw === "product"
      ? grainRaw
      : "customer";

  try {
    let monthsCy = monthsCyParam;
    if (!monthsCy.length) monthsCy = await getAvailableMonths(fyCy);
    const monthsLy = parseMonthList(req.query.monthsLy) || toLyMonths(monthsCy);

    const shrinkers = await getPriceShrinkers({
      fyCy,
      fyLy,
      monthsCy,
      monthsLy,
      grain: grain as "customer" | "category" | "product",
      entityType,
    });
    res.json({ fyCy, fyLy, monthsCy, monthsLy, grain, data: shrinkers });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch price shrinkers" });
  }
});

// ── Laspeyres price multipliers ────────────────────────────────────────────────

router.get("/customers/multiplier", async (req, res) => {
  const fyLy = (req.query.fyLy as string) || "2025-26";
  const fyCy = (req.query.fyCy as string) || "2026-27";

  try {
    const result = await computeAllMultipliers(fyLy, fyCy);
    res.json({ fyLy, fyCy, ...result });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to compute multipliers" });
  }
});

// ── Schemes CRUD ───────────────────────────────────────────────────────────────

router.get("/customers/schemes", async (req, res) => {
  try {
    const schemes = await listSchemes();
    res.json({ schemes });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to list schemes" });
  }
});

router.post("/customers/schemes", async (req, res) => {
  const { slabs, ...schemeInput } = req.body as { slabs?: unknown[]; [k: string]: unknown };
  try {
    const scheme = await createScheme(
      schemeInput as Parameters<typeof createScheme>[0],
      (slabs ?? []) as Parameters<typeof createScheme>[1],
    );
    res.status(201).json(scheme);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Failed to create scheme" });
  }
});

router.get("/customers/schemes/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const scheme = await getScheme(id);
    if (!scheme) { res.status(404).json({ error: "Not found" }); return; }
    res.json(scheme);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to fetch scheme" });
  }
});

router.put("/customers/schemes/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { slabs, ...input } = req.body as { slabs?: unknown[]; [k: string]: unknown };
  try {
    const updated = await updateScheme(
      id,
      input as Parameters<typeof updateScheme>[1],
      slabs as Parameters<typeof updateScheme>[2],
    );
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Failed to update scheme" });
  }
});

router.delete("/customers/schemes/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const ok = await deleteScheme(id);
    if (!ok) { res.status(404).json({ error: "Not found" }); return; }
    res.status(204).send();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to delete scheme" });
  }
});

// ── Scheme tracking + push list ────────────────────────────────────────────────

router.get("/customers/schemes/:id/tracking", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const tracking = await computeSchemeTracking(id);
    res.json({ schemeId: id, tracking });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to compute tracking" });
  }
});

router.get("/customers/schemes/:id/push-list", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const pushList = await getPushList(id);
    res.json({ schemeId: id, pushList });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to compute push list" });
  }
});

// ── Distributor scheme-risk ────────────────────────────────────────────────────

router.get("/customers/distributor-risk", async (req, res) => {
  const fyCy = typeof req.query.fyCy === "string" ? req.query.fyCy : "2026-27";
  const fyLy = typeof req.query.fyLy === "string" ? req.query.fyLy : "2025-26";
  ensureRegisterSynced(fyCy);
  ensureRegisterSynced(fyLy);
  const monthsCy = parseMonthList(req.query.monthsCy);
  const monthsLy = parseMonthList(req.query.monthsLy);

  if (!monthsCy.length || !monthsLy.length) {
    res.json({ rows: [], summary: { total: 0, onTrack: 0, atRisk: 0, zeroBuyers: 0, atRiskRevenue: 0, zeroBuyerRevenue: 0 } });
    return;
  }

  try {
    const rows = await getDistributorRisk({ fyCy, fyLy, monthsCy, monthsLy });
    const summary = {
      total: rows.length,
      onTrack: rows.filter((r) => r.status === "on_track").length,
      atRisk: rows.filter((r) => r.status === "at_risk").length,
      zeroBuyers: rows.filter((r) => r.status === "zero").length,
      atRiskRevenue: rows.filter((r) => r.status !== "on_track").reduce((s, r) => s + r.lyVal, 0),
      zeroBuyerRevenue: rows.filter((r) => r.status === "zero").reduce((s, r) => s + r.lyVal, 0),
    };
    res.json({ rows, summary });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to compute distributor risk" });
  }
});

export default router;
