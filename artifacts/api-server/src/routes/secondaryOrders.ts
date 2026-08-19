/**
 * Secondary Orders routes — ORDER BOOKING, not dispatch.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────
 * │ IMPORTANT
 * │ All data in secondary_order_line is ORDER BOOKING, not dispatch.
 * │ Never sum or compare with secondary_sku_line or sale_line figures.
 * │ Every response labels basis as "ORDER BOOKING".
 * │ basic_order_value excludes GST; dealer_order_value includes GST.
 * └─────────────────────────────────────────────────────────────────────────────
 *
 * Admin (X-Admin-Secret required):
 *   POST /api/admin/secondary-orders/load
 *     Upload contract:
 *       Option A (file already in attached_assets): POST with body
 *         { "useLocal": true }         — uses latest attached_assets/Product-Wise-*.xlsx
 *       Option B (upload via multipart): POST with field "file" (xlsx),
 *         Content-Type: multipart/form-data
 *       Option C (allowlisted workspace path): POST with body
 *         { "workspacePath": "/absolute/path/to/file.xlsx" }
 *         Only paths under known workspace dirs are accepted (path traversal guard).
 *
 *   GET  /api/admin/secondary-orders/load-status   — poll load job state
 *   POST /api/admin/secondary-orders/verify        — run verification report
 *   GET  /api/admin/secondary-orders/uploads       — source lineage and cross-upload checks
 *
 * Public (read-only):
 *   GET  /api/secondary-orders                — paginated rows with filters
 *   GET  /api/secondary-orders/summary        — header stats (date range, totals, status split)
 *   GET  /api/secondary-orders/filters        — filter options + identity coverage
 *   GET  /api/secondary-orders/export         — XLSX export (same filters as list)
 *
 * Shared filter params (all GET routes):
 *   stateHead, state, cpCode/distributor, dealerId/retailer,
 *   status (APPROVED|PENDING), from/dateFrom (YYYY-MM-DD), to/dateTo (YYYY-MM-DD)
 *   page, pageSize (or legacy limit, offset)
 */

import { Router, Request, Response, raw } from "express";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  loadSecondaryOrders,
  verifySecondaryOrders,
  resolveSecondaryOrderXlsx,
  getSecondaryOrderUploadHistory,
  type LoadResult,
} from "../lib/secondaryOrders/loader.js";
import { logger } from "../lib/logger.js";
import { ExportGate } from "../lib/secondaryOrders/exportGate.js";

const router = Router();

// ── Allowlisted workspace upload dirs (path traversal guard) ─────────────────
const ALLOWED_UPLOAD_DIRS = [
  path.resolve(process.cwd(), "attached_assets"),
  path.resolve(process.cwd(), "../../attached_assets"),
];

function isPathAllowed(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_UPLOAD_DIRS.some((d) => resolved.startsWith(d));
}

// ── In-memory load job state ─────────────────────────────────────────────────
type LoadJob =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "done"; finishedAt: string; result: LoadResult }
  | { status: "error"; finishedAt: string; error: string };

let loadJob: LoadJob = { status: "idle" };

// ── Admin auth helper ─────────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response): boolean {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required. Pass ADMIN_SECRET as X-Admin-Secret header." });
    return false;
  }
  return true;
}

