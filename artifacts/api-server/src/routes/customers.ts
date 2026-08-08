// Customer Performance API routes.
//
// All analytics lead with QUANTITY (pcs). Realized price = Value / Qty.
// Primary (distributor/dealer) and secondary (retailer) are never blended.
import { Router } from "express";
import ExcelJS from "exceljs";
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
  isFrozen,
} from "../lib/customers/registerSync.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import {
  hasEntityFilterValues,
  resolvePriorEntityFilter,
  type EntityFilter,
} from "../lib/saleLineFilter.js";
import { parseJsonArray } from "./companyReports.js";
import { computeAllMultipliers } from "../lib/customers/laspeyres.js";
import { getSplit } from "../lib/headSplits.js";
import { currentOpenFy, deriveSaleLineCohortFy } from "../lib/fyAnchors.js";
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

// Snapshot TTL for heavy customer analytics payloads (default page-load
// variants only — filtered variants stay live to keep the key space bounded).
const CUSTOMERS_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseMonthList(val: unknown): string[] {
  if (typeof val !== "string" || !val) return [];
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseEntityType(val: unknown): EntityType {
  const valid: EntityType[] = ["all", "distributor", "direct_dealer", "retailer"];
  return valid.includes(val as EntityType) ? (val as EntityType) : "all";
}

const FY_PATTERN = /^\d{4}-\d{2}$/;

// Shared State Head / State / Distributor filter (same JSON-array params the
// Products / Growth pages use). Returns undefined when no filter is active.
function parseEntityFilter(req: import("express").Request): EntityFilter | undefined {
  const filter: EntityFilter = {
    heads: parseJsonArray(req.query.heads),
    states: parseJsonArray(req.query.states),
    customers: parseJsonArray(req.query.customers),
  };
  return hasEntityFilterValues(filter) ? filter : undefined;
}

function sameMonths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.join(",") === b.join(",");
}

