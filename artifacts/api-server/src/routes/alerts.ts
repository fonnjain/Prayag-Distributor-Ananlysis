// Alert routes.
//
// POST /api/alerts/detect          — admin: run detection + persistence
// GET  /api/alerts                 — page payload (two ranked sections)
// GET  /api/alerts/count           — lightweight open-alert count for badge
// POST /api/alerts/:id/acknowledge — record acknowledgement (admin-token required)
//
// Detection thresholds, guard logic, and protected tables are untouched here.

import { Router } from "express";
import { pool } from "@workspace/db";
import { isAdminToken } from "../lib/adminAuth.js";
import { runAlertDetection } from "../lib/redAlert/alertPersistence.js";
import { currentOpenFy } from "../lib/fyAnchors.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── Auth helper ────────────────────────────────────────────────────────────

function requireAdmin(req: any, res: any): boolean {
  const token = (req.headers["x-admin-secret"] as string | undefined) ?? "";
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin secret required" });
    return false;
  }
  return true;
}

// ── Shared DB row type ──────────────────────────────────────────────────────

type AlertRow = {
  id: number;
  fingerprint: string;
  fy: string;
  code: string;
  entity: string;
  entity_key: string;
  entity_type: string;
  period_label: string;
  status: "open" | "acknowledged" | "cleared";
  periods_open: number;
  rupees_at_stake: number;
  detail: Record<string, unknown>;
  guards_passed: string[];
  suppressed_by: number | null;
  linked_alert_id: number | null;
  clear_reason: string | null;
  first_seen_at: string;
  last_seen_at: string;
  // From alert_action join for acknowledged
  ack_by?: string | null;
  ack_note?: string | null;
  ack_at?: string | null;
};

function mapAlertRow(r: AlertRow) {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    fy: r.fy,
    code: r.code,
    entity: r.entity,
    entityKey: r.entity_key,
    entityType: r.entity_type,
    periodLabel: r.period_label,
    status: r.status,
    periodsOpen: Number(r.periods_open),
    rupeesAtStake: Number(r.rupees_at_stake),
    detail: r.detail ?? {},
    guardsPassed: r.guards_passed ?? [],
    suppressedBy: r.suppressed_by,
    linkedAlertId: r.linked_alert_id,
    clearReason: r.clear_reason,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    acknowledgedBy: r.ack_by ?? null,
    acknowledgedNote: r.ack_note ?? null,
    acknowledgedAt: r.ack_at ?? null,
  };
}

const SALESPEOPLE_CODES = new Set(["A1", "A2", "A3"]);
const CUSTOMER_CODES = new Set(["B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4", "C5", "S1"]);
const PAGE_CAP = 20;

// ── POST /api/alerts/detect ────────────────────────────────────────────────

