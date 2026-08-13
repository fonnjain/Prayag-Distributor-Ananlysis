// GP Margin routes.
//
// POST /api/admin/margin/load  — admin-gated; parse all GP MARGIN workbooks
//                                from Google Drive and (re)populate margin_fact.
// GET  /api/margin/stats       — summary counts for the Margin page.
// GET  /api/margin/list        — paginated rows with optional segment/fy/q filters.

import { Router } from "express";
import { isAdminToken } from "../lib/adminAuth.js";
import { loadGpMarginFiles, detectGpMarginTabs, extractRows, fetchWorkbookViaDriveExport } from "../lib/gpMargin/loader.js";
import { listDriveFiles, listDriveFolder, getDriveFileMeta } from "../lib/googleDrive.js";
import { pool } from "@workspace/db";

const router = Router();

// ── GET /api/margin/stats ──────────────────────────────────────────────────
router.get("/margin/stats", async (_req, res) => {
  try {
    const [totals, byFySeg, codes, negCnt] = await Promise.all([
      pool.query<{ total: string; fys: string }>(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT fy) AS fys FROM margin_fact",
      ),
      pool.query<{ fy: string; segment: string; cnt: string; months: string }>(
        `SELECT fy, segment,
                COUNT(*) AS cnt,
                COUNT(DISTINCT month_label) AS months
           FROM margin_fact GROUP BY fy, segment ORDER BY fy, segment`,
      ),
      pool.query<{ n: string }>("SELECT COUNT(DISTINCT item_code) AS n FROM margin_fact"),
      pool.query<{ n: string }>(
        "SELECT COUNT(DISTINCT item_code) AS n FROM margin_fact WHERE bom_cost IS NOT NULL AND avg_sale IS NOT NULL AND bom_cost > avg_sale",
      ),
    ]);

    const rowsByFySegment: Record<string, { rows: number; months: number }> = {};
    for (const r of byFySeg.rows) {
      rowsByFySegment[`${r.fy}|${r.segment}`] = {
        rows: parseInt(r.cnt, 10),
        months: parseInt(r.months, 10),
      };
    }

    res.json({
      totalRows: parseInt(totals.rows[0]?.total ?? "0", 10),
      distinctFys: parseInt(totals.rows[0]?.fys ?? "0", 10),
      distinctCodes: parseInt(codes.rows[0]?.n ?? "0", 10),
      negativeContributionCodes: parseInt(negCnt.rows[0]?.n ?? "0", 10),
      rowsByFySegment,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/margin/list ───────────────────────────────────────────────────
router.get("/margin/list", async (req, res) => {
  try {
    const fy       = typeof req.query.fy === "string" ? req.query.fy : null;

    const fyClause = fy ? "AND fy = $1" : "";
    const segment = typeof req.query.segment === "string" ? req.query.segment : null;
    const q       = typeof req.query.q       === "string" ? req.query.q       : null;
    const limit   = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset  = parseInt(String(req.query.offset ?? "0"), 10);

    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (fy)      { conditions.push(`fy = $${params.length + 1}`);          params.push(fy); }
    if (segment) { conditions.push(`segment = $${params.length + 1}`);     params.push(segment); }
    if (q) {
      conditions.push(`(item_code ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT fy, month_label, segment, item_code, tab_name,
                qty, weight, mrp, discount_frac, avg_sale, bom_cost,
                sale_value, bom_value, source_file
           FROM margin_fact ${where}
          ORDER BY fy DESC, month_label, segment, item_code
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM margin_fact ${where}`,
        params,
      ),
    ]);

    res.json({
      total: parseInt(cnt.rows[0]?.n ?? "0", 10),
      limit,
      offset,
      rows: rows.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// In-memory job state for the long-running load (177+ Drive exports take 15+ min).
// Only one load can run at a time; subsequent requests return the current status.
type JobState =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "done"; finishedAt: string; report: object }
  | { status: "error"; finishedAt: string; error: string };

let loadJob: JobState = { status: "idle" };

// ── GET /api/admin/margin/load-status ─────────────────────────────────────
router.get("/admin/margin/load-status", (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required." });
    return;
  }
  res.json(loadJob);
});

// ── POST /api/admin/margin/load ────────────────────────────────────────────
// Returns 202 immediately; runs the load in the background.
// Poll GET /api/admin/margin/load-status (same X-Admin-Secret header) to track progress.
// Poll GET /api/admin/margin/load-status to track progress; rows become visible only after the load commits.
router.post("/admin/margin/load", (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({
      error: "Admin authorisation required. Pass the SESSION_SECRET as: X-Admin-Secret: <SESSION_SECRET>",
    });
    return;
  }

  if (loadJob.status === "running") {
    res.status(409).json({
      error: "A load is already in progress.",
      startedAt: (loadJob as { status: "running"; startedAt: string }).startedAt,
      tip: "Poll GET /api/admin/margin/load-status for progress.",
    });
    return;
  }

  const startedAt = new Date().toISOString();
  loadJob = { status: "running", startedAt };
  res.status(202).json({
    ok: true,
    status: "running",
    startedAt,
    message:
      "Load started in the background (177+ Drive exports, ~15 min). " +
      "Poll GET /api/admin/margin/load-status with the same X-Admin-Secret header. " +
      "Rows appear in GET /api/margin/stats as they land.",
  });

  // Fire-and-forget — do NOT await
  loadGpMarginFiles()
    .then((report) => {
      loadJob = {
        status: "done",
        finishedAt: new Date().toISOString(),
        report: {
          filesScanned:  report.filesScanned,
          filesLoaded:   report.filesLoaded,
          filesCumulative: report.filesCumulative,
          filesSummary:    report.filesSummary,
          filesUnknown:    report.filesUnknown,
          rowsInserted:    report.rowsInserted,
          rowsByFySegment: report.rowsByFySegment,
          distinctCodes:   report.distinctCodes,
          cumulativeValidation: report.cumulativeValidation,
          cumulativeFlags:      report.cumulativeValidation.filter((c) => c.flag).length,
          negativeContributionCount: report.negativeContributionCount,
          negativeContributionTop10: report.negativeContributionTop10,
          filesSkipped:  report.filesSkipped,
          filesConflict: report.filesConflict,
        },
      };
    })
    .catch((err) => {
      loadJob = {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: String(err instanceof Error ? err.message : err),
      };
    });
});

// ── GET /api/admin/margin/conflict-audit ──────────────────────────────────
// One-time diagnostic: for the 5 Sanitaryware months that have two Drive copies
// with different content, compare them in detail:
//   1. modifiedTime + owners for each file copy
//   2. Extra item codes in each version (with item name, qty, avg_sale, bom_cost)
//   3. Whether extra codes appear in sale_line for that month
//   4. Whether any shared-code row differs in qty, avg_sale, bom_cost, mrp, discount
//   5. BOM% computed separately from each file copy
router.get("/admin/margin/conflict-audit", async (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) { res.status(401).json({ error: "Admin authorisation required." }); return; }

  try {
    // ── 1. Discover Sanitaryware GP MARGIN folders (FY 2025-26) ─────────────
    const allFolderSearch = await listDriveFiles({ q: "GP MARGIN" });
    const sanFolders = allFolderSearch.files.filter((f) =>
      f.mimeType === "application/vnd.google-apps.folder" &&
      /sanitar/i.test(f.name) &&
      /25-26|2025-26/.test(f.name),
    );

    // ── 2. Collect all spreadsheet children ──────────────────────────────────
    type FileEntry = { id: string; name: string; mimeType: string; modifiedTime?: string; folderName: string };
    const allFiles: FileEntry[] = [];
    for (const folder of sanFolders) {
      const children = await listDriveFolder(folder.id);
      for (const child of children) {
        if (
          child.mimeType === "application/vnd.google-apps.spreadsheet" ||
          /\.(xlsx|xls)$/i.test(child.name)
        ) {
          allFiles.push({ ...child, folderName: folder.name });
        }
      }
    }

    // ── 3. Parse month label from filename (mirrors fixed loader logic) ───────
    const MONTH_MAP: Record<string, { canon: string; half: "first" | "second" }> = {
      jan: { canon: "Jan", half: "second" }, january: { canon: "Jan", half: "second" },
      feb: { canon: "Feb", half: "second" }, february: { canon: "Feb", half: "second" },
      mar: { canon: "Mar", half: "second" }, march: { canon: "Mar", half: "second" },
      apr: { canon: "Apr", half: "first" }, april: { canon: "Apr", half: "first" },
      may: { canon: "May", half: "first" },
      jun: { canon: "Jun", half: "first" }, june: { canon: "Jun", half: "first" },
      jul: { canon: "Jul", half: "first" }, july: { canon: "Jul", half: "first" },
      aug: { canon: "Aug", half: "first" }, august: { canon: "Aug", half: "first" },
      sep: { canon: "Sep", half: "first" }, sept: { canon: "Sep", half: "first" }, september: { canon: "Sep", half: "first" },
      oct: { canon: "Oct", half: "first" }, october: { canon: "Oct", half: "first" },
      nov: { canon: "Nov", half: "first" }, november: { canon: "Nov", half: "first" },
      dec: { canon: "Dec", half: "first" }, december: { canon: "Dec", half: "first" },
    };
    function parseML(name: string, fy: string): string | null {
      const lower = name.toLowerCase();
      const found: { canon: string; half: "first" | "second" }[] = [];
      for (const [key, val] of Object.entries(MONTH_MAP)) {
        if (new RegExp(`(?<![a-z])${key}(?![a-z])`, "i").test(lower) && !found.some((f) => f.canon === val.canon))
          found.push(val);
      }
      if (found.length !== 1) return null;
      const [a, b] = fy.split("-");
      const firstY = parseInt(a.slice(-2), 10);
      const secondY = parseInt(b, 10);
      const y = found[0].half === "first" ? firstY : secondY;
      return `${found[0].canon}-${y.toString().padStart(2, "0")}`;
    }

    // ── 4. Group files by month label; find conflict pairs ───────────────────
    const CONFLICT_MONTHS = new Set(["Mar-26", "Jan-26", "Feb-26", "May-25", "Aug-25"]);
    const byMonth = new Map<string, FileEntry[]>();
    for (const f of allFiles) {
      const ml = parseML(f.name, "2025-26");
      if (!ml || !CONFLICT_MONTHS.has(ml)) continue;
      const arr = byMonth.get(ml) ?? [];
      arr.push(f);
      byMonth.set(ml, arr);
    }

    // ── 5. For each conflict month: metadata → download → parse → compare ────
    type ParsedRow = {
      itemCode: string; qty: number | null; mrp: number | null;
      discountFrac: number | null; avgSale: number | null; bomCost: number | null;
    };

    const auditResults = [];

    for (const [monthLabel, files] of byMonth.entries()) {
      if (files.length < 2) continue; // only process true pairs

      // Metadata pass (parallel)
      const metas = await Promise.all(files.map((f) => getDriveFileMeta(f.id)));

      // Download + parse pass (sequential to avoid hammering Drive quota)
      const versions: Array<{ filename: string; rows: ParsedRow[]; parseError?: string }> = [];
      for (const f of files) {
        let rows: ParsedRow[] = [];
        let parseError: string | undefined;
        try {
          const wb = await fetchWorkbookViaDriveExport(f.id, f.mimeType, 120_000);
          const tabs = detectGpMarginTabs(wb);
          for (const { ws, headerRow, colMap } of tabs) {
            const raw = extractRows(ws, headerRow, colMap, "2025-26", monthLabel, "Sanitaryware", f.name);
            rows.push(...raw.map((r) => ({
              itemCode: r.itemCode,
              qty: r.qty,
              mrp: r.mrp,
              discountFrac: r.discountFrac,
              avgSale: r.avgSale,
              bomCost: r.bomCost,
            })));
          }
        } catch (err) {
          parseError = String(err instanceof Error ? err.message : err);
        }
        versions.push({ filename: f.name, rows, parseError });
      }

      // Compute BOM% per version
      function bomPct(rows: ParsedRow[]): number | null {
        const valid = rows.filter((r) => r.bomCost != null && r.avgSale != null && r.avgSale > 0);
        if (valid.length === 0) return null;
        return Math.round(valid.reduce((s, r) => s + (r.bomCost! / r.avgSale!) * 100, 0) / valid.length * 100) / 100;
      }

      // Find extra codes and shared-row diffs
      const [v1, v2] = versions;
      const map1 = new Map(v1.rows.map((r) => [r.itemCode, r]));
      const map2 = new Map(v2.rows.map((r) => [r.itemCode, r]));

      const extraIn1 = [...map1.keys()].filter((c) => !map2.has(c));
      const extraIn2 = [...map2.keys()].filter((c) => !map1.has(c));

      const sharedDiffs: Array<{ code: string; field: string; file1Val: number | null; file2Val: number | null }> = [];
      for (const code of map1.keys()) {
        if (!map2.has(code)) continue;
        const r1 = map1.get(code)!;
        const r2 = map2.get(code)!;
        for (const field of ["qty", "avgSale", "bomCost", "mrp", "discountFrac"] as const) {
          const a = r1[field], b = r2[field];
          if (a === b) continue;
          // Flag if diff > 0.01% of average (catches rounding noise only)
          const avg = ((a ?? 0) + (b ?? 0)) / 2;
          const diffPct = avg !== 0 ? Math.abs((a ?? 0) - (b ?? 0)) / Math.abs(avg) * 100 : 100;
          if (diffPct > 0.01) sharedDiffs.push({ code, field, file1Val: a, file2Val: b });
        }
      }

      const allExtra = [...extraIn1, ...extraIn2];

      // Enrich extra codes: item_master name + sale_line presence
      const [imRes, slRes] = await Promise.all([
        allExtra.length > 0
          ? pool.query<{ code: string; item_name: string | null }>(
              `SELECT code, item_name FROM item_master WHERE code = ANY($1)`, [allExtra])
          : Promise.resolve({ rows: [] as { code: string; item_name: string | null }[] }),
        allExtra.length > 0
          ? pool.query<{ code: string; qty_sold: string }>(
              `SELECT code, SUM(qty)::text AS qty_sold FROM sale_line
               WHERE code = ANY($1) AND month_label = $2
               GROUP BY code`, [allExtra, monthLabel])
          : Promise.resolve({ rows: [] as { code: string; qty_sold: string }[] }),
      ]);

      const imMap = new Map(imRes.rows.map((r) => [r.code, r.item_name]));
      const slMap = new Map(slRes.rows.map((r) => [r.code, r.qty_sold]));

      function enrichExtra(codes: string[], fromMap: Map<string, ParsedRow>) {
        return codes.map((code) => {
          const r = fromMap.get(code);
          return {
            code,
            itemName: imMap.get(code) ?? null,
            qty: r?.qty ?? null,
            avgSale: r?.avgSale ?? null,
            bomCost: r?.bomCost ?? null,
            inSaleLine: slMap.has(code),
            saleLineQty: slMap.get(code) ?? null,
          };
        });
      }

      auditResults.push({
        monthLabel,
        files: files.map((f, i) => ({
          filename: f.name,
          folderName: f.folderName,
          modifiedTime: metas[i]?.modifiedTime ?? null,
          owners: metas[i]?.owners?.map((o) => `${o.displayName} <${o.emailAddress}>`) ?? [],
          rowCount: versions[i]?.rows.length ?? 0,
          bomPct: bomPct(versions[i]?.rows ?? []),
          parseError: versions[i]?.parseError ?? null,
        })),
        extraInFile1: enrichExtra(extraIn1, map1),
        extraInFile2: enrichExtra(extraIn2, map2),
        sharedRowDiffs: sharedDiffs,
      });
    }

    // Sort by monthLabel for consistent output
    auditResults.sort((a, b) => a.monthLabel.localeCompare(b.monthLabel));
    res.json({ ok: true, conflictMonths: auditResults });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/margin/trend ─────────────────────────────────────────────────
// Returns monthly GC% trend by segment, per-segment summary cards, and
// top-50 negative-contribution codes.  Optional ?fy= filter.
router.get("/margin/trend", async (req, res) => {
  try {
    const fy       = typeof req.query.fy === "string" ? req.query.fy : null;
    const fyClause = fy ? "AND fy = $1" : "";
    const fyParam  = fy ? [fy] : [];

    const [monthly, segSummary, negCodes] = await Promise.all([
      // Monthly weighted-average GC% per segment
      pool.query<{
        fy: string; month_label: string; segment: string;
        total_sale: string; total_bom: string;
      }>(
        `SELECT fy, month_label, segment,
                SUM(sale_value)::text AS total_sale,
                SUM(bom_value)::text  AS total_bom
           FROM margin_fact
          WHERE sale_value IS NOT NULL AND bom_value IS NOT NULL
            ${fyClause}
          GROUP BY fy, month_label, segment
          ORDER BY TO_DATE(month_label, 'Mon-YY'), segment`,
        fyParam,
      ),
      // Per-segment totals: avg GC%, total sale, month-count, negative codes
      pool.query<{
        segment: string;
        total_sale: string; total_bom: string;
        month_count: string; neg_codes: string;
      }>(
        `SELECT segment,
                SUM(sale_value)::text  AS total_sale,
                SUM(bom_value)::text   AS total_bom,
                COUNT(DISTINCT month_label)::text AS month_count,
                COUNT(DISTINCT CASE WHEN avg_sale IS NOT NULL AND bom_cost IS NOT NULL AND bom_cost > avg_sale THEN item_code END)::text AS neg_codes
           FROM margin_fact
          WHERE sale_value IS NOT NULL AND bom_value IS NOT NULL
            ${fyClause}
          GROUP BY segment
          ORDER BY segment`,
        fyParam,
      ),
      // Top-50 negative-contribution codes
      pool.query<{
        item_code: string; segment: string;
        total_sale: string; total_bom: string;
      }>(
        `SELECT item_code, segment,
                SUM(sale_value)::text AS total_sale,
                SUM(bom_value)::text  AS total_bom
           FROM margin_fact
          WHERE avg_sale IS NOT NULL AND bom_cost IS NOT NULL AND bom_cost > avg_sale
            AND sale_value IS NOT NULL AND bom_value IS NOT NULL
            ${fyClause}
          GROUP BY item_code, segment
          ORDER BY (SUM(sale_value) - SUM(bom_value)) ASC
          LIMIT 50`,
        fyParam,
      ),
    ]);

    // Build monthly trend: { fy, month, [segment]: gcPct }
    const monthMap = new Map<string, Record<string, string | number | null>>();
    for (const r of monthly.rows) {
      const key = `${r.fy}|${r.month_label}`;
      if (!monthMap.has(key)) {
        monthMap.set(key, { fy: r.fy, month: r.month_label });
      }
      const sale  = parseFloat(r.total_sale);
      const bom   = parseFloat(r.total_bom);
      const gcPct = isFinite(sale) && isFinite(bom) && sale > 0
        ? ((sale - bom) / sale) * 100
        : null;
      const entry = monthMap.get(key)!;
      entry[r.segment] = gcPct;
    }
    const monthlyTrend = Array.from(monthMap.values());

    const segmentSummary = segSummary.rows.map((r) => {
      const sale  = parseFloat(r.total_sale);
      const bom   = parseFloat(r.total_bom);
      const gcPct = isFinite(sale) && isFinite(bom) && sale > 0
        ? ((sale - bom) / sale) * 100
        : null;
      return {
        segment:        r.segment,
        totalSaleValue: isFinite(sale) ? sale : 0,
        totalBomValue:  isFinite(bom)  ? bom  : 0,
        gcPct,
        monthCount:    parseInt(r.month_count, 10),
        negativeCodes: parseInt(r.neg_codes,   10),
      };
    });

    const negativeCodes = negCodes.rows.map((r) => {
      const sale  = parseFloat(r.total_sale);
      const bom   = parseFloat(r.total_bom);
      const gcPct = isFinite(sale) && isFinite(bom) && sale > 0
        ? ((sale - bom) / sale) * 100
        : null;
      return {
        itemCode:       r.item_code,
        segment:        r.segment,
        totalSaleValue: isFinite(sale) ? sale : 0,
        gcPct,
      };
    });

    res.json({ monthlyTrend, segmentSummary, negativeCodes });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
