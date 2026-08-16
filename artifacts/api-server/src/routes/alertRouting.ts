/**
 * Alert routing routes.
 *
 * Recipients:          CRUD for alert_recipient rows.
 * Severity config:     Read + patch for alert_severity_config rows.
 * Escalation config:   Read + patch for alert_escalation_config rows.
 * Actions:             Notify, digest, escalate (all support dryRun flag).
 * Deliveries:          GET delivery log for a specific alert.
 */
import { Router, Request, Response } from "express";
import { pool } from "@workspace/db";
import { notifyAlert } from "../lib/alertRouting/notify.js";
import { buildDigest, runDigestAll } from "../lib/alertRouting/digest.js";
import { runEscalation } from "../lib/alertRouting/escalate.js";
import { invalidateSeverityCache } from "../lib/alertRouting/severity.js";

function requireAdmin(req: Request, res: Response): boolean {
  const secret = (req as any).headers["x-admin-secret"];
  const expected = process.env["SESSION_SECRET"];
  if (!expected || secret !== expected) {
    (res as any).status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

const requireAdminSecret = (req: Request, res: Response, next: () => void) => {
  if (!requireAdmin(req, res)) return;
  next();
};

export const alertRoutingRouter = Router();

// ─── Recipients ───────────────────────────────────────────────────────────

alertRoutingRouter.get("/alert-recipients", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, alert_code_pattern, scope_type, scope_value, escalation_level,
              name, channel, contact, cadence, is_active, created_at, updated_at
       FROM alert_recipient ORDER BY escalation_level, name`,
    );
    // Attach level coverage summary
    const { rows: levelCounts } = await pool.query(
      `SELECT escalation_level, COUNT(*) AS cnt
       FROM alert_recipient WHERE is_active = TRUE
       GROUP BY escalation_level`,
    );
    const byLevel: Record<number, number> = {};
    for (const r of levelCounts) byLevel[r.escalation_level] = Number(r.cnt);
    const emptyLevels = [1, 2, 3].filter((l) => !byLevel[l]);
    res.json({ recipients: rows, byLevel, emptyLevels });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

alertRoutingRouter.post(
  "/alert-recipients",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const {
      alert_code_pattern,
      scope_type = "all_india",
      scope_value = null,
      escalation_level = 1,
      name,
      channel,
      contact = null,
      cadence = "weekly",
    } = req.body as Record<string, unknown>;

    if (!alert_code_pattern || !name || !channel) {
      res.status(400).json({ error: "alert_code_pattern, name, channel are required" });
      return;
    }
    if (!["whatsapp", "email", "in_app"].includes(channel as string)) {
      res.status(400).json({ error: "channel must be whatsapp | email | in_app" });
      return;
    }
    if (!["state_head", "all_india"].includes(scope_type as string)) {
      res.status(400).json({ error: "scope_type must be state_head | all_india" });
      return;
    }
    if (!["on_raise", "weekly"].includes(cadence as string)) {
      res.status(400).json({ error: "cadence must be on_raise | weekly" });
      return;
    }
    if (![1, 2, 3].includes(escalation_level as number)) {
      res.status(400).json({ error: "escalation_level must be 1, 2 or 3" });
      return;
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO alert_recipient
           (alert_code_pattern, scope_type, scope_value, escalation_level,
            name, channel, contact, cadence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          alert_code_pattern,
          scope_type,
          scope_value,
          escalation_level,
          name,
          channel,
          contact,
          cadence,
        ],
      );
      res.status(201).json({ recipient: rows[0] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

alertRoutingRouter.patch(
  "/alert-recipients/:id",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const fields = req.body as Record<string, unknown>;

    const allowed = [
      "alert_code_pattern",
      "scope_type",
      "scope_value",
      "escalation_level",
      "name",
      "channel",
      "contact",
      "cadence",
      "is_active",
    ];
    const sets: string[] = ["updated_at = NOW()"];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (vals.length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }
    vals.push(id);
    try {
      const { rows } = await pool.query(
        `UPDATE alert_recipient SET ${sets.join(", ")}
         WHERE id = $${vals.length} RETURNING *`,
        vals,
      );
      if (!rows[0]) { res.status(404).json({ error: "Recipient not found" }); return; }
      res.json({ recipient: rows[0] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

alertRoutingRouter.delete(
  "/alert-recipients/:id",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    try {
      const { rows } = await pool.query(
        `UPDATE alert_recipient SET is_active=FALSE, updated_at=NOW()
         WHERE id=$1 RETURNING id`,
        [id],
      );
      if (!rows[0]) { res.status(404).json({ error: "Recipient not found" }); return; }
      res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ─── Severity config ──────────────────────────────────────────────────────

alertRoutingRouter.get("/alert-severity-config", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code_pattern, is_severe, escalation_window_days, updated_at
       FROM alert_severity_config ORDER BY id`,
    );
    res.json({ configs: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

alertRoutingRouter.patch(
  "/alert-severity-config/:pattern",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const pattern = req.params.pattern;
    const { is_severe, escalation_window_days } = req.body as Record<string, unknown>;
    try {
      const { rows } = await pool.query(
        `UPDATE alert_severity_config
         SET is_severe = COALESCE($2::boolean, is_severe),
             escalation_window_days = COALESCE($3::int, escalation_window_days),
             updated_at = NOW()
         WHERE code_pattern = $1 RETURNING *`,
        [pattern, is_severe ?? null, escalation_window_days ?? null],
      );
      if (!rows[0]) { res.status(404).json({ error: "Config not found" }); return; }
      invalidateSeverityCache();
      res.json({ config: rows[0] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ─── Escalation config ────────────────────────────────────────────────────

alertRoutingRouter.get("/alert-escalation-config", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT level, window_days_severe, window_days_digest, updated_at
       FROM alert_escalation_config ORDER BY level`,
    );
    res.json({ configs: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

alertRoutingRouter.patch(
  "/alert-escalation-config/:level",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const level = Number(req.params.level);
    const { window_days_severe, window_days_digest } = req.body as Record<string, unknown>;
    try {
      const { rows } = await pool.query(
        `UPDATE alert_escalation_config
         SET window_days_severe = COALESCE($2::int, window_days_severe),
             window_days_digest  = COALESCE($3::int, window_days_digest),
             updated_at = NOW()
         WHERE level = $1 RETURNING *`,
        [level, window_days_severe ?? null, window_days_digest ?? null],
      );
      if (!rows[0]) { res.status(404).json({ error: "Config not found" }); return; }
      res.json({ config: rows[0] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ─── Actions ──────────────────────────────────────────────────────────────

/** POST /api/alert-routing/notify/:alertId */
alertRoutingRouter.post(
  "/alert-routing/notify/:alertId",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const alertId = Number(req.params.alertId);
    const dryRun = req.body?.dry_run !== false;
    const triggerType: "on_raise" | "escalation" =
      req.body?.trigger_type === "escalation" ? "escalation" : "on_raise";
    try {
      const deliveries = await notifyAlert(alertId, { dryRun, triggerType });
      res.json({ dryRun, alertId, deliveries, count: deliveries.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

/** POST /api/alert-routing/digest/:recipientId */
alertRoutingRouter.post(
  "/alert-routing/digest/:recipientId",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const recipientId = Number(req.params.recipientId);
    const dryRun = req.body?.dry_run !== false;
    const fy = (req.body?.fy as string | undefined) ?? "2026-27";
    try {
      const result = await buildDigest(recipientId, { dryRun, fy });
      res.json({ dryRun, ...result });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

/** POST /api/alert-routing/digest/all */
alertRoutingRouter.post(
  "/alert-routing/digest/all",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const dryRun = req.body?.dry_run !== false;
    const fy = (req.body?.fy as string | undefined) ?? "2026-27";
    try {
      const results = await runDigestAll({ dryRun, fy });
      res.json({
        dryRun,
        results,
        summary: {
          total: results.length,
          skipped: results.filter((r) => r.skipped).length,
          sent: results.filter((r) => !r.skipped).length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

/** POST /api/alert-routing/escalate */
alertRoutingRouter.post(
  "/alert-routing/escalate",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const dryRun = req.body?.dry_run !== false;
    try {
      const results = await runEscalation({ dryRun });
      res.json({ dryRun, results, count: results.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ─── Delivery log ─────────────────────────────────────────────────────────

/** GET /api/alerts/:id/deliveries */
alertRoutingRouter.get(
  "/alerts/:id/deliveries",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    try {
      const { rows } = await pool.query(
        `SELECT
           ad.id,
           ad.alert_id,
           ad.recipient_id,
           COALESCE(ar.name, '(level skipped — no recipient)') AS recipient_name,
           ad.channel,
           ad.escalation_level,
           ad.trigger_type,
           ad.status,
           ad.skip_reason,
           ad.sent_at,
           ad.acknowledged_at,
           ad.message_body,
           ad.created_at
         FROM alert_delivery ad
         LEFT JOIN alert_recipient ar ON ar.id = ad.recipient_id
         WHERE ad.alert_id = $1
         ORDER BY ad.created_at DESC`,
        [id],
      );
      res.json({ deliveries: rows });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);