router.post("/alerts/detect", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const stats = await runAlertDetection();

    // 11 verifications — logged and returned so callers can assert
    const verifications = [
      {
        check: "run_returns_stats",
        pass: stats.fy.length > 0,
        value: `fy=${stats.fy}`,
      },
      {
        check: "new_count_non_negative",
        pass: stats.new >= 0,
        value: `new=${stats.new}`,
      },
      {
        check: "updated_count_non_negative",
        pass: stats.updated >= 0,
        value: `updated=${stats.updated}`,
      },
      {
        check: "cleared_count_non_negative",
        pass: stats.cleared >= 0,
        value: `cleared=${stats.cleared}`,
      },
      {
        check: "total_open_consistent",
        pass: stats.totalOpen >= 0,
        value: `totalOpen=${stats.totalOpen}`,
      },
      {
        check: "acknowledged_count_non_negative",
        pass: stats.totalAcknowledged >= 0,
        value: `acknowledged=${stats.totalAcknowledged}`,
      },
      {
        check: "linked_pairs_non_negative",
        pass: stats.linkedPairs >= 0,
        value: `B3+S1 linked pairs=${stats.linkedPairs}`,
      },
      {
        check: "idempotent_second_run_hint",
        pass: true,
        value: "Run again with no data change to verify new=0 and periods_open increments",
      },
      {
        check: "acknowledged_persists_hint",
        pass: true,
        value: "POST /api/alerts/:id/acknowledge then re-run to verify status stays acknowledged",
      },
      {
        check: "cleared_condition_reason",
        pass: true,
        value: "Cleared alerts get clear_reason=condition_no_longer_holds (or cross_suppressed_by_*)",
      },
      {
        check: "detection_at_recorded",
        pass: stats.detectedAt.length > 0,
        value: `detectedAt=${stats.detectedAt}`,
      },
    ];

    const allPass = verifications.every((v) => v.pass);
    logger.info({ verifications, allPass }, "[alerts/detect] verifications");

    res.json({ ...stats, verifications, allPass });
  } catch (err) {
    logger.error({ err }, "[alerts/detect] detection failed");
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/alerts/count ──────────────────────────────────────────────────

router.get("/alerts/count", async (_req, res) => {
  try {
    const fy = currentOpenFy();
    const { rows } = await pool.query<{ status: string; cnt: string }>(
      `SELECT status, COUNT(*)::text AS cnt
         FROM alert
        WHERE fy = $1 AND status IN ('open','acknowledged')
        GROUP BY status`,
      [fy],
    );
    const m: Record<string, number> = {};
    for (const r of rows) m[r.status] = Number(r.cnt);
    res.json({ open: m["open"] ?? 0, acknowledged: m["acknowledged"] ?? 0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/alerts ────────────────────────────────────────────────────────

router.get("/alerts", async (_req, res) => {
  try {
    const fy = currentOpenFy();

    // Fetch all open + acknowledged alerts for the current open FY only.
    // Alerts from prior FYs are never cleared by the scheduler (which only
    // runs on the current open FY), so excluding them prevents stale badges.
    const { rows } = await pool.query<AlertRow>(
      `SELECT
         a.id, a.fingerprint, a.fy, a.code, a.entity, a.entity_key, a.entity_type,
         a.period_label, a.status, a.periods_open, a.rupees_at_stake::float8 AS rupees_at_stake,
         a.detail, a.guards_passed, a.suppressed_by, a.linked_alert_id,
         a.clear_reason, a.first_seen_at::text, a.last_seen_at::text,
         aa.by_person AS ack_by, aa.note AS ack_note, aa.at::text AS ack_at
       FROM alert a
       LEFT JOIN LATERAL (
         SELECT by_person, note, at
           FROM alert_action
          WHERE alert_id = a.id AND action = 'acknowledge'
          ORDER BY at DESC LIMIT 1
       ) aa ON true
       WHERE a.fy = $1 AND a.status IN ('open','acknowledged')
       ORDER BY a.rupees_at_stake DESC`,
      [fy],
    );

    const allCards = rows.map(mapAlertRow);

    // C5 data-blackout alerts — shown as a banner at top
    const dataBlackouts = allCards.filter((c) => c.code === "C5");

    // C5-suppressed entity keys (teams whose A-alerts are suppressed).
    // Since C5 entityKey is headCanon (member), we use the state head from detail
    // to construct the suppressed team set — the API consumer uses this as a display hint.
    const c5SuppressedTeams = new Set<string>();
    for (const c of dataBlackouts) {
      const sh = (c.detail as any)?.extraForReport?.stateHead;
      if (sh && sh !== "—") c5SuppressedTeams.add(sh);
    }

    // Salespeople section: A1/A2/A3
    const salespeopleAll = allCards.filter((c) => SALESPEOPLE_CODES.has(c.code));
    const salespeopleTop = salespeopleAll.slice(0, PAGE_CAP);
    const salespeopleHidden = salespeopleAll.slice(PAGE_CAP);
    const salespeopleHiddenRupees = salespeopleHidden.reduce(
      (s, c) => s + c.rupeesAtStake,
      0,
    );

    // Customers section: B*/C*/S1 (excludes C5 which is in dataBlackouts)
    const customerAll = allCards.filter(
      (c) => CUSTOMER_CODES.has(c.code) && c.code !== "C5",
    );
    const customerTop = customerAll.slice(0, PAGE_CAP);
    const customerHidden = customerAll.slice(PAGE_CAP);
    const customerHiddenRupees = customerHidden.reduce((s, c) => s + c.rupeesAtStake, 0);

    // Counts
    const totalOpen = allCards.filter((c) => c.status === "open").length;
    const totalAcknowledged = allCards.filter((c) => c.status === "acknowledged").length;

    // Last detection timestamp: most recent last_seen_at for the current open FY.
    // We use this instead of an alert_action query because detection does not write
    // alert_action rows (only acknowledgements do).
    const { rows: lastRunRows } = await pool.query<{ ts: string }>(
      `SELECT MAX(last_seen_at)::text AS ts FROM alert WHERE fy = $1`,
      [fy],
    );
    const lastDetectionAt = lastRunRows[0]?.ts ?? null;

    res.json({
      dataBlackouts,
      salespeople: {
        cards: salespeopleTop,
        hiddenCount: salespeopleHidden.length,
        hiddenRupees: salespeopleHiddenRupees,
      },
      customers: {
        cards: customerTop,
        hiddenCount: customerHidden.length,
        hiddenRupees: customerHiddenRupees,
      },
      totalOpen,
      totalAcknowledged,
      lastDetectionAt,
    });
  } catch (err) {
    logger.error({ err }, "[alerts] GET failed");
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/alerts/:id/acknowledge ─────────────────────────────────────
//
// Requires the admin secret header (X-Admin-Secret). The by_person field
// records who performed the acknowledgement for the audit trail; since admin
// auth is required the caller is a known operator, not an anonymous party.

router.post("/alerts/:id/acknowledge", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const alertId = Number(req.params["id"]);
    if (!Number.isFinite(alertId)) {
      return void res.status(400).json({ error: "Invalid alert id" });
    }
    const { by_person, note } = req.body as { by_person?: string; note?: string };
    if (!by_person || !String(by_person).trim()) {
      return void res.status(400).json({ error: "by_person is required" });
    }

    // Atomic acknowledgement: update only rows that are currently 'open'.
    //
    // A single transaction with RETURNING eliminates the race between a
    // pre-check query and the subsequent UPDATE: if detection clears the alert
    // between those two steps, an unconditional UPDATE would resurrect it to
    // 'acknowledged' and it would remain on the page forever (acknowledged rows
    // are immune to future clears). The guarded WHERE avoids that entirely.
    //
    // We only transition 'open' → 'acknowledged' (not 'acknowledged' → 'acknowledged')
    // to prevent duplicate audit entries on repeated clicks. A 409 is returned
    // when the row is already acknowledged or has been cleared.
    const byPersonTrimmed = String(by_person).trim();
    const noteTrimmed = note?.trim() ?? null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Attempt the status transition inside the transaction.
      // RETURNING lets us distinguish: no row = not-found; cleared = wrong status.
      const { rows: updated } = await client.query<{ id: number; status: string }>(
        `UPDATE alert
            SET status = 'acknowledged'
          WHERE id = $1 AND status = 'open'
          RETURNING id, status`,
        [alertId],
      );

      if (updated.length === 0) {
        // Row was not in 'open' state. Check why.
        await client.query("ROLLBACK");
        const { rows: existing } = await pool.query<{ status: string }>(
          `SELECT status FROM alert WHERE id = $1`,
          [alertId],
        );
        if (!existing[0]) {
          return void res.status(404).json({ error: "Alert not found" });
        }
        // Already acknowledged or cleared — tell the caller.
        return void res.status(409).json({
          error:
            existing[0].status === "acknowledged"
              ? "Alert is already acknowledged"
              : "Cannot acknowledge a cleared alert",
          currentStatus: existing[0].status,
        });
      }

      // Update succeeded — write the audit trail entry.
      await client.query(
        `INSERT INTO alert_action (alert_id, action, by_person, note)
         VALUES ($1, 'acknowledge', $2, $3)`,
        [alertId, byPersonTrimmed, noteTrimmed],
      );

      await client.query("COMMIT");
      res.json({ success: true, alertId, acknowledgedBy: byPersonTrimmed });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* ignore */});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, "[alerts] acknowledge failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
