// Master Organisation — Phase 2 people management + Phase 3 customer management.
//
// Rules enforced here:
// - No hard deletes on person. Deactivation sets is_active=false.
// - Every mutation writes to change_log.
// - Deactivation and reports_to changes require an impact acknowledgment:
//   the client must pass back the subTreeCount and totalCustomers it was
//   shown; the server re-verifies and rejects on mismatch (HTTP 409).
// - Cycle guard: a new reports_to is rejected if it is a descendant of the
//   person being edited (would create a loop in the hierarchy).
// - Customer reassignment uses effective dating: the old assignment row is
//   closed (effective_to = today) and a new row is opened. This keeps
//   historical FY analytics stable — sale_line.head_canon is never touched.
import { Router } from "express";
import { pool } from "@workspace/db";
import { isAdminToken } from "../lib/adminAuth.js";

const router = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────

function requireAdmin(req: any, res: any): boolean {
  const token =
    (req.headers["x-admin-secret"] as string | undefined) ?? "";
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin secret required" });
    return false;
  }
  return true;
}

// ── GET /api/master/designations ──────────────────────────────────────────────

router.get("/master/designations", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT designation_id, name, rank
       FROM designation
       ORDER BY rank`,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people ────────────────────────────────────────────────────
// Paginated list of people with optional search and filters.
// Query params: q (name search), active (true/false/all), designation_id, page, limit

router.get("/master/people", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const activeFilter = String(req.query.active ?? "all");
    const desigId = req.query.designation_id
      ? Number(req.query.designation_id)
      : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: unknown[] = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`p.name ILIKE $${params.length}`);
    }
    if (activeFilter === "true") where.push("p.is_active = true");
    else if (activeFilter === "false") where.push("p.is_active = false");

    if (desigId !== null) {
      params.push(desigId);
      where.push(`p.designation_id = $${params.length}`);
    }

    const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM person p ${wc}`, params),
      pool.query(
        `SELECT p.person_id,
                p.name,
                p.employee_code,
                p.is_active,
                p.is_state_head,
                p.headquarter,
                d.name AS designation_name,
                d.rank AS designation_rank,
                (SELECT COUNT(*) FROM person sub WHERE sub.reports_to_person_id = p.person_id) AS direct_report_count,
                (SELECT COUNT(*) FROM customer_assignment ca WHERE ca.state_head_person_id = p.person_id AND ca.effective_to IS NULL) AS customers_as_state_head,
                (SELECT COUNT(*) FROM customer_assignment ca WHERE ca.person_id = p.person_id AND ca.effective_to IS NULL) AS customers_as_tm
         FROM person p
         LEFT JOIN designation d ON d.designation_id = p.designation_id
         ${wc}
         ORDER BY p.is_active DESC, d.rank ASC NULLS LAST, p.name
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({ total: Number(countRes.rows[0].count), people: dataRes.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people/:id ────────────────────────────────────────────────
// Full detail for one person: identity, reporting chain, direct reports,
// territories, customer-scope stats, and change log.

router.get("/master/people/:id", async (req, res) => {
  try {
    const personId = Number(req.params.id);

    const [personRes, directRes, chainRes, terrRes, logRes] =
      await Promise.all([
        pool.query(
          `SELECT p.person_id, p.name, p.employee_code, p.is_active,
                  p.is_state_head, p.headquarter, p.order_type, p.source,
                  d.designation_id, d.name AS designation_name,
                  mgr.person_id AS manager_id, mgr.name AS manager_name,
                  sh.person_id  AS state_head_id, sh.name AS state_head_name,
                  (SELECT COUNT(*) FROM customer_assignment ca
                   WHERE ca.state_head_person_id = p.person_id AND ca.effective_to IS NULL
                  ) AS customers_as_state_head,
                  (SELECT COUNT(*) FROM customer_assignment ca
                   WHERE ca.person_id = p.person_id AND ca.effective_to IS NULL
                  ) AS customers_as_tm
           FROM person p
           LEFT JOIN designation  d   ON d.designation_id = p.designation_id
           LEFT JOIN person       mgr ON mgr.person_id    = p.reports_to_person_id
           LEFT JOIN person       sh  ON sh.person_id     = p.state_head_person_id
           WHERE p.person_id = $1`,
          [personId],
        ),
        // Direct reports
        pool.query(
          `SELECT p.person_id, p.name, p.is_active, d.name AS designation_name
           FROM person p
           LEFT JOIN designation d ON d.designation_id = p.designation_id
           WHERE p.reports_to_person_id = $1
           ORDER BY p.name`,
          [personId],
        ),
        // Reporting chain upward (up to 10 levels)
        pool.query(
          `WITH RECURSIVE chain AS (
             SELECT p.person_id, p.name, p.reports_to_person_id, 1 AS depth
             FROM person p WHERE p.person_id = $1
             UNION ALL
             SELECT p.person_id, p.name, p.reports_to_person_id, c.depth + 1
             FROM person p JOIN chain c ON c.reports_to_person_id = p.person_id
             WHERE c.depth < 10
           )
           SELECT person_id, name, depth FROM chain
           WHERE person_id <> $1
           ORDER BY depth`,
          [personId],
        ),
        // Territories
        pool.query(
          `SELECT t.territory_id, t.name, t.type, pt.effective_from::text, pt.effective_to::text
           FROM person_territory pt
           JOIN territory t ON t.territory_id = pt.territory_id
           WHERE pt.person_id = $1 AND pt.effective_to IS NULL
           ORDER BY t.name`,
          [personId],
        ),
        // Change log
        pool.query(
          `SELECT field, old_value, new_value, changed_by, changed_at::text
           FROM change_log
           WHERE entity_type = 'person' AND entity_id = $1
           ORDER BY changed_at DESC
           LIMIT 50`,
          [String(personId)],
        ),
      ]);

    if (!personRes.rows[0])
      return void res.status(404).json({ error: "Person not found" });

    const p = personRes.rows[0];
    const csh = Number(p.customers_as_state_head);
    const ctm = Number(p.customers_as_tm);

    res.json({
      person: p,
      directReports: directRes.rows,
      reportingChain: chainRes.rows,
      territories: terrRes.rows,
      changeLog: logRes.rows,
      customerScope: {
        asStateHead: csh,
        asTm: ctm,
        total: csh + ctm,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people/:id/impact ────────────────────────────────────────
// Pre-mutation impact check. Returns the full sub-tree count and customer
// counts that must be acknowledged before deactivation or manager reassignment.

router.get("/master/people/:id/impact", async (req, res) => {
  try {
    const personId = Number(req.params.id);

    // Full subtree (recursive, not just direct reports)
    const treeRes = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT person_id FROM person WHERE reports_to_person_id = $1
         UNION ALL
         SELECT p.person_id FROM person p JOIN tree t ON t.person_id = p.reports_to_person_id
       )
       SELECT person_id FROM tree`,
      [personId],
    );

    const subTreeCount = treeRes.rows.length;
    const subTreeIds = treeRes.rows.map((r: { person_id: number }) => r.person_id);

    // Direct reports (names for display)
    const directRes = await pool.query(
      `SELECT person_id, name FROM person WHERE reports_to_person_id = $1 ORDER BY name`,
      [personId],
    );

    // Customers assigned as state head or TM (open assignments only)
    const custRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ca.state_head_person_id = $1) AS as_state_head,
         COUNT(*) FILTER (WHERE ca.person_id = $1)            AS as_tm
       FROM customer_assignment ca
       WHERE ca.effective_to IS NULL
         AND (ca.state_head_person_id = $1 OR ca.person_id = $1)`,
      [personId],
    );

    const csh = Number(custRes.rows[0]?.as_state_head ?? 0);
    const ctm = Number(custRes.rows[0]?.as_tm ?? 0);

    // Person name
    const nameRes = await pool.query(
      `SELECT name FROM person WHERE person_id = $1`,
      [personId],
    );

    res.json({
      person: nameRes.rows[0] ?? null,
      directReports: directRes.rows,
      subTreeCount,
      subTreeIds,
      customersAsStateHead: csh,
      customersAsTm: ctm,
      totalCustomersAffected: csh + ctm,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PATCH /api/master/people/:id ──────────────────────────────────────────────
// Edit name, employee_code, designation_id, reports_to_person_id.
// Changing reports_to requires the client to pass acknowledged sub-tree
// and customer counts from a prior /impact call; server re-verifies.

router.patch("/master/people/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const personId = Number(req.params.id);
    const {
      name,
      employee_code,
      designation_id,
      reports_to_person_id,
      acknowledgedSubTree,
      acknowledgedCustomers,
      changed_by,
    } = req.body as {
      name?: string;
      employee_code?: string;
      designation_id?: number | null;
      reports_to_person_id?: number | null;
      acknowledgedSubTree?: number;
      acknowledgedCustomers?: number;
      changed_by?: string;
    };

    // Read current state
    const current = await pool.query(
      `SELECT name, employee_code, designation_id, reports_to_person_id
       FROM person WHERE person_id = $1`,
      [personId],
    );
    if (!current.rows[0])
      return void res.status(404).json({ error: "Person not found" });
    const prev = current.rows[0];

    // If reports_to is changing, require impact acknowledgment
    const reportsToChanging =
      reports_to_person_id !== undefined &&
      reports_to_person_id !== prev.reports_to_person_id;

    if (reportsToChanging) {
      if (acknowledgedSubTree === undefined || acknowledgedCustomers === undefined) {
        return void res.status(422).json({
          error:
            "Changing reports_to requires acknowledgedSubTree and acknowledgedCustomers from /impact",
        });
      }

      // Cycle guard
      if (reports_to_person_id !== null) {
        const cycleCheck = await pool.query(
          `WITH RECURSIVE tree AS (
             SELECT person_id FROM person WHERE reports_to_person_id = $1
             UNION ALL
             SELECT p.person_id FROM person p JOIN tree t ON t.person_id = p.reports_to_person_id
           )
           SELECT 1 FROM tree WHERE person_id = $2 LIMIT 1`,
          [personId, reports_to_person_id],
        );
        if (cycleCheck.rowCount)
          return void res.status(400).json({ error: "Cycle detected: new manager is a descendant of this person" });
      }

      // Re-verify impact
      const impactRes = await pool.query(
        `WITH RECURSIVE tree AS (
           SELECT person_id FROM person WHERE reports_to_person_id = $1
           UNION ALL
           SELECT p.person_id FROM person p JOIN tree t ON t.person_id = p.reports_to_person_id
         )
         SELECT COUNT(*) AS sub_tree FROM tree`,
        [personId],
      );
      const custRes = await pool.query(
        `SELECT COUNT(*) AS cust FROM customer_assignment
         WHERE effective_to IS NULL
           AND (state_head_person_id = $1 OR person_id = $1)`,
        [personId],
      );
      const liveSubTree = Number(impactRes.rows[0].sub_tree);
      const liveCust = Number(custRes.rows[0].cust);

      if (liveSubTree !== acknowledgedSubTree || liveCust !== acknowledgedCustomers) {
        return void res.status(409).json({
          error: "Impact has changed since preview — please re-fetch /impact and confirm again.",
          current: { subTreeCount: liveSubTree, totalCustomersAffected: liveCust },
        });
      }
    }

    // Apply updates and write change log
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const fields: { col: string; val: unknown }[] = [];
      if (name !== undefined && name !== prev.name) fields.push({ col: "name", val: name });
      if (employee_code !== undefined && employee_code !== prev.employee_code)
        fields.push({ col: "employee_code", val: employee_code });
      if (designation_id !== undefined && designation_id !== prev.designation_id)
        fields.push({ col: "designation_id", val: designation_id });
      if (reportsToChanging)
        fields.push({ col: "reports_to_person_id", val: reports_to_person_id });

      if (fields.length === 0) {
        await client.query("ROLLBACK");
        return void res.json({ success: true, changed: false });
      }

      const setClauses = fields
        .map((f, i) => `${f.col} = $${i + 2}`)
        .join(", ");
      await client.query(
        `UPDATE person SET ${setClauses} WHERE person_id = $1`,
        [personId, ...fields.map((f) => f.val)],
      );

      for (const f of fields) {
        await client.query(
          `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
           VALUES ('person', $1, $2, $3, $4, $5)`,
          [
            String(personId),
            f.col,
            String((prev as any)[f.col] ?? ""),
            String(f.val ?? ""),
            changed_by ?? "operator",
          ],
        );
      }

      await client.query("COMMIT");
      res.json({ success: true, changed: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/people/:id/deactivate ────────────────────────────────────
// Deactivate a person. Refuses to proceed unless the client acknowledges the
// exact sub-tree count and customer count from a prior /impact call.

router.post("/master/people/:id/deactivate", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const personId = Number(req.params.id);
    const { acknowledgedSubTree, acknowledgedCustomers, changed_by } =
      req.body as {
        acknowledgedSubTree?: number;
        acknowledgedCustomers?: number;
        changed_by?: string;
      };

    if (acknowledgedSubTree === undefined || acknowledgedCustomers === undefined) {
      return void res.status(422).json({
        error:
          "Must pass acknowledgedSubTree and acknowledgedCustomers (from /impact) to confirm awareness of impact.",
      });
    }

    // Re-verify impact server-side
    const impactRes = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT person_id FROM person WHERE reports_to_person_id = $1
         UNION ALL
         SELECT p.person_id FROM person p JOIN tree t ON t.person_id = p.reports_to_person_id
       )
       SELECT COUNT(*) AS sub_tree FROM tree`,
      [personId],
    );
    const custRes = await pool.query(
      `SELECT COUNT(*) AS cust FROM customer_assignment
       WHERE effective_to IS NULL
         AND (state_head_person_id = $1 OR person_id = $1)`,
      [personId],
    );
    const liveSubTree = Number(impactRes.rows[0].sub_tree);
    const liveCust = Number(custRes.rows[0].cust);

    if (liveSubTree !== acknowledgedSubTree || liveCust !== acknowledgedCustomers) {
      return void res.status(409).json({
        error:
          "Impact has changed since preview — please re-fetch /impact and confirm again.",
        current: { subTreeCount: liveSubTree, totalCustomersAffected: liveCust },
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE person SET is_active = false WHERE person_id = $1`,
        [personId],
      );

      // Log the deactivation and the acknowledged impact
      await client.query(
        `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
         VALUES
           ('person', $1, 'is_active',                     'true',  'false', $2),
           ('person', $1, 'deactivation_impact_acknowledged', NULL, $3,      $2)`,
        [
          String(personId),
          changed_by ?? "operator",
          JSON.stringify({ subTreeCount: liveSubTree, totalCustomersAffected: liveCust }),
        ],
      );

      await client.query("COMMIT");
      res.json({
        success: true,
        impact: { subTreeCount: liveSubTree, totalCustomersAffected: liveCust },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/people/:id/reactivate ────────────────────────────────────

router.post("/master/people/:id/reactivate", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const personId = Number(req.params.id);
    const { changed_by } = req.body as { changed_by?: string };

    await pool.query(
      `UPDATE person SET is_active = true WHERE person_id = $1`,
      [personId],
    );
    await pool.query(
      `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
       VALUES ('person', $1, 'is_active', 'false', 'true', $2)`,
      [String(personId), changed_by ?? "operator"],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/unresolved-links ─────────────────────────────────────────
// The distributor names from the seed that matched no customer row.
// Surfaced in Phase 3 UI so operators can map or confirm gone.

router.get("/master/unresolved-links", async (_req, res) => {
  try {
    const { rows } = await pool.query<{
      id: number;
      raw_name: string;
      link_count: number;
      notes: string | null;
      resolution: string | null;
      mapped_to_id: string | null;
      resolved_by: string | null;
      resolved_at: string | null;
    }>(
      `SELECT id, raw_name, link_count, notes, resolution, mapped_to_id,
              resolved_by, resolved_at::text
       FROM seed_unresolved_link
       ORDER BY link_count DESC`,
    );
    const totalLostLinks = rows.reduce((s, r) => s + r.link_count, 0);
    res.json({ items: rows, totalLostLinks, unresolvedCount: rows.filter(r => !r.resolution).length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/unresolved-links/:id/resolve ─────────────────────────────
// Mark a seed unresolved link as mapped or confirmed gone.

router.post("/master/unresolved-links/:id/resolve", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const linkId = Number(req.params.id);
    const { action, mapped_to_id, resolved_by } = req.body as {
      action: "map" | "confirm_gone";
      mapped_to_id?: string;
      resolved_by?: string;
    };

    if (action === "map" && !mapped_to_id) {
      return void res.status(400).json({ error: "mapped_to_id required for action=map" });
    }

    if (mapped_to_id) {
      const check = await pool.query(
        "SELECT 1 FROM customer WHERE customer_id = $1", [mapped_to_id]);
      if (!check.rowCount)
        return void res.status(404).json({ error: `Customer ${mapped_to_id} not found` });
    }

    await pool.query(
      `UPDATE seed_unresolved_link
       SET resolution = $1, mapped_to_id = $2, resolved_by = $3, resolved_at = NOW()
       WHERE id = $4`,
      [action === "map" ? "mapped" : "confirmed_gone", mapped_to_id ?? null, resolved_by ?? "operator", linkId],
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/verify/inactive-managers ─────────────────────────────────
// Verification 6: active people whose manager is inactive.
// Returns 0 when all is well; becomes meaningful once deactivation is used.

router.get("/master/verify/inactive-managers", async (_req, res) => {
  try {
    const { rows } = await pool.query<{
      person_id: number;
      name: string;
      designation_name: string | null;
      manager_id: number;
      manager_name: string;
      manager_active: boolean;
    }>(
      `SELECT
         p.person_id,
         p.name,
         d.name  AS designation_name,
         mgr.person_id AS manager_id,
         mgr.name      AS manager_name,
         mgr.is_active AS manager_active
       FROM person p
       JOIN person mgr ON mgr.person_id = p.reports_to_person_id
       LEFT JOIN designation d ON d.designation_id = p.designation_id
       WHERE p.is_active = true AND mgr.is_active = false
       ORDER BY mgr.name, p.name`,
    );
    res.json({
      orphanedByInactiveManager: rows,
      count: rows.length,
      note:
        rows.length === 0
          ? "Clean — no active person reports to an inactive manager."
          : `${rows.length} active people report to an inactive manager.`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — CUSTOMER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/master/customers ─────────────────────────────────────────────────
// Paginated list of customers with their current (open) assignment.
// Query params: q, type, page, limit

router.get("/master/customers", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const type = String(req.query.type ?? "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: unknown[] = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.name ILIKE $${params.length} OR c.customer_id ILIKE $${params.length})`);
    }
    if (type) {
      params.push(type);
      where.push(`c.type = $${params.length}`);
    }

    const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM customer c ${wc}`, params),
      pool.query(
        `SELECT c.customer_id,
                c.name,
                c.type,
                c.status,
                ca.person_id,
                p.name       AS person_name,
                ca.state_head_person_id,
                sh.name      AS state_head_name,
                ca.confidence,
                ca.effective_from::text,
                EXISTS(
                  SELECT 1 FROM customer_link cl
                  WHERE cl.retailer_id = c.customer_id OR cl.distributor_id = c.customer_id
                ) AS has_link
         FROM customer c
         LEFT JOIN customer_assignment ca
           ON ca.customer_id = c.customer_id AND ca.effective_to IS NULL
         LEFT JOIN person p  ON p.person_id  = ca.person_id
         LEFT JOIN person sh ON sh.person_id = ca.state_head_person_id
         ${wc}
         ORDER BY c.name
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({ total: Number(countRes.rows[0].count), customers: dataRes.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/customers/by-head ────────────────────────────────────────
// FY2025-26 totals from sale_line grouped by head_canon.
//
// PHASE 3 VERIFICATION ANCHOR:
//   Call this before and after any customer reassignment.  The result must be
//   IDENTICAL because sale_line.head_canon is baked at register-ingestion time
//   and is never touched by customer_assignment edits.  If any row changes,
//   effective dating is broken.
//
// IMPORTANT: this route must be declared before /:id to avoid Express
// matching "by-head" as a customer_id parameter.

router.get("/master/customers/by-head", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT head_canon,
              COUNT(DISTINCT customer) AS customers,
              ROUND(SUM(amount) / 10000000.0, 4) AS crore
       FROM sale_line
       WHERE fy = '2025-26'
       GROUP BY head_canon
       ORDER BY crore DESC`,
    );
    res.json({ fy: "2025-26", source: "sale_line.head_canon", rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/customers/:id ────────────────────────────────────────────
// Full detail: customer row, current + historical assignments, and links.

router.get("/master/customers/:id", async (req, res) => {
  try {
    const customerId = String(req.params.id);

    const [custRes, histRes, linksRes] = await Promise.all([
      pool.query(
        `SELECT c.customer_id, c.name, c.type, c.status, c.territory_id,
                t.name AS territory_name
         FROM customer c
         LEFT JOIN territory t ON t.territory_id = c.territory_id
         WHERE c.customer_id = $1`,
        [customerId],
      ),
      pool.query(
        `SELECT ca.id,
                ca.person_id,      p.name  AS person_name,
                ca.state_head_person_id, sh.name AS state_head_name,
                ca.confidence,
                ca.set_by,
                ca.effective_from::text,
                ca.effective_to::text,
                ca.set_at::text
         FROM customer_assignment ca
         LEFT JOIN person p  ON p.person_id  = ca.person_id
         LEFT JOIN person sh ON sh.person_id = ca.state_head_person_id
         WHERE ca.customer_id = $1
         ORDER BY ca.effective_from DESC, ca.set_at DESC`,
        [customerId],
      ),
      pool.query(
        `SELECT cl.id,
                cl.link_order,
                cl.retailer_id,    r.name AS retailer_name,
                cl.distributor_id, d.name AS distributor_name,
                cl.effective_from::text,
                cl.effective_to::text
         FROM customer_link cl
         JOIN customer r ON r.customer_id = cl.retailer_id
         JOIN customer d ON d.customer_id = cl.distributor_id
         WHERE cl.retailer_id = $1 OR cl.distributor_id = $1
         ORDER BY cl.link_order, cl.effective_from`,
        [customerId],
      ),
    ]);

    if (!custRes.rows[0])
      return void res.status(404).json({ error: "Customer not found" });

    const currentAssignment =
      histRes.rows.find((r: { effective_to: string | null }) => !r.effective_to) ?? null;

    res.json({
      customer: custRes.rows[0],
      currentAssignment,
      assignmentHistory: histRes.rows,
      links: linksRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PATCH /api/master/customers/:id/assign ────────────────────────────────────
// Reassign a customer to a different TM and/or state head.
//
// Effective-dating contract:
//   The current open assignment row gets effective_to = CURRENT_DATE.
//   A new row is inserted with effective_from = CURRENT_DATE.
//
//   FY2025-26 analytics read sale_line.head_canon (baked at ingestion, never
//   modified here), so /by-head results are invariant to any reassignment.
//   The new assignment rows take effect for future period queries only.

router.patch("/master/customers/:id/assign", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const customerId = String(req.params.id);
    const { person_id, state_head_person_id, confidence, changed_by } =
      req.body as {
        person_id: number | null;
        state_head_person_id: number | null;
        confidence?: string;
        changed_by?: string;
      };

    const safeConf = ["confirmed", "assign_user_chain", "state_lookup", "guessed"].includes(
      confidence ?? "",
    )
      ? confidence!
      : "confirmed";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Read current open assignment for change_log
      const prevRes = await client.query(
        `SELECT person_id, state_head_person_id
         FROM customer_assignment
         WHERE customer_id = $1 AND effective_to IS NULL`,
        [customerId],
      );
      const prev = prevRes.rows[0] ?? null;

      // Close existing open assignment
      await client.query(
        `UPDATE customer_assignment
         SET effective_to = CURRENT_DATE
         WHERE customer_id = $1 AND effective_to IS NULL`,
        [customerId],
      );

      // Open new assignment
      await client.query(
        `INSERT INTO customer_assignment
           (customer_id, person_id, state_head_person_id, confidence, effective_from, set_by)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)`,
        [customerId, person_id ?? null, state_head_person_id ?? null, safeConf, changed_by ?? "app_edit"],
      );

      // Write change log entries
      if ((prev?.person_id ?? null) !== person_id) {
        await client.query(
          `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
           VALUES ('customer', $1, 'person_id', $2, $3, $4)`,
          [customerId, prev?.person_id?.toString() ?? null, person_id?.toString() ?? null, changed_by ?? "app_edit"],
        );
      }
      if ((prev?.state_head_person_id ?? null) !== state_head_person_id) {
        await client.query(
          `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
           VALUES ('customer', $1, 'state_head_person_id', $2, $3, $4)`,
          [customerId, prev?.state_head_person_id?.toString() ?? null, state_head_person_id?.toString() ?? null, changed_by ?? "app_edit"],
        );
      }

      await client.query("COMMIT");
      res.json({ success: true, customerId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