// ── Filter builder (shared by list + export) ─────────────────────────────────
type FilterParams = {
  stateHead?: string;
  state?: string;
  distributor?: string;
  retailer?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

function buildWhereClause(f: FilterParams): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // State-head scope comes from the editable person hierarchy. person_registry
  // is a separate canonical-name registry and does not share person_id values.
  if (f.stateHead) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM person p
        LEFT JOIN person state_head ON state_head.person_id = p.state_head_person_id
        WHERE p.person_id = sol.sales_user_id
          AND COALESCE(state_head.name, CASE WHEN p.is_state_head THEN p.name END) = $${params.length + 1}
      )
    `);
    params.push(f.stateHead);
  }

  if (f.state) {
    conditions.push(`sol.state = $${params.length + 1}`);
    params.push(f.state);
  }

  if (f.distributor) {
    conditions.push(`sol.cp_code = $${params.length + 1}`);
    params.push(f.distributor);
  }

  if (f.retailer) {
    conditions.push(`sol.dealer_id = $${params.length + 1}`);
    params.push(f.retailer);
  }

  if (f.status) {
    if (f.status !== "APPROVED" && f.status !== "PENDING") {
      throw new Error("status must be APPROVED or PENDING");
    }
    conditions.push(`sol.order_status = $${params.length + 1}`);
    params.push(f.status);
  }

  if (f.dateFrom) {
    conditions.push(`sol.order_datetime >= ($${params.length + 1}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    params.push(f.dateFrom);
  }

  if (f.dateTo) {
    conditions.push(`sol.order_datetime < (($${params.length + 1}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    params.push(f.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

function parseFilters(req: Request): FilterParams {
  return {
    stateHead: typeof req.query.stateHead === "string" ? req.query.stateHead : undefined,
    state: typeof req.query.state === "string" ? req.query.state : undefined,
    distributor: typeof req.query.cpCode === "string"
      ? req.query.cpCode
      : typeof req.query.distributor === "string" ? req.query.distributor : undefined,
    retailer: typeof req.query.dealerId === "string"
      ? req.query.dealerId
      : typeof req.query.retailer === "string" ? req.query.retailer : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    dateFrom: typeof req.query.from === "string"
      ? req.query.from
      : typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined,
    dateTo: typeof req.query.to === "string"
      ? req.query.to
      : typeof req.query.dateTo === "string" ? req.query.dateTo : undefined,
  };
}

// ── POST /api/admin/secondary-orders/load ────────────────────────────────────
// Three upload options — see module comment above.
//
// Option B uses raw body (Content-Type: application/octet-stream) — the xlsx
// bytes are sent directly without multipart encoding, consistent with other
// admin upload routes (adminUploads.ts).  Max 50 MB.
router.post(
  "/admin/secondary-orders/load",
  raw({ type: () => true, limit: "50mb" }),
  async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    if (loadJob.status === "running") {
      res.status(409).json({ error: "A load is already running.", startedAt: (loadJob as { startedAt: string }).startedAt });
      return;
    }

    // Determine file path
    let resolvedPath: string;
    try {
      if (Buffer.isBuffer(req.body) && (req.body as Buffer).length > 0) {
        // Option B: raw body upload — write to attached_assets
        const dir = ALLOWED_UPLOAD_DIRS.find((d) => fs.existsSync(d)) ?? ALLOWED_UPLOAD_DIRS[0];
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `Product-Wise-Secondary-Order-Report_upload_${Date.now()}.xlsx`);
        fs.writeFileSync(dest, req.body as Buffer);
        resolvedPath = dest;
      } else if (req.body && !Buffer.isBuffer(req.body) && typeof req.body === "object" && (req.body as Record<string, unknown>)["workspacePath"]) {
        // Option C: allowlisted workspace path (JSON body)
        const wp = String((req.body as Record<string, unknown>)["workspacePath"]);
        if (!path.isAbsolute(wp)) {
          res.status(400).json({ error: "workspacePath must be absolute" });
          return;
        }
        if (!isPathAllowed(wp)) {
          res.status(400).json({ error: "workspacePath is outside allowed directories" });
          return;
        }
        resolvedPath = wp;
      } else {
        // Option A: use local attached_assets file
        resolvedPath = resolveSecondaryOrderXlsx();
      }
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
      return;
    }

    const startedAt = new Date().toISOString();
    loadJob = { status: "running", startedAt };

    res.status(202).json({
      ok: true,
      status: "running",
      startedAt,
      message: "Load started. Poll GET /api/admin/secondary-orders/load-status for progress.",
    });

    // Fire-and-forget
    loadSecondaryOrders({ filePath: resolvedPath })
      .then((result) => {
        loadJob = { status: "done", finishedAt: new Date().toISOString(), result };
        req.log.info({ rowsInserted: result.rowsInserted, collisions: result.collisions.length }, "[secondaryOrders] load done");
      })
      .catch((err) => {
        loadJob = { status: "error", finishedAt: new Date().toISOString(), error: String(err instanceof Error ? err.message : err) };
        req.log.error({ err }, "[secondaryOrders] load error");
      });
  },
);

// ── GET /api/admin/secondary-orders/load-status ──────────────────────────────
router.get("/admin/secondary-orders/load-status", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json(loadJob);
});

// ── POST /api/admin/secondary-orders/verify ──────────────────────────────────
router.post("/admin/secondary-orders/verify", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [result, uploadHistory] = await Promise.all([
      verifySecondaryOrders(),
      getSecondaryOrderUploadHistory(),
    ]);
    res.json({
      ok: true,
      basis: "ORDER BOOKING",
      analyticsStatus: "ISOLATED_PENDING_RELIABILITY",
      note: "This order-booking feed is not approved for secondary-sales, SKU, margin, or alert analytics.",
      ...result,
      uploadHistory,
    });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] verify error");
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// ── GET /api/admin/secondary-orders/uploads ──────────────────────────────────
router.get("/admin/secondary-orders/uploads", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const requestedLimit = Number(req.query.limit ?? 25);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 25;
  try {
    const uploads = await getSecondaryOrderUploadHistory(limit);
    res.json({
      basis: "ORDER BOOKING",
      analyticsStatus: "ISOLATED_PENDING_RELIABILITY",
      note: "Review upload assessments before any separately approved analytics integration.",
      uploads,
    });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] upload history error");
    res.status(500).json({ error: "Failed to load secondary-order upload history" });
  }
});

// ── GET /api/secondary-orders/summary ────────────────────────────────────────
router.get("/secondary-orders/summary", async (req: Request, res: Response) => {
  try {
    const filters = parseFilters(req);
    let where: string;
    let params: unknown[];
    try {
      ({ where, params } = buildWhereClause(filters));
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
      return;
    }

    // Alias sol in subqueries
    const query = `
      SELECT
        COUNT(*)                                           AS rows,
        COUNT(DISTINCT sol.order_id)                      AS orders,
        COUNT(DISTINCT sol.dealer_id)                     AS retailers,
        COUNT(DISTINCT sol.cp_code)                       AS distributors,
        COALESCE(SUM(sol.qty::numeric), 0)                AS total_qty,
        COALESCE(SUM(sol.basic_order_value::numeric), 0)  AS total_basic,
        COALESCE(SUM(sol.dealer_order_value::numeric), 0) AS total_dealer,
         MIN((sol.order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_min,
         MAX((sol.order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_max,
        COUNT(*) FILTER (WHERE sol.order_status = 'APPROVED') AS approved_lines,
        COUNT(*) FILTER (WHERE sol.order_status = 'PENDING')  AS pending_lines
      FROM secondary_order_line sol
      ${where}
    `;

    const result = await pool.query(query, params);
    const r = result.rows[0];
    res.json({
      basis: "ORDER BOOKING",
      note: "Order booking, not dispatch. Not comparable with secondary sales figures.",
      rows: Number(r.rows),
      orders: Number(r.orders),
      retailers: Number(r.retailers),
      distributors: Number(r.distributors),
      totalQty: Number(r.total_qty),
      totalBasic: Number(r.total_basic),
      totalDealer: Number(r.total_dealer),
      dateMin: r.date_min ?? null,
      dateMax: r.date_max ?? null,
      statusSplit: {
        APPROVED: Number(r.approved_lines),
        PENDING: Number(r.pending_lines),
      },
    });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] summary error");
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

// ── GET /api/secondary-orders/filters ────────────────────────────────────────
router.get("/secondary-orders/filters", async (req: Request, res: Response) => {
  try {
    const [states, distributors, retailers, stateHeads] = await Promise.all([
      pool.query<{ state: string }>(
        `SELECT DISTINCT state FROM secondary_order_line WHERE state IS NOT NULL ORDER BY state`,
      ),
      pool.query<{ cp_code: string; cp_name: string | null }>(
        `SELECT DISTINCT cp_code, MAX(cp_name) AS cp_name FROM secondary_order_line GROUP BY cp_code ORDER BY cp_code`,
      ),
      pool.query<{ dealer_id: string; customer_name: string | null }>(
        `SELECT DISTINCT dealer_id, MAX(customer_name) AS customer_name FROM secondary_order_line GROUP BY dealer_id ORDER BY dealer_id`,
      ),
       pool.query<{ state_head: string }>(
         `SELECT DISTINCT COALESCE(state_head.name, p.name) AS state_head
         FROM secondary_order_line sol
         JOIN person p ON p.person_id = sol.sales_user_id
          LEFT JOIN person state_head ON state_head.person_id = p.state_head_person_id
          WHERE p.is_state_head OR p.state_head_person_id IS NOT NULL
          ORDER BY state_head`,
      ),
    ]);

    res.json({
      basis: "ORDER BOOKING",
      stateHeads: stateHeads.rows.map((r) => r.state_head),
      states: states.rows.map((r) => r.state),
      distributors: distributors.rows.map((r) => ({
        cpCode: r.cp_code,
        cpName: r.cp_name,
      })),
      retailers: retailers.rows.map((r) => ({
        dealerId: r.dealer_id,
        customerName: r.customer_name,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] filters error");
    res.status(500).json({ error: "Failed to get filter options" });
  }
});

// ── GET /api/secondary-orders ─────────────────────────────────────────────────
// One complete page payload keeps the React screen's filters, summary and rows
// in one contract and one source of truth.
router.get("/secondary-orders", async (req: Request, res: Response) => {
  try {
    const filters = parseFilters(req);
    let where: string;
    let params: unknown[];
    try {
      ({ where, params } = buildWhereClause(filters));
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
      return;
    }

    const pageSizeRaw = Number(req.query.pageSize ?? req.query.limit ?? 100);
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(Math.floor(pageSizeRaw), 1), 1000) : 100;
    const pageRaw = Number(req.query.page ?? 1);
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
    const offsetRaw = req.query.offset == null ? (page - 1) * pageSize : Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

    const [rows, summary, filterRows, quality] = await Promise.all([
      pool.query(
        `SELECT
           sol.id AS "id", sol.order_id AS "orderId", sol.order_datetime AS "orderDatetime",
           sol.order_status AS "orderStatus", sol.sales_user_name AS "salesUserName",
           sol.sales_user_id AS "salesUserId", sol.customer_name AS "customerName",
           sol.dealer_id AS "dealerId", sol.dealer_mobile AS "dealerMobile",
           sol.cp_name AS "cpName", sol.cp_code AS "cpCode", sol.state AS "state",
           sol.district AS "district", sol.city AS "city", sol.pincode AS "pincode",
           sol.category_name AS "categoryName", sol.segment_canon AS "segmentCanon",
           sol.product_code AS "productCode", sol.occurrence AS "occurrence",
           sol.is_exact_duplicate_export AS "isExactDuplicateExport",
           sol.gst_pct::float8 AS "gstPct", sol.gst_amount::float8 AS "gstAmount",
           sol.qty::float8 AS "qty", sol.discount_pct::float8 AS "discountPct",
           sol.discount_amount::float8 AS "discountAmount",
           sol.dealer_order_value::float8 AS "dealerOrderValue",
           sol.basic_order_value::float8 AS "basicOrderValue",
           sol.source_file AS "sourceFile"
         FROM secondary_order_line sol
         ${where}
          ORDER BY sol.order_datetime DESC, sol.order_id, sol.product_code, sol.occurrence
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      ),
      pool.query(
        `SELECT
           COUNT(*) AS lines,
           COUNT(DISTINCT sol.order_id) AS orders,
           COUNT(DISTINCT sol.dealer_id) AS retailers,
           COUNT(DISTINCT sol.cp_code) AS distributors,
           COALESCE(SUM(sol.qty::numeric), 0) AS total_qty,
           COALESCE(SUM(sol.basic_order_value::numeric), 0) AS total_basic,
           MIN((sol.order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_min,
           MAX((sol.order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_max,
           COUNT(*) FILTER (WHERE sol.order_status = 'APPROVED') AS approved_lines,
           COUNT(DISTINCT sol.order_id) FILTER (WHERE sol.order_status = 'APPROVED') AS approved_orders,
           COALESCE(SUM(sol.basic_order_value::numeric) FILTER (WHERE sol.order_status = 'APPROVED'), 0) AS approved_basic,
           COUNT(*) FILTER (WHERE sol.order_status = 'PENDING') AS pending_lines,
           COUNT(DISTINCT sol.order_id) FILTER (WHERE sol.order_status = 'PENDING') AS pending_orders,
           COALESCE(SUM(sol.basic_order_value::numeric) FILTER (WHERE sol.order_status = 'PENDING'), 0) AS pending_basic
         FROM secondary_order_line sol ${where}`,
        params,
      ),
      Promise.all([
        pool.query<{ state: string }>(`SELECT DISTINCT state FROM secondary_order_line WHERE state IS NOT NULL ORDER BY state`),
        pool.query<{ cp_code: string; cp_name: string | null }>(
          `SELECT cp_code, MAX(cp_name) AS cp_name FROM secondary_order_line GROUP BY cp_code ORDER BY cp_code`,
        ),
        pool.query<{ dealer_id: string; customer_name: string | null }>(
          `SELECT dealer_id, MAX(customer_name) AS customer_name FROM secondary_order_line GROUP BY dealer_id ORDER BY dealer_id`,
        ),
        pool.query<{ state_head: string }>(
          `SELECT DISTINCT COALESCE(state_head.name, p.name) AS state_head
           FROM secondary_order_line sol
           JOIN person p ON p.person_id = sol.sales_user_id
           LEFT JOIN person state_head ON state_head.person_id = p.state_head_person_id
           WHERE p.is_state_head OR p.state_head_person_id IS NOT NULL
           ORDER BY state_head`,
        ),
      ]),
      pool.query<{
        duplicate_rows: string; duplicate_qty: string; duplicate_basic: string; total_rows: string;
      }>(`
        SELECT COUNT(*) FILTER (WHERE is_exact_duplicate_export)::text AS duplicate_rows,
          COALESCE(SUM(qty::numeric) FILTER (WHERE is_exact_duplicate_export), 0)::text AS duplicate_qty,
          COALESCE(SUM(basic_order_value::numeric) FILTER (WHERE is_exact_duplicate_export), 0)::text AS duplicate_basic,
          COUNT(*)::text AS total_rows
        FROM secondary_order_line
      `),
    ]);

    const s = summary.rows[0];
    const [states, distributors, retailers, stateHeads] = filterRows;
    const totalRows = Number(s?.lines ?? 0);
    res.json({
      basis: {
        measure: "ORDER BOOKING",
        value: "Basic order value excludes GST",
        disclaimer: "Order booking, not dispatch. Not comparable with secondary sales figures.",
      },
      coverage: { from: s?.date_min ?? null, to: s?.date_max ?? null },
      summary: {
        orders: Number(s?.orders ?? 0),
        lines: totalRows,
        retailers: Number(s?.retailers ?? 0),
        distributors: Number(s?.distributors ?? 0),
        totalQty: Number(s?.total_qty ?? 0),
        totalBasicValue: Number(s?.total_basic ?? 0),
        status: [
          { status: "APPROVED", lines: Number(s?.approved_lines ?? 0), orders: Number(s?.approved_orders ?? 0), basicValue: Number(s?.approved_basic ?? 0) },
          { status: "PENDING", lines: Number(s?.pending_lines ?? 0), orders: Number(s?.pending_orders ?? 0), basicValue: Number(s?.pending_basic ?? 0) },
        ].filter((item) => item.lines > 0),
      },
      rows: rows.rows,
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
      },
      filters: {
        stateHeads: stateHeads.rows.map((r) => ({ id: r.state_head, name: r.state_head })),
        states: states.rows.map((r) => r.state),
        distributors: distributors.rows.map((r) => ({
          id: r.cp_code,
          name: r.cp_name ? `${r.cp_name} (${r.cp_code})` : r.cp_code,
        })),
        retailers: retailers.rows.map((r) => ({
          id: r.dealer_id,
          name: r.customer_name ? `${r.customer_name} (${r.dealer_id})` : r.dealer_id,
        })),
        statuses: ["APPROVED", "PENDING"],
      },
      quality: (() => {
        const q = quality.rows[0];
        const duplicateRows = Number(q?.duplicate_rows ?? 0);
        const allRows = Number(q?.total_rows ?? 0);
        return {
          exactDuplicateExportRows: duplicateRows,
          exactDuplicateQty: Number(q?.duplicate_qty ?? 0),
          exactDuplicateBasicValue: Number(q?.duplicate_basic ?? 0),
          exactDuplicateRateAlert: allRows > 0 && duplicateRows / allRows > 0.005,
        };
      })(),
    });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] list error");
    res.status(500).json({ error: "Failed to list secondary orders" });
  }
});

