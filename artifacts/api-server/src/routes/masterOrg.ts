// Master Organisation — Phase 2 people management.
//
// Rules enforced here:
// - No hard deletes on person. Deactivation sets is_active=false.
// - Every mutation writes to change_log.
// - Deactivation and reports_to changes require an impact acknowledgment:
//   the client must pass back the subTreeCount and totalCustomers it was
//   shown; the server re-verifies and rejects on mismatch (HTTP 409).
// - Cycle guard: a new reports_to is rejected if it is a descendant of the
//   person being edited (would create a loop in the hierarchy).
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
    const { rows } = await pool.query<{
      designation_id: number;
      name: string;
      rank: number;
    }>(`SELECT designation_id, name, rank FROM designation ORDER BY rank, name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people ────────────────────────────────────────────────────
// Query params: q (text search), active (true|false|all), designation_id, page, limit

router.get("/master/people", async (req, res) => {
  try {
    const q = (req.query.q as string | undefined)?.trim() ?? "";
    const active = req.query.active as string | undefined;
    const designationId = req.query.designation_id
      ? Number(req.query.designation_id)
      : null;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (q) {
      conditions.push(`p.name ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }
    if (active === "true") {
      conditions.push(`p.is_active = true`);
    } else if (active === "false") {
      conditions.push(`p.is_active = false`);
    }
    if (designationId !== null) {
      conditions.push(`p.designation_id = $${idx++}`);
      params.push(designationId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query<{
      person_id: number;
      name: string;
      employee_code: string | null;
      designation_id: number | null;
      designation_name: string | null;
      designation_rank: number | null;
      reports_to_person_id: number | null;
      reports_to_name: string | null;
      state_head_person_id: number | null;
      is_state_head: boolean;
      is_active: boolean;
      direct_reports: number;
      customers_as_sh: number;
      customers_as_tm: number;
      total: number;
    }>(
      `SELECT
         p.person_id,
         p.name,
         p.employee_code,
         p.designation_id,
         d.name            AS designation_name,
         d.rank            AS designation_rank,
         p.reports_to_person_id,
         mgr.name          AS reports_to_name,
         p.state_head_person_id,
         p.is_state_head,
         p.is_active,
         (SELECT COUNT(*) FROM person r WHERE r.reports_to_person_id = p.person_id)::int
                           AS direct_reports,
         (SELECT COUNT(*) FROM customer_assignment ca
          WHERE ca.state_head_person_id = p.person_id AND ca.effective_to IS NULL)::int
                           AS customers_as_sh,
         (SELECT COUNT(*) FROM customer_assignment ca
          WHERE ca.person_id = p.person_id AND ca.effective_to IS NULL)::int
                           AS customers_as_tm,
         COUNT(*) OVER()::int AS total
       FROM person p
       LEFT JOIN designation d  ON d.designation_id = p.designation_id
       LEFT JOIN person mgr     ON mgr.person_id = p.reports_to_person_id
       ${where}
       ORDER BY p.is_active DESC, d.rank NULLS LAST, p.name
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const total = rows[0]?.total ?? 0;
    res.json({
      people: rows.map(({ total: _t, ...r }) => r),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people/:id ────────────────────────────────────────────────
// Full detail: person + reporting chain up + direct reports list + territories.

router.get("/master/people/:id", async (req, res) => {
  const personId = Number(req.params.id);
  if (!Number.isFinite(personId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const { rows } = await pool.query<{
      person_id: number;
      name: string;
      employee_code: string | null;
      designation_id: number | null;
      designation_name: string | null;
      designation_rank: number | null;
      reports_to_person_id: number | null;
      reports_to_name: string | null;
      state_head_person_id: number | null;
      state_head_name: string | null;
      is_state_head: boolean;
      is_active: boolean;
      direct_reports: number;
      customers_as_sh: number;
      customers_as_tm: number;
      created_at: string;
    }>(
      `SELECT
         p.person_id,
         p.name,
         p.employee_code,
         p.designation_id,
         d.name            AS designation_name,
         d.rank            AS designation_rank,
         p.reports_to_person_id,
         mgr.name          AS reports_to_name,
         p.state_head_person_id,
         sh.name           AS state_head_name,
         p.is_state_head,
         p.is_active,
         (SELECT COUNT(*) FROM person r WHERE r.reports_to_person_id = p.person_id)::int
                           AS direct_reports,
         (SELECT COUNT(*) FROM customer_assignment ca
          WHERE ca.state_head_person_id = p.person_id AND ca.effective_to IS NULL)::int
                           AS customers_as_sh,
         (SELECT COUNT(*) FROM customer_assignment ca
          WHERE ca.person_id = p.person_id AND ca.effective_to IS NULL)::int
                           AS customers_as_tm,
         p.created_at
       FROM person p
       LEFT JOIN designation d  ON d.designation_id = p.designation_id
       LEFT JOIN person mgr     ON mgr.person_id = p.reports_to_person_id
       LEFT JOIN person sh      ON sh.person_id = p.state_head_person_id
       WHERE p.person_id = $1`,
      [personId],
    );
    if (!rows.length) {
      res.status(404).json({ error: "Person not found" });
      return;
    }
    const person = rows[0]!;

    // Direct reports list
    const { rows: directReports } = await pool.query<{
      person_id: number;
      name: string;
      designation_name: string | null;
      is_active: boolean;
    }>(
      `SELECT p.person_id, p.name, d.name AS designation_name, p.is_active
       FROM person p
       LEFT JOIN designation d ON d.designation_id = p.designation_id
       WHERE p.reports_to_person_id = $1
       ORDER BY p.name`,
      [personId],
    );

    // Reporting chain upward (up to 8 levels)
    const { rows: chainRows } = await pool.query<{
      person_id: number;
      name: string;
      designation_name: string | null;
      level: number;
    }>(
      `WITH RECURSIVE chain AS (
         SELECT person_id, name, designation_id, reports_to_person_id, 1 AS level
         FROM person WHERE person_id = (SELECT reports_to_person_id FROM person WHERE person_id = $1)
         UNION ALL
         SELECT p.person_id, p.name, p.designation_id, p.reports_to_person_id, c.level + 1
         FROM person p JOIN chain c ON p.person_id = c.reports_to_person_id
         WHERE c.level < 8
       )
       SELECT c.person_id, c.name, d.name AS designation_name, c.level
       FROM chain c
       LEFT JOIN designation d ON d.designation_id = c.designation_id
       ORDER BY c.level`,
      [personId],
    );

    // Territories
    const { rows: territories } = await pool.query<{
      territory_id: number;
      name: string;
      parent_name: string | null;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT t.territory_id, t.name, par.name AS parent_name,
              pt.effective_from::text, pt.effective_to::text
       FROM person_territory pt
       JOIN territory t ON t.territory_id = pt.territory_id
       LEFT JOIN territory par ON par.territory_id = t.parent_territory_id
       WHERE pt.person_id = $1
       ORDER BY pt.effective_from`,
      [personId],
    );

    // Recent change log
    const { rows: changeLog } = await pool.query<{
      id: number;
      field: string;
      old_value: string | null;
      new_value: string | null;
      changed_by: string | null;
      changed_at: string;
    }>(
      `SELECT id, field, old_value, new_value, changed_by, changed_at::text
       FROM change_log
       WHERE entity_type = 'person' AND entity_id = $1
       ORDER BY changed_at DESC LIMIT 20`,
      [String(personId)],
    );

    res.json({
      person,
      directReports,
      reportingChain: chainRows,
      territories,
      changeLog,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people/:id/impact ─────────────────────────────────────────
// Returns the full impact preview for deactivation OR a reports_to change.
// Always call this before any mutation that can affect hierarchy or customers.

router.get("/master/people/:id/impact", async (req, res) => {
  const personId = Number(req.params.id);
  if (!Number.isFinite(personId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [personResult, directReportsResult, subTreeResult, asShResult, asTmResult] =
      await Promise.all([
        pool.query<{ person_id: number; name: string; is_active: boolean }>(
          `SELECT person_id, name, is_active FROM person WHERE person_id = $1`,
          [personId],
        ),
        // Direct reports (names, not just count)
        pool.query<{ person_id: number; name: string; designation_name: string | null }>(
          `SELECT p.person_id, p.name, d.name AS designation_name
           FROM person p
           LEFT JOIN designation d ON d.designation_id = p.designation_id
           WHERE p.reports_to_person_id = $1
           ORDER BY p.name`,
          [personId],
        ),
        // Full subtree count (all descendants, not just direct)
        pool.query<{ sub_tree_count: number }>(
          `WITH RECURSIVE subtree AS (
             SELECT person_id FROM person WHERE reports_to_person_id = $1
             UNION ALL
             SELECT p.person_id FROM person p
             JOIN subtree s ON p.reports_to_person_id = s.person_id
           )
           SELECT COUNT(*)::int AS sub_tree_count FROM subtree`,
          [personId],
        ),
        // Customers where this person is state head (active assignments)
        pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM customer_assignment
           WHERE state_head_person_id = $1 AND effective_to IS NULL`,
          [personId],
        ),
        // Customers where this person is the assigned TM (active assignments)
        pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM customer_assignment
           WHERE person_id = $1 AND effective_to IS NULL`,
          [personId],
        ),
      ]);

    if (!personResult.rows.length) {
      res.status(404).json({ error: "Person not found" });
      return;
    }

    const directReports = directReportsResult.rows;
    const subTreeCount = subTreeResult.rows[0]!.sub_tree_count;
    const customersAsStateHead = asShResult.rows[0]!.count;
    const customersAsTm = asTmResult.rows[0]!.count;
    const totalCustomersAffected = customersAsStateHead + customersAsTm;

    res.json({
      person: personResult.rows[0]!,
      directReports,          // array — shown by name in the modal
      subTreeCount,            // includes direct reports + all descendants
      customersAsStateHead,    // assignments where this person = state_head_person_id
      customersAsTm,           // assignments where this person = person_id
      totalCustomersAffected,  // sum of the two above
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PATCH /api/master/people/:id ──────────────────────────────────────────────
// Edits: name, employee_code, designation_id, reports_to_person_id.
// Changing reports_to REQUIRES acknowledgedSubTree + acknowledgedCustomers in body.
// is_active is NOT edited here — use /deactivate or /reactivate.

router.patch("/master/people/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const personId = Number(req.params.id);
  if (!Number.isFinite(personId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

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
    employee_code?: string | null;
    designation_id?: number | null;
    reports_to_person_id?: number | null;
    acknowledgedSubTree?: number;
    acknowledgedCustomers?: number;
    changed_by?: string;
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch current state
    const { rows: current } = await client.query<{
      person_id: number;
      name: string;
      employee_code: string | null;
      designation_id: number | null;
      reports_to_person_id: number | null;
      is_active: boolean;
    }>(
      `SELECT person_id, name, employee_code, designation_id, reports_to_person_id, is_active
       FROM person WHERE person_id = $1 FOR UPDATE`,
      [personId],
    );
    if (!current.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Person not found" });
      return;
    }
    const cur = current[0]!;

    // If reports_to is changing, require impact acknowledgment + cycle check
    const newReportsTo = reports_to_person_id !== undefined ? reports_to_person_id : cur.reports_to_person_id;
    const reportsToChanging =
      reports_to_person_id !== undefined &&
      reports_to_person_id !== cur.reports_to_person_id;

    if (reportsToChanging) {
      if (acknowledgedSubTree === undefined || acknowledgedCustomers === undefined) {
        await client.query("ROLLBACK");
        res.status(422).json({
          error:
            "Changing reports_to requires acknowledgedSubTree and acknowledgedCustomers " +
            "from the /impact preview to be included in the request body.",
        });
        return;
      }

      // Re-verify the impact numbers match what the client acknowledged
      const [subTreeRes, custRes] = await Promise.all([
        client.query<{ n: number }>(
          `WITH RECURSIVE sub AS (
             SELECT person_id FROM person WHERE reports_to_person_id = $1
             UNION ALL
             SELECT p.person_id FROM person p JOIN sub s ON p.reports_to_person_id = s.person_id
           )
           SELECT COUNT(*)::int AS n FROM sub`,
          [personId],
        ),
        client.query<{ n: number }>(
          `SELECT (
             (SELECT COUNT(*) FROM customer_assignment WHERE state_head_person_id = $1 AND effective_to IS NULL) +
             (SELECT COUNT(*) FROM customer_assignment WHERE person_id = $1 AND effective_to IS NULL)
           )::int AS n`,
          [personId],
        ),
      ]);
      const actualSubTree = subTreeRes.rows[0]!.n;
      const actualCustomers = custRes.rows[0]!.n;
      if (actualSubTree !== acknowledgedSubTree || actualCustomers !== acknowledgedCustomers) {
        await client.query("ROLLBACK");
        res.status(409).json({
          error:
            "Impact has changed since preview — please re-fetch /impact and confirm again.",
          current: { subTreeCount: actualSubTree, totalCustomersAffected: actualCustomers },
        });
        return;
      }

      // Cycle guard: ensure newReportsTo is not a descendant of personId
      if (newReportsTo !== null) {
        const { rows: cycleCheck } = await client.query<{ found: boolean }>(
          `WITH RECURSIVE sub AS (
             SELECT person_id FROM person WHERE reports_to_person_id = $1
             UNION ALL
             SELECT p.person_id FROM person p JOIN sub s ON p.reports_to_person_id = s.person_id
           )
           SELECT EXISTS(SELECT 1 FROM sub WHERE person_id = $2) AS found`,
          [personId, newReportsTo],
        );
        if (cycleCheck[0]!.found) {
          await client.query("ROLLBACK");
          res.status(422).json({
            error:
              "Cannot set reports_to: that person is already in this person's reporting subtree. " +
              "This would create a cycle.",
          });
          return;
        }
      }
    }

    // Build update fields
    const updates: string[] = [];
    const updateParams: unknown[] = [];
    const changeEntries: Array<{ field: string; old_value: string | null; new_value: string | null }> = [];
    let pi = 1;

    const addField = (
      col: string,
      oldVal: unknown,
      newVal: unknown,
    ) => {
      if (newVal !== undefined && String(newVal ?? "") !== String(oldVal ?? "")) {
        updates.push(`${col} = $${pi++}`);
        updateParams.push(newVal ?? null);
        changeEntries.push({
          field: col,
          old_value: oldVal == null ? null : String(oldVal),
          new_value: newVal == null ? null : String(newVal),
        });
      }
    };

    addField("name", cur.name, name?.trim() || undefined);
    addField("employee_code", cur.employee_code, employee_code !== undefined ? (employee_code?.trim() || null) : undefined);
    addField("designation_id", cur.designation_id, designation_id !== undefined ? designation_id : undefined);
    addField("reports_to_person_id", cur.reports_to_person_id, reports_to_person_id !== undefined ? reports_to_person_id : undefined);

    if (!updates.length) {
      await client.query("ROLLBACK");
      res.status(200).json({ message: "No changes" });
      return;
    }

    updates.push(`updated_at = NOW()`);

    await client.query(
      `UPDATE person SET ${updates.join(", ")} WHERE person_id = $${pi}`,
      [...updateParams, personId],
    );

    // Write change_log entries
    for (const entry of changeEntries) {
      await client.query(
        `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
         VALUES ('person', $1, $2, $3, $4, $5)`,
        [String(personId), entry.field, entry.old_value, entry.new_value, changed_by ?? null],
      );
    }

    await client.query("COMMIT");

    // Return updated person
    const { rows: updated } = await pool.query(
      `SELECT p.*, d.name AS designation_name FROM person p
       LEFT JOIN designation d ON d.designation_id = p.designation_id
       WHERE p.person_id = $1`,
      [personId],
    );
    res.json({ person: updated[0]! });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

// ── POST /api/master/people/:id/deactivate ────────────────────────────────────
// Body: { acknowledgedSubTree, acknowledgedCustomers, changed_by }
// Server re-verifies impact numbers match; rejects with 409 if they changed.

router.post("/master/people/:id/deactivate", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const personId = Number(req.params.id);
  if (!Number.isFinite(personId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const {
    acknowledgedSubTree,
    acknowledgedCustomers,
    changed_by,
  } = req.body as {
    acknowledgedSubTree: number;
    acknowledgedCustomers: number;
    changed_by?: string;
  };

  if (acknowledgedSubTree === undefined || acknowledgedCustomers === undefined) {
    res.status(422).json({
      error:
        "Deactivation requires acknowledgedSubTree and acknowledgedCustomers " +
        "from the /impact preview. Fetch /impact, show the user the counts, " +
        "and include their acknowledged values here.",
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: current } = await client.query<{
      is_active: boolean;
      name: string;
    }>(
      `SELECT is_active, name FROM person WHERE person_id = $1 FOR UPDATE`,
      [personId],
    );
    if (!current.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Person not found" });
      return;
    }
    if (!current[0]!.is_active) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Person is already inactive" });
      return;
    }

    // Re-verify impact numbers
    const [subTreeRes, custRes] = await Promise.all([
      client.query<{ n: number }>(
        `WITH RECURSIVE sub AS (
           SELECT person_id FROM person WHERE reports_to_person_id = $1
           UNION ALL
           SELECT p.person_id FROM person p JOIN sub s ON p.reports_to_person_id = s.person_id
         )
         SELECT COUNT(*)::int AS n FROM sub`,
        [personId],
      ),
      client.query<{ n: number }>(
        `SELECT (
           (SELECT COUNT(*) FROM customer_assignment WHERE state_head_person_id = $1 AND effective_to IS NULL) +
           (SELECT COUNT(*) FROM customer_assignment WHERE person_id = $1 AND effective_to IS NULL)
         )::int AS n`,
        [personId],
      ),
    ]);
    const actualSubTree = subTreeRes.rows[0]!.n;
    const actualCustomers = custRes.rows[0]!.n;

    if (actualSubTree !== Number(acknowledgedSubTree) || actualCustomers !== Number(acknowledgedCustomers)) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error:
          "Impact has changed since preview — please re-fetch /impact and confirm again.",
        current: { subTreeCount: actualSubTree, totalCustomersAffected: actualCustomers },
      });
      return;
    }

    // Execute deactivation
    await client.query(
      `UPDATE person SET is_active = false, updated_at = NOW() WHERE person_id = $1`,
      [personId],
    );

    await client.query(
      `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
       VALUES ('person', $1, 'is_active', 'true', 'false', $2)`,
      [String(personId), changed_by ?? null],
    );

    // Log acknowledged impact for audit trail
    await client.query(
      `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
       VALUES ('person', $1, 'deactivation_impact_acknowledged', NULL,
               $2, $3)`,
      [
        String(personId),
        JSON.stringify({ subTreeCount: actualSubTree, totalCustomersAffected: actualCustomers }),
        changed_by ?? null,
      ],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      personId,
      deactivatedAt: new Date().toISOString(),
      impact: { subTreeCount: actualSubTree, totalCustomersAffected: actualCustomers },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

// ── POST /api/master/people/:id/reactivate ────────────────────────────────────
// No impact check needed — reactivation never orphans anyone.

router.post("/master/people/:id/reactivate", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const personId = Number(req.params.id);
  if (!Number.isFinite(personId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ is_active: boolean }>(
      `SELECT is_active FROM person WHERE person_id = $1 FOR UPDATE`,
      [personId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Person not found" });
      return;
    }
    if (rows[0]!.is_active) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Person is already active" });
      return;
    }

    await client.query(
      `UPDATE person SET is_active = true, updated_at = NOW() WHERE person_id = $1`,
      [personId],
    );
    await client.query(
      `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
       VALUES ('person', $1, 'is_active', 'false', 'true', $2)`,
      [String(personId), (req.body as any).changed_by ?? null],
    );

    await client.query("COMMIT");
    res.json({ success: true, personId, reactivatedAt: new Date().toISOString() });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

// ── GET /api/master/unresolved-links ─────────────────────────────────────────
// The 14 distributor names from the seed that matched no customer row.
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

// ── Verification 6: inactive-manager check ────────────────────────────────────
// GET /api/master/verify/inactive-managers
// Returns people whose reports_to manager is inactive.
// Returned 0 at Phase 1 because all 179 people were active.
// Becomes meaningful once deactivation is used.

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

export default router;
