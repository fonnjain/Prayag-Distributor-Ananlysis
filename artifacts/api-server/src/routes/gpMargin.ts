// GP Margin routes.
//
// POST /api/admin/margin/load  — admin-gated; parse all GP MARGIN workbooks
//                                from Google Drive and (re)populate margin_fact.
// GET  /api/margin/stats       — summary counts for the Margin page.
// GET  /api/margin/list        — paginated rows with optional segment/fy/q filters.

import { Router } from "express";
import { isAdminToken } from "../lib/adminAuth.js";
import { loadGpMarginFiles, fetchSegmentConflictDetail, detectGpMarginTabs, extractRows, fetchWorkbookViaDriveExport } from "../lib/gpMargin/loader.js";
import type { ConflictDetailRow } from "../lib/gpMargin/loader.js";
import { listDriveFiles, listDriveFolder, getDriveFileMeta } from "../lib/googleDrive.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

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

// ── DB-backed load state persistence ─────────────────────────────────────────
// Writes the current load state to the margin_load_job singleton row so the
// status survives server restarts. All writes are fire-and-forget; a DB
// failure is logged but never interrupts the load itself.

async function dbSetJob(state: JobState, segments?: string[]): Promise<void> {
  try {
    const now = new Date().toISOString();
    if (state.status === "idle") {
      await pool.query(
        `UPDATE margin_load_job
            SET status='idle', started_at=NULL, finished_at=NULL,
                segments=NULL, error_msg=NULL, report=NULL, updated_at=$1
          WHERE id=1`,
        [now],
      );
    } else if (state.status === "running") {
      await pool.query(
        `UPDATE margin_load_job
            SET status='running', started_at=$1, finished_at=NULL,
                segments=$2, error_msg=NULL, report=NULL, updated_at=$1
          WHERE id=1`,
        [state.startedAt, segments ?? null],
      );
    } else if (state.status === "done") {
      await pool.query(
        `UPDATE margin_load_job
            SET status='done', finished_at=$1, report=$2::jsonb,
                error_msg=NULL, updated_at=$1
          WHERE id=1`,
        [state.finishedAt, JSON.stringify(state.report)],
      );
    } else if (state.status === "error") {
      await pool.query(
        `UPDATE margin_load_job
            SET status='error', finished_at=$1, error_msg=$2,
                report=NULL, updated_at=$1
          WHERE id=1`,
        [state.finishedAt, state.error],
      );
    }
  } catch (err) {
    logger.warn({ err }, "[gpMargin] failed to persist load state to DB (non-fatal)");
  }
}

/**
 * Called once at server startup to restore the load state from DB into the
 * module-level loadJob. If the DB shows status='running' the previous server
 * process was killed mid-load — Postgres rolled back the transaction — so we
 * mark it as error so the status endpoint shows an actionable message and the
 * user knows to retrigger.
 */
export async function restoreMarginLoadJob(): Promise<void> {
  try {
    const { rows } = await pool.query<{
      status: string;
      started_at: string | null;
      finished_at: string | null;
      error_msg: string | null;
      report: object | null;
    }>(
      "SELECT status, started_at, finished_at, error_msg, report FROM margin_load_job WHERE id=1 LIMIT 1",
    );
    if (!rows[0]) return;
    const r = rows[0];
    if (r.status === "running") {
      // Server restarted while load was in progress — the DB transaction was
      // rolled back by Postgres; margin_fact is intact but no new rows landed.
      const msg = `Load killed by server restart (started ${r.started_at ?? "unknown"}, killed ${new Date().toISOString()})`;
      loadJob = { status: "error", finishedAt: new Date().toISOString(), error: msg };
      await pool.query(
        `UPDATE margin_load_job
            SET status='error', finished_at=now(), error_msg=$1, updated_at=now()
          WHERE id=1`,
        [msg],
      );
      logger.warn(
        { startedAt: r.started_at },
        "[gpMargin] margin load was running at startup — transaction rolled back, marked as killed",
      );
    } else if (r.status === "done" && r.report) {
      loadJob = {
        status: "done",
        finishedAt: r.finished_at ?? new Date().toISOString(),
        report: r.report,
      };
    } else if (r.status === "error" && r.error_msg) {
      loadJob = {
        status: "error",
        finishedAt: r.finished_at ?? new Date().toISOString(),
        error: r.error_msg,
      };
    }
    // idle: leave module default
  } catch (err) {
    logger.warn({ err }, "[gpMargin] could not restore margin load state from DB (non-fatal)");
  }
}