// ── GET /api/secondary-orders/export ─────────────────────────────────────────
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_EXPORT_ROWS = 50_000;
const MAX_CONCURRENT_EXPORTS = 2;
const exportGate = new ExportGate(MAX_CONCURRENT_EXPORTS);

router.get("/secondary-orders/export", async (req: Request, res: Response) => {
  let exportSlotAcquired = false;
  try {
    const filters = parseFilters(req);
    let where: string;
    let params: unknown[];
    try {
      ({ where, params } = buildWhereClause(filters));
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
      return;
    }

    if (!exportGate.tryAcquire()) {
      res.status(429).json({ error: "Another export is in progress — try again shortly." });
      return;
    }
    exportSlotAcquired = true;

    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT
           sol.order_id, sol.order_datetime, sol.order_status,
           sol.sales_user_name, sol.customer_name, sol.dealer_id,
           sol.dealer_mobile, sol.cp_name, sol.cp_code,
           sol.state, sol.district, sol.city, sol.pincode,
           sol.category_name, sol.segment_canon, sol.product_code,
           sol.gst_pct, sol.gst_amount, sol.qty,
           sol.discount_pct, sol.discount_amount,
           sol.dealer_order_value, sol.basic_order_value
         FROM secondary_order_line sol
         ${where}
         ORDER BY sol.order_datetime DESC, sol.order_id, sol.product_code
         LIMIT $${params.length + 1}`,
        [...params, MAX_EXPORT_ROWS],
      ),
      pool.query(
        `SELECT
           COUNT(*) AS rows,
           COUNT(DISTINCT sol.order_id) AS orders,
           COALESCE(SUM(sol.basic_order_value::numeric),0) AS total_basic,
           MIN(sol.order_datetime)::date::text AS date_min,
           MAX(sol.order_datetime)::date::text AS date_max
         FROM secondary_order_line sol ${where}`,
        params,
      ),
    ]);

    const s = summary.rows[0];
    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    // Info sheet — self-describing
    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 28 }, { width: 80 }];
    const infoRows: [string, string][] = [
      ["Basis", "ORDER BOOKING — not dispatch"],
      ["Note", "Not comparable with secondary sales figures (secondary_sku_line / secondary_register_line)."],
      ["Basic Order Value", "Excludes GST. Use this for commercial analysis."],
      ["Dealer Order Value", "Includes GST. Stored for completeness only."],
      ["Date range", `${s.date_min ?? "–"} to ${s.date_max ?? "–"}`],
      ["Total rows (filtered)", String(s.rows)],
      ["Distinct orders", String(s.orders)],
      ["Total basic value (INR)", String(s.total_basic)],
      ["Exported at", new Date().toISOString()],
      ["Filter: State Head", filters.stateHead ?? "All"],
      ["Filter: State", filters.state ?? "All"],
      ["Filter: Distributor", filters.distributor ?? "All"],
      ["Filter: Retailer", filters.retailer ?? "All"],
      ["Filter: Status", filters.status ?? "All"],
      ["Filter: Date from", filters.dateFrom ?? "–"],
      ["Filter: Date to", filters.dateTo ?? "–"],
    ];
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    // Data sheet
    const ws = wb.addWorksheet("Secondary Orders");
    const columns = [
      { header: "Order ID", key: "order_id", width: 16 },
      { header: "Order Datetime", key: "order_datetime", width: 22 },
      { header: "Status", key: "order_status", width: 12 },
      { header: "Sales User", key: "sales_user_name", width: 22 },
      { header: "Customer Name", key: "customer_name", width: 28 },
      { header: "Dealer ID", key: "dealer_id", width: 14 },
      { header: "Dealer Mobile", key: "dealer_mobile", width: 16 },
      { header: "CP Name", key: "cp_name", width: 28 },
      { header: "CP Code", key: "cp_code", width: 14 },
      { header: "State", key: "state", width: 18 },
      { header: "District", key: "district", width: 18 },
      { header: "City", key: "city", width: 18 },
      { header: "Pincode", key: "pincode", width: 10 },
      { header: "Category Name", key: "category_name", width: 24 },
      { header: "Segment", key: "segment_canon", width: 20 },
      { header: "Product Code", key: "product_code", width: 14 },
      { header: "GST %", key: "gst_pct", width: 8 },
      { header: "GST Amount", key: "gst_amount", width: 12 },
      { header: "Qty", key: "qty", width: 8 },
      { header: "Discount %", key: "discount_pct", width: 10 },
      { header: "Discount Amount", key: "discount_amount", width: 14 },
      { header: "Basic Order Value (excl GST)", key: "basic_order_value", width: 26 },
      { header: "Dealer Order Value (incl GST)", key: "dealer_order_value", width: 28 },
    ];

    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).eachCell((cell) => { cell.font = { bold: true }; cell.fill = HEADER_FILL; });

    const truncated = rows.rows.length >= MAX_EXPORT_ROWS;
    for (const r of rows.rows) {
      ws.addRow(columns.map((c) => {
        const v = (r as Record<string, unknown>)[c.key];
        if (v instanceof Date) return v.toISOString();
        return v ?? "";
      }));
    }

    if (truncated) {
      const note = ws.addRow([`… showing first ${MAX_EXPORT_ROWS.toLocaleString()} rows. Narrow filters to export all.`]);
      note.font = { italic: true };
    }

    ws.views = [{ state: "frozen", ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="SecondaryOrders_OrderBooking_${date}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    if (exportSlotAcquired) exportGate.release();
  }
});

export default router;
