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
 *
 * Public (read-only):
 *   GET  /api/secondary-orders                — paginated rows with filters
 *   GET  /api/secondary-orders/summary        — header stats (date range, totals, status split)
 *   GET  /api/secondary-orders/filters        — filter options + identity coverage
 *   GET  /api/secondary-orders/export         — XLSX export (same filters as list)
 *
 * Shared filter params (all GET routes):
 *   stateHead, state, distributor (cp_code), retailer (dealer_id),
 *   status (APPROVED|PENDING), dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD)
 *   limit, offset (for paginated list)
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
  type LoadResult,
} from "../lib/secondaryOrders/loader.js";
import { logger } from "../lib/logger.js";

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

  // stateHead: join via person_registry using sales_user_id → person_registry.state_head
  if (f.stateHead) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM person p
        JOIN person_registry pr ON pr.person_id = p.person_id
        WHERE p.person_id = sol.sales_user_id
          AND pr.state_head = $${params.length + 1}
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
    conditions.push(`sol.order_datetime >= $${params.length + 1}::date`);
    params.push(f.dateFrom);
  }

  if (f.dateTo) {
    conditions.push(`sol.order_datetime < ($${params.length + 1}::date + interval '1 day')`);
    params.push(f.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

function parseFilters(req: Request): FilterParams {
  return {
    stateHead: typeof req.query.stateHead === "string" ? req.query.stateHead : undefined,
    state: typeof req.query.state === "string" ? req.query.state : undefined,
    distributor: typeof req.query.distributor === "string" ? req.query.distributor : undefined,
    retailer: typeof req.query.retailer === "string" ? req.query.retailer : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    dateFrom: typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined,
    dateTo: typeof req.query.dateTo === "string" ? req.query.dateTo : undefined,
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
    const result = await verifySecondaryOrders();
    res.json({ ok: true, basis: "ORDER BOOKING", ...result });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] verify error");
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
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
        MIN(sol.order_datetime)::date::text               AS date_min,
        MAX(sol.order_datetime)::date::text               AS date_max,
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
        `SELECT DISTINCT pr.state_head
         FROM secondary_order_line sol
         JOIN person p ON p.person_id = sol.sales_user_id
         JOIN person_registry pr ON pr.person_id = p.person_id
         WHERE pr.state_head IS NOT NULL
         ORDER BY pr.state_head`,
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

    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 1000);
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10));

    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT
           sol.id, sol.order_id, sol.order_datetime, sol.order_status,
           sol.sales_user_name, sol.sales_user_id,
           sol.customer_name, sol.dealer_id, sol.dealer_mobile,
           sol.cp_name, sol.cp_code,
           sol.state, sol.district, sol.city, sol.pincode,
           sol.category_name, sol.segment_canon, sol.product_code,
           sol.gst_pct, sol.gst_amount, sol.qty,
           sol.discount_pct, sol.discount_amount,
           sol.dealer_order_value, sol.basic_order_value,
           sol.source_file
         FROM secondary_order_line sol
         ${where}
         ORDER BY sol.order_datetime DESC, sol.order_id, sol.product_code
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*) AS n FROM secondary_order_line sol ${where}`, params),
    ]);

    res.json({
      basis: "ORDER BOOKING",
      note: "Order booking, not dispatch. Not comparable with secondary sales figures.",
      total: Number(cnt.rows[0]?.n ?? 0),
      limit,
      offset,
      rows: rows.rows,
    });
  } catch (err) {
    req.log.error({ err }, "[secondaryOrders] list error");
    res.status(500).json({ error: "Failed to list secondary orders" });
  }
});

// ── GET /api/secondary-orders/export ─────────────────────────────────────────
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_EXPORT_ROWS = 50_000;
let activeExports = 0;
const MAX_CONCURRENT_EXPORTS = 2;

router.get("/secondary-orders/export", async (req: Request, res: Response) => {
  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is in progress — try again shortly." });
    return;
  }

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

    activeExports++;

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
    activeExports--;
  }
});

export default router;
