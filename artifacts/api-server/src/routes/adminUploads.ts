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
import { Router, type Request, type Response } from "express";
import { isAdminToken } from "../lib/adminAuth.js";

const router = Router();

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

router.post("/admin/masters/customer-load", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const dryRun = String(req.query.dryRun ?? "") === "1";
  const { runCustomerUploadLoad } = await import("../lib/uploads/customerUploadLoad.js");
  startJob("customer", { dryRun }, () => runCustomerUploadLoad({ dryRun }), res);
});

router.post("/admin/masters/product-load", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const write = String(req.query.write ?? "") === "1";
  const { runProductUploadLoad } = await import("../lib/uploads/productUploadLoad.js");
  startJob("product", { write }, () => runProductUploadLoad({ write }), res);
});

router.get("/admin/masters/load-status", (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json(jobs);
});

export default router;