// ── PTMT conflict detail job ───────────────────────────────────────────────
// Read-only — never writes to margin_fact.  Fetches both Drive copies of
// PTMT Jan-26 / Feb-26 / Mar-26 and returns a side-by-side BOM comparison.

type ConflictDetailJob =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "done"; finishedAt: string; rows: ConflictDetailRow[] }
  | { status: "error"; finishedAt: string; error: string };

let conflictDetailJob: ConflictDetailJob = { status: "idle" };

// POST — start the fetch (fire-and-forget; each of the 6 files has a 90s timeout)
router.post("/admin/margin/ptmt-conflict-detail", (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required." });
    return;
  }
  if (conflictDetailJob.status === "running") {
    res.status(409).json({
      error: "Already running.",
      startedAt: (conflictDetailJob as { status: "running"; startedAt: string }).startedAt,
    });
    return;
  }
  const startedAt = new Date().toISOString();
  conflictDetailJob = { status: "running", startedAt };
  res.status(202).json({
    ok: true,
    status: "running",
    startedAt,
    message: "Poll GET /api/admin/margin/ptmt-conflict-detail/status for progress (~9 min worst-case).",
  });

  // Fire-and-forget
  fetchSegmentConflictDetail("PTMT", "2025-26", ["Jan-26", "Feb-26", "Mar-26"])
    .then((rows) => {
      conflictDetailJob = { status: "done", finishedAt: new Date().toISOString(), rows };
    })
    .catch((err) => {
      conflictDetailJob = {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: String(err instanceof Error ? err.message : err),
      };
    });
});