// True when the requested CY/LY month lists are a logical default for the FY
// pair: either all *complete* CY months (what the UI's "All complete months"
// preset sends explicitly on first page load) or all *available* CY months
// (what an omitted parameter falls back to) — each with its LY counterparts.
// The UI sends months explicitly even on first page load, so "default
// variant" must be detected by value, not by absence of the parameter.
function isDefaultMonthSelection(
  monthsCy: string[],
  monthsLy: string[],
  defaults: string[][],
): boolean {
  return defaults.some(
    (d) => d.length > 0 && sameMonths(monthsCy, d) && sameMonths(monthsLy, toLyMonths(d)),
  );
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

  const monthsLyParam = parseMonthList(req.query.monthsLy);
  const entityFilter = parseEntityFilter(req);

  // Legacy filters: `states` (comma-separated raw state_canon values) and
  // `head` (exact head_canon). The shared filter bar reuses the `states` query
  // param but sends a JSON array, so when the shared filter is active the
  // legacy interpretation MUST be disabled — otherwise `states=["DELHI"]`
  // would also be applied verbatim to sl.state_canon and match nothing.
  const statesParam = req.query.states as string | undefined;
  const states =
    !entityFilter && statesParam
      ? statesParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const head = entityFilter ? "" : ((req.query.head as string | undefined) ?? "");

  try {
    // If no months specified, use all available months for the CY
    const [availableCy, completeCy] = await Promise.all([
      getAvailableMonths(fyCy),
      getCompleteMonths(fyCy),
    ]);
    const monthsCy = monthsCyParam.length ? monthsCyParam : availableCy;
    const monthsLy = monthsLyParam.length ? monthsLyParam : toLyMonths(monthsCy);

    // LY side of head/state filters resolves to the CURRENT-FY customer set
    // (heads/states move between FYs; see resolvePriorEntityFilter).
    const filterLy = entityFilter
      ? await resolvePriorEntityFilter(fyCy, entityFilter)
      : undefined;

    const build = async (): Promise<Record<string, unknown>> => {
    const rows = await listCustomers({
      fyCy, fyLy, monthsCy, monthsLy, entityType, states, head,
      filterCy: entityFilter, filterLy,
    });
    const elapsed = calcPctElapsed(monthsCy);
    const projectFactor = elapsed > 0 ? SEASONAL_TOTAL / elapsed : null;

    // Detect cross-FY head_canon key split.  When the head parameter names a
    // territory manager whose head_canon changed between fyLy and fyCy, the LY
    // filter in listCustomers returns zero rows — a false 100%-loss signal.
    // The caller should suppress the LY panel rather than display zeros.
    const headYoySplit = head ? getSplit(head, fyCy, fyLy) : null;

    return {
      fyCy, fyLy, monthsCy, monthsLy, entityType, filtered: !!entityFilter, data: rows,
      headYoySplit: headYoySplit
        ? { priorCanon: headYoySplit.priorCanon, splitFromFy: headYoySplit.splitFromFy }
        : null,
      seasonalProjection: {
        completedMonths: monthsCy,
        pctElapsed: Math.round(elapsed * 10) / 10,
        projectFactor: projectFactor != null ? Math.round(projectFactor * 100) / 100 : null,
      },
    };
    };

    // Snapshot-first for the default page-load variant only: valid FY pair,
    // no state/head filters, and the month lists equal the logical default
    // (all available CY months + LY counterparts) whether sent explicitly or
    // omitted. Filtered variants stay live so the key space stays bounded.
    const isDefaultVariant =
      FY_PATTERN.test(fyCy) &&
      FY_PATTERN.test(fyLy) &&
      states.length === 0 &&
      !head &&
      !entityFilter &&
      isDefaultMonthSelection(monthsCy, monthsLy, [completeCy, availableCy]);
    const payload = isDefaultVariant
      ? await serveWithSnapshot({
          key: `customers-performance|${fyCy}|${fyLy}|${entityType}`,
          ttlMs: CUSTOMERS_SNAPSHOT_TTL_MS,
          build,
          log: req.log,
          frozen: isFrozen(fyCy) && isFrozen(fyLy),
        })
      : await build();
    res.json(payload);
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

  const monthsLyParam = parseMonthList(req.query.monthsLy);
  const entityFilter = parseEntityFilter(req);

  try {
    const [availableCy, completeCy] = await Promise.all([
      getAvailableMonths(fyCy),
      getCompleteMonths(fyCy),
    ]);
    const monthsCy = monthsCyParam.length ? monthsCyParam : availableCy;
    const monthsLy = monthsLyParam.length ? monthsLyParam : toLyMonths(monthsCy);

    const filterLy = entityFilter
      ? await resolvePriorEntityFilter(fyCy, entityFilter)
      : undefined;

    const build = async (): Promise<Record<string, unknown>> => {
      const [atRisk, newCustomers] = await Promise.all([
        // At-risk scoring spans all FYs, so it scopes by the resolved
        // current-FY customer set rather than raw head/state columns.
        getAtRisk({ entityType, filter: filterLy }),
        getNewCustomers({
          fyCy, fyLy, monthsCy, monthsLy, entityType,
          filterCy: entityFilter, filterLy,
        }),
      ]);
      return { fyCy, fyLy, monthsCy, monthsLy, filtered: !!entityFilter, atRisk, newCustomers };
    };

    const isDefaultVariant =
      FY_PATTERN.test(fyCy) &&
      FY_PATTERN.test(fyLy) &&
      !entityFilter &&
      isDefaultMonthSelection(monthsCy, monthsLy, [completeCy, availableCy]);
    // At-risk scoring depends on "days since last order", so churn snapshots
    // are never served as final (no frozen flag) — the background refresh
    // keeps the recency-based figures current.
    const payload = isDefaultVariant
      ? await serveWithSnapshot({
          key: `customers-churn|${fyCy}|${fyLy}|${entityType}`,
          ttlMs: CUSTOMERS_SNAPSHOT_TTL_MS,
          build,
          log: req.log,
        })
      : await build();
    res.json(payload);
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

  const monthsLyParam = parseMonthList(req.query.monthsLy);
  const entityFilter = parseEntityFilter(req);

  try {
    const [availableCy, completeCy] = await Promise.all([
      getAvailableMonths(fyCy),
      getCompleteMonths(fyCy),
    ]);
    const monthsCy = monthsCyParam.length ? monthsCyParam : availableCy;
    const monthsLy = monthsLyParam.length ? monthsLyParam : toLyMonths(monthsCy);

    const filterLy = entityFilter
      ? await resolvePriorEntityFilter(fyCy, entityFilter)
      : undefined;

    const build = async (): Promise<Record<string, unknown>> => {
      const shrinkers = await getPriceShrinkers({
        fyCy,
        fyLy,
        monthsCy,
        monthsLy,
        grain: grain as "customer" | "category" | "product",
        entityType,
        filterCy: entityFilter,
        filterLy,
      });
      return { fyCy, fyLy, monthsCy, monthsLy, grain, filtered: !!entityFilter, data: shrinkers };
    };

    const isDefaultVariant =
      FY_PATTERN.test(fyCy) &&
      FY_PATTERN.test(fyLy) &&
      !entityFilter &&
      isDefaultMonthSelection(monthsCy, monthsLy, [completeCy, availableCy]);
    const payload = isDefaultVariant
      ? await serveWithSnapshot({
          key: `customers-shrinkers|${fyCy}|${fyLy}|${entityType}|${grain}`,
          ttlMs: CUSTOMERS_SNAPSHOT_TTL_MS,
          build,
          log: req.log,
          frozen: isFrozen(fyCy) && isFrozen(fyLy),
        })
      : await build();
    res.json(payload);
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

// ── Excel export — customer rankings ──────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_EXPORT_ROWS_PER_SHEET = 20_000;
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

router.get("/customers/export", async (req, res) => {
  const fyCy = (req.query.fyCy as string) || "2026-27";
  const fyLy = (req.query.fyLy as string) || "2025-26";
  if (!FY_PATTERN.test(fyCy) || !FY_PATTERN.test(fyLy)) {
    res.status(400).json({ error: "Invalid fyCy/fyLy — expected YYYY-YY" });
    return;
  }
  const monthsCyParam = parseMonthList(req.query.monthsCy);
  const monthsLyParam = parseMonthList(req.query.monthsLy);
  const entityType = parseEntityType(req.query.entityType);
  const entityFilter = parseEntityFilter(req);

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const availableCy = await getAvailableMonths(fyCy);
    const monthsCy = monthsCyParam.length ? monthsCyParam : availableCy;
    const monthsLy = monthsLyParam.length ? monthsLyParam : toLyMonths(monthsCy);
    const filterLy = entityFilter
      ? await resolvePriorEntityFilter(fyCy, entityFilter)
      : undefined;

    const rows = await listCustomers({
      fyCy, fyLy, monthsCy, monthsLy, entityType,
      filterCy: entityFilter, filterLy,
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    // Cover sheet — basis + active filters, so a filtered file is
    // self-describing and never mistaken for unfiltered company totals.
    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 26 }, { width: 95 }];
    const infoRows: Array<[string, string]> = [
      ["Page", `Customer Performance — FY ${fyCy} vs ${fyLy} primary sales by customer (sale_line register)`],
      ["FY (current)", fyCy],
      ["FY (compare)", fyLy],
      ["Months (current)", monthsCy.join(", ") || "All"],
      ["Months (compare)", monthsLy.join(", ") || "All"],
      ["Entity type", entityType],
      ["State Head filter", entityFilter?.heads?.length ? entityFilter.heads.join(", ") : "All"],
      ["State filter", entityFilter?.states?.length ? entityFilter.states.join(", ") : "All"],
      ["Distributor filter", entityFilter?.customers?.length ? entityFilter.customers.join(", ") : "All"],
      ["Note", "Quantity leads (pcs); realized price = value / qty. Prior-FY figures for head/state filters use the current-FY customer set."],
    ];
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    const ws = wb.addWorksheet("Rankings");
    const columns = [
      { header: "Customer", key: "customer", width: 42 },
      { header: "Type", key: "entityType", width: 14 },
      { header: "State", key: "state", width: 18 },
      { header: `Qty ${fyCy}`, key: "qtyCy", width: 12 },
      { header: `Qty ${fyLy}`, key: "qtyLy", width: 12 },
      { header: `Value ${fyCy} (INR)`, key: "valCy", width: 16 },
      { header: `Value ${fyLy} (INR)`, key: "valLy", width: 16 },
      { header: "Qty growth %", key: "qtyGrowthPct", width: 13 },
      { header: "Value growth %", key: "valGrowthPct", width: 14 },
      { header: `Realized price ${fyCy}`, key: "priceCy", width: 17 },
      { header: `Realized price ${fyLy}`, key: "priceLy", width: 17 },
    ];
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
    });
    const truncated = rows.length > MAX_EXPORT_ROWS_PER_SHEET;
    for (const r of rows.slice(0, MAX_EXPORT_ROWS_PER_SHEET)) {
      ws.addRow(columns.map((c) => (r as unknown as Record<string, unknown>)[c.key] ?? ""));
    }
    if (truncated) {
      const row = ws.addRow([`… truncated: showing ${MAX_EXPORT_ROWS_PER_SHEET.toLocaleString()} of ${rows.length.toLocaleString()} rows. Narrow the filters to export the rest.`]);
      row.font = { italic: true };
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const suffix = entityFilter ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Customers_${fyCy}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    req.log.error({ err }, "customers export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

// ── Distributor scheme-risk ────────────────────────────────────────────────────

router.get("/customers/distributor-risk", async (req, res) => {
  const fyCy = typeof req.query.fyCy === "string" ? req.query.fyCy : currentOpenFy();
  const fyLy = typeof req.query.fyLy === "string" ? req.query.fyLy : await deriveSaleLineCohortFy();
  ensureRegisterSynced(fyCy);
  ensureRegisterSynced(fyLy);
  const monthsCy = parseMonthList(req.query.monthsCy);
  const monthsLy = parseMonthList(req.query.monthsLy);
  const entityFilter = parseEntityFilter(req);

  if (!monthsCy.length || !monthsLy.length) {
    res.json({ rows: [], summary: { total: 0, onTrack: 0, atRisk: 0, zeroBuyers: 0, atRiskRevenue: 0, zeroBuyerRevenue: 0 }, filtered: !!entityFilter });
    return;
  }

  try {
    // LY side resolves head/state values to the current-FY customer set.
    const filterLy = entityFilter
      ? await resolvePriorEntityFilter(fyCy, entityFilter)
      : undefined;
    const rows = await getDistributorRisk({
      fyCy, fyLy, monthsCy, monthsLy,
      filterCy: entityFilter, filterLy,
    });
    const summary = {
      total: rows.length,
      onTrack: rows.filter((r) => r.status === "on_track").length,
      atRisk: rows.filter((r) => r.status === "at_risk").length,
      zeroBuyers: rows.filter((r) => r.status === "zero").length,
      atRiskRevenue: rows.filter((r) => r.status !== "on_track").reduce((s, r) => s + r.lyVal, 0),
      zeroBuyerRevenue: rows.filter((r) => r.status === "zero").reduce((s, r) => s + r.lyVal, 0),
    };
    res.json({ rows, summary, filtered: !!entityFilter });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to compute distributor risk" });
  }
});

export default router;
