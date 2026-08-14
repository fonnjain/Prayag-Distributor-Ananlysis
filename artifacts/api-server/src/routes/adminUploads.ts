// ── Admin master-load routes ──────────────────────────────────────────────────
// Runs the customer/product master CSV loaders IN-PROCESS against whatever DB
// this server is connected to. This is the only supported way to load the
// masters into the PRODUCTION database (the workspace has read-only access to
// prod). The CSVs are read from attached_assets/ on this server's own
// filesystem (latest timestamped upload wins); both loaders fully validate the
// files in memory before any DB mutation and are transactional/idempotent.
//
// Auth: X-Admin-Secret: <SESSION_SECRET> (same pattern as /admin/roster/refresh).
//
// The loads run in the background (the customer load parses a 37 MB CSV and
// rewrites ~80k rows — too slow for a request/response cycle behind a proxy):
//   POST /api/admin/masters/customer-load?dryRun=1   -> 202 { job }
//   POST /api/admin/masters/product-load?write=1     -> 202 { job }
//   GET  /api/admin/masters/load-status              -> per-job state + result
// Only one job of each kind may run at a time.
import { Router, raw, type Request, type Response } from "express";
import { readdirSync, existsSync, statSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { isAdminToken } from "../lib/adminAuth.js";
import { objectStorageClient } from "../lib/objectStorage.js";

const router = Router();

// ── Master CSV kinds ──────────────────────────────────────────────────────────
// The loaders resolve the LATEST attached_assets file matching these prefixes
// (see customerUploadLoad.latestAttached / productUploadLoad.latestProductCsv).
// Uploads are ALSO persisted to object storage under masters/<kind>.csv so a
// fresh deployment (empty local attached_assets) can restore them before a load.
type MasterKind = "distributor" | "retailer" | "product";
const MASTER_KINDS: Record<MasterKind, { prefix: string; label: string }> = {
  distributor: { prefix: "Distributer_Upload_Sample_File_", label: "Distributor master CSV" },
  retailer: { prefix: "Retailer_Upload_Sample_file_", label: "Retailer master CSV" },
  product: { prefix: "Product_Upload_Sample_File_", label: "Product master CSV" },
};
const isMasterKind = (v: string): v is MasterKind => v in MASTER_KINDS;

function attachedDirWritable(): string {
  for (const cand of [
    path.resolve(process.cwd(), "attached_assets"),
    path.resolve(process.cwd(), "../../attached_assets"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  // Fresh deployment container: create it next to cwd (repo root in prod).
  return path.resolve(process.cwd(), "attached_assets");
}

function latestLocal(kind: MasterKind): { path: string; mtimeMs: number; size: number } | null {
  const dir = attachedDirWritable();
  if (!existsSync(dir)) return null;
  const { prefix } = MASTER_KINDS[kind];
  const matches = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".csv")).sort();
  if (matches.length === 0) return null;
  const p = path.join(dir, matches[matches.length - 1]);
  const st = statSync(p);
  return { path: p, mtimeMs: st.mtimeMs, size: st.size };
}

function gcsFile(kind: MasterKind) {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) return null;
  return objectStorageClient.bucket(bucketId).file(`masters/${kind}.csv`);
}

async function writeLocalCsv(kind: MasterKind, buf: Buffer): Promise<string> {
  const dir = attachedDirWritable();
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${MASTER_KINDS[kind].prefix}${Date.now()}.csv`);
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, dest); // atomic: latestAttached never sees a partial file
  return dest;
}

/**
 * Ensures the latest uploaded CSV for `kind` exists locally where the loaders
 * look. If object storage holds a copy newer than the local latest (or there
 * is no local file at all — fresh deployment), it is downloaded first.
 */
async function ensureMasterCsvLocal(kind: MasterKind): Promise<void> {
  const file = gcsFile(kind);
  if (!file) {
    if (!latestLocal(kind)) throw new Error(`${MASTER_KINDS[kind].label}: no local file and object storage is not configured`);
    return;
  }
  const [exists] = await file.exists();
  const local = latestLocal(kind);
  if (!exists) {
    if (!local) throw new Error(`${MASTER_KINDS[kind].label}: not found locally or in object storage — upload it first`);
    return;
  }
  const [meta] = await file.getMetadata();
  const gcsUpdatedMs = meta.updated ? new Date(String(meta.updated)).getTime() : 0;
  if (local && local.mtimeMs >= gcsUpdatedMs) return; // local is current
  const [content] = await file.download();
  await writeLocalCsv(kind, content);
  console.log(`[masters] ${kind}: restored ${content.length} bytes from object storage`);
}

interface JobState {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  params: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
}
const emptyJob = (): JobState => ({ status: "idle", startedAt: null, finishedAt: null, params: null, result: null, error: null });
const jobs: Record<"customer" | "product", JobState> = { customer: emptyJob(), product: emptyJob() };

function requireAdmin(req: Request, res: Response): boolean {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required. Pass the SESSION_SECRET as: X-Admin-Secret: <SESSION_SECRET>" });
    return false;
  }
  return true;
}

function startJob(
  kind: "customer" | "product",
  params: Record<string, unknown>,
  run: () => Promise<unknown>,
  res: Response,
): void {
  const job = jobs[kind];
  if (job.status === "running") {
    res.status(409).json({ error: `${kind} load already running (started ${job.startedAt})` });
    return;
  }
  jobs[kind] = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, params, result: null, error: null };
  void run()
    .then((result) => {
      jobs[kind] = { ...jobs[kind], status: "done", finishedAt: new Date().toISOString(), result };
    })
    .catch((err: unknown) => {
      jobs[kind] = {
        ...jobs[kind],
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    });
  res.status(202).json({ ok: true, kind, params, note: "Load started in background. Poll GET /api/admin/masters/load-status." });
}

// ── CSV upload (raw body, not multipart). Content-Type text/csv keeps this
// outside the global express.json 20 MB limit; the retailer file is ~37 MB.
router.post(
  "/admin/masters/upload/:kind",
  raw({ type: () => true, limit: "120mb" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const kind = String(req.params.kind);
    if (!isMasterKind(kind)) {
      res.status(400).json({ error: `Unknown kind '${kind}'. Expected one of: ${Object.keys(MASTER_KINDS).join(", ")}` });
      return;
    }
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: "Empty upload body. Send the CSV bytes with Content-Type: text/csv." });
      return;
    }
    // Cheap sanity check before accepting: first line must look like a CSV header.
    const firstLine = buf.subarray(0, 4096).toString("latin1").split(/\r?\n/)[0] ?? "";
    if (!firstLine.includes(",")) {
      res.status(400).json({ error: "File does not look like a CSV (no comma in the first line). Not stored." });
      return;
    }
    try {
      const localPath = await writeLocalCsv(kind, buf);
      let persisted = false;
      let persistError: string | null = null;
      const file = gcsFile(kind);
      if (file) {
        try {
          await file.save(buf, { contentType: "text/csv", resumable: false });
          persisted = true;
        } catch (err) {
          persistError = err instanceof Error ? err.message : String(err);
        }
      } else {
        persistError = "DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set";
      }
      res.json({
        ok: true,
        kind,
        bytes: buf.length,
        storedAs: path.basename(localPath),
        persistedToObjectStorage: persisted,
        persistWarning: persisted ? null : `Upload accepted locally but NOT persisted to object storage (${persistError}); it will not survive a redeploy.`,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ── Per-kind file status: what the loaders would read right now. ─────────────
router.get("/admin/masters/files", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const out: Record<string, unknown> = {};
  for (const kind of Object.keys(MASTER_KINDS) as MasterKind[]) {
    const local = latestLocal(kind);
    let gcs: { exists: boolean; updated: string | null; size: number | null } = { exists: false, updated: null, size: null };
    const file = gcsFile(kind);
    if (file) {
      try {
        const [exists] = await file.exists();
        if (exists) {
          const [meta] = await file.getMetadata();
          gcs = { exists: true, updated: meta.updated ? String(meta.updated) : null, size: meta.size ? Number(meta.size) : null };
        }
      } catch {
        // object storage unreachable — report local state only
      }
    }
    out[kind] = {
      label: MASTER_KINDS[kind].label,
      local: local ? { file: path.basename(local.path), size: local.size, modified: new Date(local.mtimeMs).toISOString() } : null,
      objectStorage: gcs,
    };
  }
  res.json(out);
});

router.post("/admin/masters/customer-load", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const dryRun = String(req.query.dryRun ?? "") === "1";
  const { runCustomerUploadLoad } = await import("../lib/uploads/customerUploadLoad.js");
  startJob("customer", { dryRun }, async () => {
    // Fresh deployments have an empty attached_assets — restore from object
    // storage before the loader resolves its input files.
    await ensureMasterCsvLocal("distributor");
    await ensureMasterCsvLocal("retailer");
    return runCustomerUploadLoad({ dryRun });
  }, res);
});

router.post("/admin/masters/product-load", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const write = String(req.query.write ?? "") === "1";
  const { runProductUploadLoad } = await import("../lib/uploads/productUploadLoad.js");
  startJob("product", { write }, async () => {
    await ensureMasterCsvLocal("product");
    return runProductUploadLoad({ write });
  }, res);
});

router.get("/admin/masters/load-status", (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json(jobs);
});

// ── Scheme seed route ─────────────────────────────────────────────────────────
// POST /api/admin/schemes/load — truncates and re-inserts the five scheme
// tables from the Q2 FY2026-27 workbook seed data. Idempotent (truncate-then-
// insert). Runs inside a single transaction.
router.post("/admin/schemes/load", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const { pool } = await import("@workspace/db");
  const {
    TERRITORY_GROUPS,
    SCHEMES,
    SCHEME_SLABS,
    SCHEME_ITEM_GROUPS,
    SPECIAL_PRICING,
  } = await import("../lib/schemes/schemeSeedData.js");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Truncate in FK-safe order (children first)
    await client.query("TRUNCATE scheme_item_group, special_pricing, scheme_reward_slab, scheme, territory_group CASCADE");

    // Insert territory groups
    for (const tg of TERRITORY_GROUPS) {
      await client.query(
        `INSERT INTO territory_group (group_raw, label, states) VALUES ($1, $2, $3)`,
        [tg.groupRaw, tg.label, tg.states],
      );
    }

    // Insert schemes
    for (const s of SCHEMES) {
      await client.query(
        `INSERT INTO scheme
           (scheme_id, name, audience, settlement, qualification_basis,
            territory_group, product_scope, period_from, period_to, period_note,
            audience_source_term, funding_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          s.schemeId, s.name, s.audience, s.settlement, s.qualificationBasis,
          s.territoryGroup, s.productScope, s.periodFrom, s.periodTo, s.periodNote,
          s.audienceSourceTerm, s.fundingNote,
        ],
      );
    }

    // Insert slabs
    for (const sl of SCHEME_SLABS) {
      await client.query(
        `INSERT INTO scheme_reward_slab
           (scheme_id, slab_order, threshold_from, threshold_to, unit,
            rate, alt_reward, free_goods, reward_status, raw_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          sl.schemeId, sl.slabOrder, sl.thresholdFrom, sl.thresholdTo, sl.unit,
          sl.rate, sl.altReward, sl.freeGoods, sl.rewardStatus, sl.rawText,
        ],
      );
    }

    // Insert item groups
    for (const ig of SCHEME_ITEM_GROUPS) {
      await client.query(
        `INSERT INTO scheme_item_group (item_group, scheme_id) VALUES ($1, $2)`,
        [ig.itemGroup, ig.schemeId],
      );
    }

    // Insert special pricing
    for (const sp of SPECIAL_PRICING) {
      await client.query(
        `INSERT INTO special_pricing (customer_name, effective_from, effective_to, note, rate_rows)
         VALUES ($1, $2, $3, $4, $5)`,
        [sp.customerName, sp.effectiveFrom, sp.effectiveTo, sp.note, JSON.stringify(sp.rateRows)],
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      counts: {
        territoryGroups: TERRITORY_GROUPS.length,
        schemes: SCHEMES.length,
        slabs: SCHEME_SLABS.length,
        itemGroups: SCHEME_ITEM_GROUPS.length,
        specialPricing: SPECIAL_PRICING.length,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
});

// ── POST /api/admin/backfill-sale-channel ─────────────────────────────────────
// One-time route that reads the rate-list customer master (Google Sheets) and
// backfills the `channel` column on sale_line_all for the specified FYs.
// Idempotent: rows already having a non-null channel are left unchanged.
// Reports resolved / stayed-NULL counts and confirms total row count is unchanged.
//
// The same backfill now runs automatically at the end of every open-FY Sheets
// sync (registerSync.ts + routes/registers.ts), so this route is an ad-hoc
// escape hatch only.
//
// Auth: X-Admin-Secret (same as other admin routes).
// Body: { fys?: string[] }  — defaults to ["2026-27","2025-26"]
import { pool } from "@workspace/db";
import { backfillSaleChannel } from "../lib/sap/backfillChannel.js";
import { normalizeChannel } from "../lib/sap/derive.js";
import { getRateListMaps } from "../lib/sap/rateList.js";

router.post(
  "/admin/backfill-sale-channel",
  async (req: Request, res: Response): Promise<void> => {
    const token = String(req.headers["x-admin-secret"] ?? "");
    if (!isAdminToken(token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.body as { fys?: unknown };
    const fys: string[] =
      Array.isArray(body.fys) && body.fys.every((f) => typeof f === "string")
        ? (body.fys as string[])
        : ["2026-27", "2025-26"];

    try {
      // 1. Snapshot total row count + net before backfill
      const before = await pool.query<{ total_rows: string; total_net: string }>(
        `SELECT COUNT(*) AS total_rows, SUM(amount::numeric) AS total_net
         FROM sale_line_all WHERE fy = ANY($1::text[])`,
        [fys],
      );
      const beforeRows = parseInt(before.rows[0].total_rows, 10);
      const beforeNet = parseFloat(before.rows[0].total_net ?? "0");

      // 2. Run shared backfill (loads rate list, resolves, batch-updates).
      const backfill = await backfillSaleChannel(fys);

      // 3. Verify totals unchanged
      const after = await pool.query<{ total_rows: string; total_net: string }>(
        `SELECT COUNT(*) AS total_rows, SUM(amount::numeric) AS total_net
         FROM sale_line_all WHERE fy = ANY($1::text[])`,
        [fys],
      );
      const afterRows = parseInt(after.rows[0].total_rows, 10);
      const afterNet = parseFloat(after.rows[0].total_net ?? "0");

      if (afterRows !== beforeRows) {
        res.status(500).json({
          error: "INVARIANT VIOLATED: row count changed during backfill",
          beforeRows,
          afterRows,
        });
        return;
      }
      if (Math.abs(afterNet - beforeNet) > 1) {
        res.status(500).json({
          error: "INVARIANT VIOLATED: net amount changed during backfill",
          beforeNet,
          afterNet,
          delta: afterNet - beforeNet,
        });
        return;
      }

      // 4. Channel distribution after backfill
      const { rows: dist } = await pool.query<{ channel: string | null; cnt: string }>(
        `SELECT channel, COUNT(*) AS cnt
         FROM sale_line_all WHERE fy = ANY($1::text[])
         GROUP BY channel ORDER BY COUNT(*) DESC`,
        [fys],
      );

      // 5. Cross-check: head_canon non-territory vs channel non-Retail
      const { rows: cc } = await pool.query<{ head_count: string; channel_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE head_canon = 'Non-territory / Project / Govt') AS head_count,
           COUNT(*) FILTER (WHERE channel IN ('Govt','Project','JJM','Gem','Export')) AS channel_count
         FROM sale_line_current
         WHERE fy = ANY($1::text[])`,
        [fys],
      );

      // 6. Rate-list map counts per channel (for diagnostic transparency)
      const maps = await getRateListMaps();
      const channelMapCounts: Record<string, number> = {};
      for (const info of maps.customers.values()) {
        const ch = normalizeChannel(info.channel) ?? "NULL";
        channelMapCounts[ch] = (channelMapCounts[ch] ?? 0) + 1;
      }

      res.json({
        fys,
        beforeRows,
        afterRows,
        beforeNet: Math.round(beforeNet),
        afterNet: Math.round(afterNet),
        distinctCustomersProcessed: backfill.distinctNullCustomers,
        resolvedToChannel: backfill.resolved,
        stayedNull: backfill.residualCount,
        residualCustomers: backfill.residualCustomers,
        channelDistribution: dist.map((r) => ({ channel: r.channel, count: parseInt(r.cnt, 10) })),
        crossCheck: {
          headNonTerritoryCount: parseInt(cc[0].head_count, 10),
          channelNonRetailCount: parseInt(cc[0].channel_count, 10),
          gap: parseInt(cc[0].head_count, 10) - parseInt(cc[0].channel_count, 10),
        },
        rateListChannelCounts: channelMapCounts,
      });
    } catch (err) {
      req.log.error({ err }, "backfill-sale-channel failed");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ── POST /api/admin/backfill-customer-state-head ───────────────────────────────
// One-off derivation of customer_master.state_head from three sources:
//   1. Exact sale_line company-name match  (confidence='sale_line')
//   2. distributorTmMap → person_registry chain  (confidence='chain')
//   3. Single-head state lookup  (confidence='state_lookup')
// Protected by X-Admin-Secret. Advisory lock prevents concurrent runs.
router.post(
  "/admin/backfill-customer-state-head",
  async (req: Request, res: Response): Promise<void> => {
    const token = String(req.headers["x-admin-secret"] ?? "").trim();
    const { isAdminToken } = await import("../lib/adminAuth.js");
    if (!isAdminToken(token)) {
      res.status(401).json({ error: "Admin authorisation required." });
      return;
    }
    try {
      const { pool: dbPool } = await import("@workspace/db");
      const { runFullBackfill } = await import("../lib/customerStateHead.js");

      // Acquire a transaction-scoped advisory lock on a single client and run
      // ALL backfill queries through that same client so the lock truly covers
      // the work.  pg_advisory_xact_lock releases automatically on COMMIT/ROLLBACK.
      const client = await dbPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(74011002)");
        const counts = await runFullBackfill(client);
        await client.query("COMMIT");
        res.json({ ok: true, counts });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      req.log.error({ err }, "backfill-customer-state-head failed");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ── GET /api/admin/customer-state-head-report ─────────────────────────────────
// Returns a summary of customer_master state-head coverage:
//   - counts per head_confidence value (including NULL as 'Guessed')
//   - up to 100 unresolved (state_head IS NULL) sample rows with id, company,
//     state, and type so the data gap can be investigated and fixed.
// Optional query param: ?state=X  narrows the sample + unresolved count to one state.
// Protected by X-Admin-Secret.
router.get(
  "/admin/customer-state-head-report",
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    try {
      const { pool: dbPool } = await import("@workspace/db");
      const stateFilter = typeof req.query.state === "string" ? req.query.state.trim() : null;

      // Counts per head_confidence (NULL rows counted as 'Guessed' per the backfill convention)
      const { rows: confidenceCounts } = await dbPool.query<{
        confidence: string;
        count: string;
      }>(
        `SELECT COALESCE(head_confidence, 'Guessed') AS confidence,
                COUNT(*) AS count
           FROM customer_master
          GROUP BY COALESCE(head_confidence, 'Guessed')
          ORDER BY count DESC`,
      );

      // Unresolved sample: state_head IS NULL, optionally filtered by state
      const sampleParams: string[] = [];
      const stateClause = stateFilter
        ? (sampleParams.push(stateFilter), `AND state = $${sampleParams.length}`)
        : "";

      const { rows: unresolvedSample } = await dbPool.query<{
        id: string;
        company: string | null;
        state: string | null;
        type: string | null;
      }>(
        `SELECT id, company, state, type
           FROM customer_master
          WHERE state_head IS NULL
          ${stateClause}
          ORDER BY state NULLS LAST, company
          LIMIT 100`,
        sampleParams,
      );

      // Unresolved total count (same state filter)
      const { rows: unresolvedCountRows } = await dbPool.query<{ total: string }>(
        `SELECT COUNT(*) AS total
           FROM customer_master
          WHERE state_head IS NULL
          ${stateClause}`,
        sampleParams,
      );

      res.json({
        confidenceCounts: confidenceCounts.map((r) => ({
          confidence: r.confidence,
          count: Number(r.count),
        })),
        unresolved: {
          total: Number(unresolvedCountRows[0]?.total ?? 0),
          stateFilter: stateFilter ?? null,
          sample: unresolvedSample,
        },
      });
    } catch (err) {
      req.log.error({ err }, "customer-state-head-report failed");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

export default router;