// GET — poll status / retrieve results
router.get("/admin/margin/ptmt-conflict-detail/status", (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required." });
    return;
  }
  res.json(conflictDetailJob);
});

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
      error: "Admin authorisation required. Pass ADMIN_SECRET as: X-Admin-Secret: <ADMIN_SECRET>",
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

  // Optional segment filter: POST body { segments: ["Garden Pipe", "Sink"] }
  // Limits the load to those segments only and scopes the DELETE to match.
  const rawSegments = req.body?.segments;
  const segments: string[] | undefined =
    Array.isArray(rawSegments)
      ? rawSegments.map(String).filter(Boolean)
      : typeof rawSegments === "string"
        ? rawSegments.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

  const startedAt = new Date().toISOString();
  loadJob = { status: "running", startedAt };
  void dbSetJob(loadJob, segments);
  const segMsg = segments && segments.length > 0
    ? `Segment-targeted load for: ${segments.join(", ")}. `
    : "Full load (177+ Drive exports, ~15 min). ";
  res.status(202).json({
    ok: true,
    status: "running",
    startedAt,
    segments: segments ?? "all",
    message:
      segMsg +
      "Poll GET /api/admin/margin/load-status with the same X-Admin-Secret header. " +
      "Rows appear in GET /api/margin/stats as they land.",
  });

  // Fire-and-forget — do NOT await
  loadGpMarginFiles({ segments })
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
          filesUnion:    report.filesUnion,
          filesConflict: report.filesConflict,
        },
      };
      void dbSetJob(loadJob);
    })
    .catch((err) => {
      loadJob = {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: String(err instanceof Error ? err.message : err),
      };
      void dbSetJob(loadJob);
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

// ── GET /api/admin/margin/folder-audit ───────────────────────────────────────
// Defect-2 investigation: list every file the Drive search sees in each
// GP MARGIN folder for the requested segments and FY, with filename +
// modifiedTime.  Does NOT download or parse workbooks — filename analysis only.
// Flags whether each file has a recognisable month label and which months
// are missing relative to a full 12-month FY.
//
// Query params:
//   ?segments=PTMT,Hardware   (comma-separated; default "PTMT,Hardware")
//   ?fy=2025-26               (default "2025-26")
router.get("/admin/margin/folder-audit", async (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) { res.status(401).json({ error: "Admin authorisation required." }); return; }

  const segmentsParam = typeof req.query.segments === "string" ? req.query.segments : "PTMT,Hardware";
  const fy            = typeof req.query.fy       === "string" ? req.query.fy       : "2025-26";
  const targetSegments = segmentsParam.split(",").map((s) => s.trim()).filter(Boolean);

  // Month-from-filename extraction.  Mirrors the loader's MONTH_CANON + MONTH_FY_HALF logic.
  const MONTH_ABBR: Record<string, string> = {
    jan: "Jan", january: "Jan",
    feb: "Feb", february: "Feb",
    mar: "Mar", march: "Mar",
    apr: "Apr", april: "Apr",
    may: "May",
    jun: "Jun", june: "Jun",
    jul: "Jul", july: "Jul",
    aug: "Aug", august: "Aug",
    sep: "Sep", sept: "Sep", september: "Sep",
    oct: "Oct", october: "Oct",
    nov: "Nov", november: "Nov",
    dec: "Dec", december: "Dec",
  };
  // FY2025-26: Apr-25..Sep-25 are first half (year=25), Oct-25..Mar-26 are second half (year=26).
  const SECOND_HALF = new Set(["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]);
  const [fyStart, fyEnd] = fy.split("-");
  const yearFirst = fyStart?.slice(-2) ?? "25";
  const yearSecond = fyEnd?.slice(-2) ?? "26";

  function extractMonthLabel(name: string): string | null {
    const lower = name.toLowerCase();
    for (const [key, canon] of Object.entries(MONTH_ABBR)) {
      const re = new RegExp(`\\b${key}\\b`, "i");
      if (re.test(lower)) {
        const year = SECOND_HALF.has(canon) ? yearSecond : yearFirst;
        return `${canon}-${year}`;
      }
    }
    return null;
  }

  const ALL_MONTHS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"]
    .map((m) => `${m}-${SECOND_HALF.has(m) ? yearSecond : yearFirst}`);

  try {
    const fyShort = fy.replace(/20(\d\d)-20?(\d\d)/, "$1-$2"); // "2025-26" → "25-26"
    const fyVariants = [fy, fyShort];                           // e.g. ["2025-26", "25-26"]

    // Replicate discoverSegmentFolders from the loader exactly.
    // Use the same generic "GP MARGIN" search (not segment-prefixed), then match
    // each folder name against the same regex patterns the loader uses.
    // Wrapper folders (name starts with "GP MARGIN FY") are scanned for children.
    const SEGMENT_PATTERNS: [RegExp, string][] = [
      [/waste\s*pipe/i, "Waste Pipe & Connection"],
      [/garden\s*pipe/i, "Garden Pipe"],
      [/sanitar/i,       "Sanitaryware"],
      [/plumb/i,         "Plumbing"],
      [/hardware/i,      "Hardware"],
      [/ptmt/i,          "PTMT"],
      [/\bcp\b|chrome/i, "CP"],
      [/sink/i,          "Sink"],
    ];
    function matchSegment(name: string): string | null {
      for (const [re, seg] of SEGMENT_PATTERNS) {
        if (re.test(name)) return seg;
      }
      return null;
    }

    type FolderEntry = { id: string; name: string };
    const segmentFolderMap = new Map<string, FolderEntry[]>();

    function addToMap(seg: string, entry: FolderEntry) {
      const arr = segmentFolderMap.get(seg) ?? [];
      if (!arr.some((e) => e.id === entry.id)) arr.push(entry);
      segmentFolderMap.set(seg, arr);
    }

    // Same single-search approach as the loader
    const searchResult = await listDriveFiles({ q: "GP MARGIN" });

    // _debug: return raw search results before any filtering so the caller can
    // verify what names and mimeTypes came back from Drive.
    const _debugRaw = searchResult.files.map((f) => ({
      name: f.name, mimeType: f.mimeType, id: f.id,
      modifiedTime: f.modifiedTime,
      matchesFY: fyVariants.some((v) => f.name.includes(v)),
      matchedSegment: matchSegment(f.name),
      isFolder: f.mimeType === "application/vnd.google-apps.folder",
      isWrapper: /^GP MARGIN FY/i.test(f.name.trim()),
    }));

    const wrapperIds: string[] = [];

    for (const item of searchResult.files) {
      if (item.mimeType !== "application/vnd.google-apps.folder") continue;
      if (!fyVariants.some((v) => item.name.includes(v))) continue;

      const isWrapper = /^GP MARGIN FY/i.test(item.name.trim());
      if (isWrapper) {
        wrapperIds.push(item.id);
      } else {
        const seg = matchSegment(item.name);
        if (seg && targetSegments.includes(seg)) {
          addToMap(seg, { id: item.id, name: item.name });
        }
      }
    }

    // Scan wrapper folders' children (same as scanFolder in the loader)
    const _debugWrapperChildren: { wrapperId: string; children: string[] }[] = [];
    for (const wrapperId of wrapperIds) {
      const children = await listDriveFolder(wrapperId);
      _debugWrapperChildren.push({ wrapperId, children: children.map((c) => c.name) });
      for (const child of children) {
        if (child.mimeType !== "application/vnd.google-apps.folder") continue;
        const seg = matchSegment(child.name);
        if (seg && targetSegments.includes(seg)) {
          addToMap(seg, { id: child.id, name: child.name });
        }
      }
    }

    const results: Record<string, {
      folders: FolderEntry[];
      files: {
        id: string; name: string; modifiedTime?: string;
        monthLabel: string | null;
        classification: "monthly" | "cumulative" | "summary" | "unknown";
        folderName: string;
      }[];
      missingMonths: string[];
    }> = {};

    type FileMeta = { id: string; name: string; modifiedTime?: string; monthLabel: string | null; classification: "monthly" | "cumulative" | "summary" | "unknown"; folderName: string };

    for (const seg of targetSegments) {
      const folders = segmentFolderMap.get(seg) ?? [];
      const allFiles: FileMeta[] = [];
      const seenIds = new Set<string>();

      for (const folder of folders) {
        const children = await listDriveFolder(folder.id);
        for (const child of children) {
          if (seenIds.has(child.id)) continue;
          seenIds.add(child.id);

          const isSpreadsheet =
            child.mimeType === "application/vnd.google-apps.spreadsheet" ||
            /\.(xlsx|xls)$/i.test(child.name);
          if (!isSpreadsheet) continue;

          const lname = child.name.toLowerCase();
          let classification: FileMeta["classification"] = "unknown";
          if (/cumul|annual|yearly|full.?year|ytd/i.test(lname)) {
            classification = "cumulative";
          } else if (/summary|summar/i.test(lname)) {
            classification = "summary";
          } else {
            const ml = extractMonthLabel(child.name);
            if (ml) classification = "monthly";
          }

          allFiles.push({
            id: child.id,
            name: child.name,
            modifiedTime: child.modifiedTime,
            monthLabel: extractMonthLabel(child.name),
            classification,
            folderName: folder.name,
          });
        }
      }

      allFiles.sort((a, b) => (a.monthLabel ?? a.name).localeCompare(b.monthLabel ?? b.name));

      const loadedMonths = new Set(
        allFiles
          .filter((f) => f.classification === "monthly" && f.monthLabel)
          .map((f) => f.monthLabel!),
      );
      const missingMonths = ALL_MONTHS.filter((m) => !loadedMonths.has(m));

      results[seg] = { folders, files: allFiles, missingMonths };
    }

    res.json({ ok: true, fy, segments: targetSegments, results, _debug: { rawCount: searchResult.files.length, raw: _debugRaw, wrapperChildren: _debugWrapperChildren } });
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
