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
import { unverifiedCoverageAliasReviewSql } from "../lib/coverageAliases.js";
import { pool } from "@workspace/db";
import type * as ExcelJSTypes from "exceljs";
import { isAdminToken } from "../lib/adminAuth.js";

const router = Router();
const coverageAliasReviewSql = unverifiedCoverageAliasReviewSql("c", "coverage_person.name");

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

// Lock + validate assignment target people INSIDE the caller's transaction.
// FOR SHARE on the person rows serializes against a concurrent departure
// (which takes FOR UPDATE on the same row), so a target cannot depart between
// validation and the assignment insert. Returns the first invalid id, or null.
async function lockAssignTargets(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  ids: number[],
): Promise<number | null> {
  if (ids.length === 0) return null;
  const okRes = await client.query(
    `SELECT person_id FROM person
     WHERE person_id = ANY($1::int[]) AND is_active = true
       AND is_holding = false AND left_date IS NULL
     FOR SHARE`,
    [ids],
  );
  const okIds = new Set(okRes.rows.map((r: any) => r.person_id));
  return ids.find((id) => !okIds.has(id)) ?? null;
}

// Non-throwing check for READ routes that redact sensitive HR fields
// (departure reason/note) when the caller does not hold the admin secret.
function hasAdminToken(req: any): boolean {
  const token = (req.headers["x-admin-secret"] as string | undefined) ?? "";
  return isAdminToken(token);
}

// ── GET /api/master/designations ──────────────────────────────────────────────
// Returns all designation records ordered by rank (lowest rank = most senior).

router.get("/master/designations", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT designation_id, name, rank FROM designation ORDER BY rank ASC NULLS LAST`,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/people ────────────────────────────────────────────────────
// Paginated list of people with search, active-filter, and designation filter.
// Query params: q, active (true/false/all), designation_id, page, limit

router.get("/master/people", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const activeFilter = String(req.query.active ?? "all");
    const desigId = req.query.designation_id ? Number(req.query.designation_id) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: unknown[] = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`p.name ILIKE $${params.length}`);
    }
    // Holding persons are system placeholders for departed heads — they must
    // never appear in (or inflate) active/assignable person lists.
    // System coverage sentinels are audit records, never people an operator can
    // select or manage.
    where.push("COALESCE(p.is_system_coverage, false) = false");
    if (activeFilter === "true") where.push("p.is_active = true AND p.is_holding = false");
    else if (activeFilter === "false") where.push("p.is_active = false");
    if (desigId !== null) {
      params.push(desigId);
      where.push(`p.designation_id = $${params.length}`);
    }

    const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM person p ${wc}`, params),
      pool.query(
        `SELECT p.person_id, p.name, p.employee_code, p.is_active, p.is_state_head,
                p.left_date::text, p.departure_reason, p.is_holding, p.holding_for_person_id,
                d.designation_id, d.name AS designation_name, d.rank AS designation_rank,
                mgr.person_id AS reports_to_person_id, mgr.name AS reports_to_name,
                (SELECT COUNT(*) FROM person sub WHERE sub.reports_to_person_id = p.person_id
                ) AS direct_reports,
                (SELECT COUNT(*) FROM customer_assignment ca
                 WHERE ca.state_head_person_id = p.person_id
                   AND ca.effective_to IS NULL AND ca.voided_at IS NULL
                ) AS customers_as_sh,
                (SELECT COUNT(*) FROM customer_assignment ca
                 WHERE ca.person_id = p.person_id
                   AND ca.effective_to IS NULL AND ca.voided_at IS NULL
                ) AS customers_as_tm
         FROM person p
         LEFT JOIN designation d   ON d.designation_id = p.designation_id
         LEFT JOIN person      mgr ON mgr.person_id    = p.reports_to_person_id
         ${wc}
         ORDER BY p.is_active DESC, d.rank ASC NULLS LAST, p.name
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    const total = Number(countRes.rows[0].count);
    // Departure reason is HR-sensitive — only admin callers get it.
    const admin = hasAdminToken(req);
    const people = admin
      ? dataRes.rows
      : dataRes.rows.map((r: any) => ({ ...r, departure_reason: null }));
    res.json({ people, total, page, pages: Math.ceil(total / limit) });
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
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
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
           ON ca.customer_id = c.customer_id
          AND ca.effective_to IS NULL AND ca.voided_at IS NULL
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
                  p.left_date::text, p.departure_reason, p.departure_note,
                  p.is_holding, p.holding_for_person_id,
                  d.designation_id, d.name AS designation_name,
                  mgr.person_id AS reports_to_person_id, mgr.name AS reports_to_name,
                  sh.person_id  AS state_head_person_id, sh.name AS state_head_name,
                  (SELECT COUNT(*) FROM customer_assignment ca
                   WHERE ca.state_head_person_id = p.person_id
                     AND ca.effective_to IS NULL AND ca.voided_at IS NULL
                  ) AS customers_as_state_head,
                  (SELECT COUNT(*) FROM customer_assignment ca
                   WHERE ca.person_id = p.person_id
                     AND ca.effective_to IS NULL AND ca.voided_at IS NULL
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
        // Canonical state coverage.  The retired person_territory table is
        // intentionally not a fallback: a missing canonical row must be
        // visible and fixed, never silently supplied from legacy geography.
        pool.query(
           `SELECT c.coverage_id, c.state_canon, sh.state_parent,
                  c.effective_from::text, c.effective_to::text,
                  c.fiscal_year, c.evidence_customer_count,
                  c.evidence_net_amount, c.evidence_source,
                  head.person_id AS state_head_person_id,
                  head.name AS state_head_name,
                  COALESCE(head.is_system_coverage, false) AS is_unassigned,
                  ${coverageAliasReviewSql.status} AS alias_review_status,
                  ${coverageAliasReviewSql.registerHeadLabel} AS register_head_label,
                  ${coverageAliasReviewSql.reviewNote} AS alias_review_note
           FROM person_state_coverage c
           JOIN state_hierarchy sh ON sh.state_canon = c.state_canon
            JOIN person coverage_person ON coverage_person.person_id = c.person_id
           JOIN person head ON head.person_id = c.state_head_person_id
            WHERE c.person_id = $1
              AND c.voided_at IS NULL
           ORDER BY c.effective_to NULLS FIRST, sh.display_order, c.state_canon, head.name`,
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
    // Departure reason/note are HR-sensitive — only admin callers get them.
    // The change log records those same values (field = 'departure_*'), so
    // those audit rows must be withheld from non-admin callers too.
    const admin = hasAdminToken(req);
    if (!admin) {
      p.departure_reason = null;
      p.departure_note = null;
    }
    const changeLog = admin
      ? logRes.rows
      : logRes.rows.filter(
          (c: any) => !String(c.field ?? "").startsWith("departure"),
        );
    // Customer scope counts are inlined in the person query (customers_as_state_head/as_tm).
    const csh = Number(p.customers_as_state_head ?? 0);
    const ctm = Number(p.customers_as_tm ?? 0);

    res.json({
      person: p,
      directReports: directRes.rows,
      reportingChain: chainRes.rows,
      coverage: terrRes.rows,
      // Keep this response alias briefly for older browser bundles; it now
      // contains canonical coverage records rather than territory rows.
      territories: terrRes.rows,
      changeLog,
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

    // Customers assigned as state head or TM (open assignments only).
    // COUNT(DISTINCT customer_id) is used for the total so that a customer where
    // this person is BOTH state_head and TM is not double-counted.
    const custRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state_head_person_id = $1) AS as_state_head,
         COUNT(*) FILTER (WHERE person_id = $1)            AS as_tm,
         COUNT(DISTINCT customer_id)                       AS total_distinct
       FROM customer_assignment
       WHERE effective_to IS NULL
         AND voided_at IS NULL
         AND (state_head_person_id = $1 OR person_id = $1)`,
      [personId],
    );

    const csh = Number(custRes.rows[0]?.as_state_head ?? 0);
    const ctm = Number(custRes.rows[0]?.as_tm ?? 0);
    const totalDistinct = Number(custRes.rows[0]?.total_distinct ?? 0);

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
      totalCustomersAffected: totalDistinct,
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
    // Read current state of this person
    const prevRes = await pool.query(
      `SELECT name, employee_code, designation_id, reports_to_person_id, is_active
       FROM person WHERE person_id = $1`,
      [personId],
    );
    if (!prevRes.rows[0])
      return void res.status(404).json({ error: "Person not found" });
    const prev = prevRes.rows[0];

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

      // Re-verify impact counts match what the client acknowledged
      const impactRes = await pool.query(
        `WITH RECURSIVE tree AS (
           SELECT person_id FROM person WHERE reports_to_person_id = $1
           UNION ALL
           SELECT p.person_id FROM person p JOIN tree t ON t.person_id = p.reports_to_person_id
         )
         SELECT COUNT(*) AS sub_tree FROM tree`,
        [personId],
      );
      const custImpactRes = await pool.query(
        `SELECT COUNT(DISTINCT customer_id) AS cust FROM customer_assignment
         WHERE effective_to IS NULL
          AND voided_at IS NULL
           AND (state_head_person_id = $1 OR person_id = $1)`,
        [personId],
      );
      const liveSubTree = Number(impactRes.rows[0].sub_tree);
      const liveCust = Number(custImpactRes.rows[0].cust);

      if (liveSubTree !== acknowledgedSubTree || liveCust !== acknowledgedCustomers) {
        return void res.status(409).json({
          error:
            "Impact has changed since preview — please re-fetch /impact and confirm again.",
          current: { subTreeCount: liveSubTree, totalCustomersAffected: liveCust },
        });
      }
    } // end if (reportsToChanging)

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
      `SELECT COUNT(DISTINCT customer_id) AS cust FROM customer_assignment
       WHERE effective_to IS NULL
         AND voided_at IS NULL
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

    // Departed and holding persons cannot be reactivated via this route:
    // a departed person's customers are already in holding (a plain is_active
    // flip would leave a person both "active" and "departed", excluded from
    // assignable lists and alerts while their customers sit unowned), and a
    // holding person's lifecycle is managed by the departure/resolve flow.
    const checkRes = await pool.query(
      `SELECT left_date, is_holding FROM person WHERE person_id = $1`,
      [personId],
    );
    if (!checkRes.rows[0])
      return void res.status(404).json({ error: "Person not found" });
    if (checkRes.rows[0].is_holding)
      return void res.status(400).json({
        error: "Holding persons cannot be reactivated — resolve the holding instead.",
      });
    if (checkRes.rows[0].left_date)
      return void res.status(400).json({
        error:
          "This person has a recorded departure and cannot be reactivated directly. Use POST /api/master/people/:id/rehire to reverse a genuine re-hire.",
      });

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

// ── POST /api/master/people/:id/rehire ───────────────────────────────────────
// Reverse a departure for a genuine re-hire. Clears left_date,
// departure_reason, departure_note and sets is_active=true.
//
// Pre-conditions (all checked inside a row-locking transaction):
//   1. Person must have a recorded departure (left_date IS NOT NULL).
//   2. If a holding person exists for this departed head, it must have
//      zero open customer_assignments — the operator must first resolve or
//      redistribute all held customers before the re-hire can proceed.
//
// On success the holding person (if any) is deactivated and a change_log
// entry records the rehire event.

router.post("/master/people/:id/rehire", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const personId = Number(req.params.id);
    const { changed_by } = req.body as { changed_by?: string };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the row so concurrent rehire / departure submissions serialise.
      const lockRes = await client.query(
        `SELECT left_date, is_holding, is_active FROM person WHERE person_id = $1 FOR UPDATE`,
        [personId],
      );
      if (!lockRes.rows[0]) {
        await client.query("ROLLBACK");
        return void res.status(404).json({ error: "Person not found" });
      }
      const row = lockRes.rows[0];
      if (row.is_holding) {
        await client.query("ROLLBACK");
        return void res.status(400).json({
          error: "Holding persons cannot be re-hired — resolve the holding instead.",
        });
      }
      if (!row.left_date) {
        await client.query("ROLLBACK");
        return void res.status(400).json({
          error: "This person has no recorded departure — use /reactivate instead.",
        });
      }

      // Check whether there is a holding person with open assignments.
      const holdingRes = await client.query(
        `SELECT h.person_id,
                COUNT(ca.id) AS open_count
         FROM person h
         LEFT JOIN customer_assignment ca
           ON ca.effective_to IS NULL AND ca.voided_at IS NULL
           AND (ca.state_head_person_id = h.person_id OR ca.person_id = h.person_id)
         WHERE h.is_holding = true AND h.holding_for_person_id = $1
         GROUP BY h.person_id`,
        [personId],
      );
      const holdingRow = holdingRes.rows[0] ?? null;
      if (holdingRow && Number(holdingRow.open_count) > 0) {
        await client.query("ROLLBACK");
        return void res.status(400).json({
          error: `Cannot re-hire: the holding person (id ${holdingRow.person_id}) still has ${holdingRow.open_count} open customer assignment(s). Resolve all held customers first.`,
          holdingPersonId: holdingRow.person_id,
          openAssignments: Number(holdingRow.open_count),
        });
      }

      // Clear departure fields and reactivate.
      await client.query(
        `UPDATE person
         SET left_date = NULL, departure_reason = NULL, departure_note = NULL,
             is_active = true, updated_at = NOW()
         WHERE person_id = $1`,
        [personId],
      );

      // Deactivate the holding person (if any) — it is no longer needed.
      if (holdingRow) {
        await client.query(
          `UPDATE person SET is_active = false, updated_at = NOW()
           WHERE person_id = $1`,
          [holdingRow.person_id],
        );
      }

      // Change log entry.
      await client.query(
        `INSERT INTO change_log
           (entity_type, entity_id, field, old_value, new_value, changed_by)
         VALUES ('person', $1, 'rehire', 'departed', 'active', $2)`,
        [String(personId), changed_by ?? "operator"],
      );

      await client.query("COMMIT");
      res.json({
        success: true,
        holdingDeactivated: holdingRow ? holdingRow.person_id : null,
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

// ── POST /api/master/people/:id/departure ─────────────────────────────────────
// Record a state head's (or TM's) departure. Requires the impact-preview
// acknowledgment gate (same as deactivate). In one transaction:
//   1. person gets left_date/departure_reason/departure_note, is_active=false
//   2. one system "holding" person is created (is_holding=true) for this head
//   3. every OPEN customer_assignment where the departed person appears is
//      closed on left_date and reopened with the holding person substituted
// Historical rows are never touched — sale_line/head_canon stays intact.

router.post("/master/people/:id/departure", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const personId = Number(req.params.id);
    const {
      left_date,
      departure_reason,
      departure_note,
      acknowledgedSubTree,
      acknowledgedCustomers,
      changed_by,
      voidPostDepartureImports,
    } = req.body as {
      left_date?: string;
      departure_reason?: string;
      departure_note?: string;
      acknowledgedSubTree?: number;
      acknowledgedCustomers?: number;
      changed_by?: string;
      voidPostDepartureImports?: boolean;
    };

    if (!left_date || !/^\d{4}-\d{2}-\d{2}$/.test(left_date)) {
      return void res.status(400).json({ error: "left_date (YYYY-MM-DD) is required" });
    }
    if (!departure_reason || !departure_reason.trim()) {
      return void res.status(400).json({ error: "departure_reason is required" });
    }
    if (acknowledgedSubTree === undefined || acknowledgedCustomers === undefined) {
      return void res.status(422).json({
        error:
          "Must pass acknowledgedSubTree and acknowledgedCustomers (from /impact) to confirm awareness of impact.",
      });
    }

    const personRes = await pool.query(
      `SELECT person_id, name, is_active, is_holding, is_state_head, designation_id, left_date
       FROM person WHERE person_id = $1`,
      [personId],
    );
    if (!personRes.rows[0])
      return void res.status(404).json({ error: "Person not found" });
    const person = personRes.rows[0];
    if (person.is_holding)
      return void res.status(400).json({ error: "Cannot record departure of a holding person" });
    if (person.left_date)
      return void res.status(400).json({ error: "Departure already recorded for this person" });

    // Re-verify impact server-side (same gate as deactivate)
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
      `SELECT COUNT(DISTINCT customer_id) AS cust FROM customer_assignment
       WHERE effective_to IS NULL
         AND voided_at IS NULL
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

      // Re-check under a row lock: two concurrent departure submissions can
      // both pass the pre-transaction check; the second must fail here rather
      // than overwrite the recorded departure and re-date the holding moves.
      const lockRes = await client.query(
        `SELECT left_date, is_holding FROM person WHERE person_id = $1 FOR UPDATE`,
        [personId],
      );
      if (!lockRes.rows[0] || lockRes.rows[0].is_holding || lockRes.rows[0].left_date) {
        await client.query("ROLLBACK");
        return void res
          .status(400)
          .json({ error: "Departure already recorded for this person" });
      }

      // 1. Mark the departure on the person
      await client.query(
        `UPDATE person
         SET left_date = $2, departure_reason = $3, departure_note = $4,
             is_active = false, updated_at = NOW()
         WHERE person_id = $1`,
        [personId, left_date, departure_reason.trim(), departure_note?.trim() || null],
      );

      // 2. Split live assignments by their relationship to the departure date.
      //    A seed-imported assignment after someone left cannot be back-dated
      //    into a holding person. It is an invalid import and must become an
      //    auditable unassigned-queue row instead. Ordinary app-created
      //    assignments retain the standard departure behavior.
      const openRes = await client.query(
        `SELECT id, customer_id, person_id, state_head_person_id, confidence,
                effective_from::text AS effective_from, set_by
         FROM customer_assignment
         WHERE effective_to IS NULL
           AND voided_at IS NULL
           AND (state_head_person_id = $1 OR person_id = $1)
         FOR UPDATE`,
        [personId],
      );
      const postDepartureAssignments = openRes.rows.filter(
        (assignment) => assignment.effective_from > left_date,
      );
      const voidablePostDepartureAssignments = postDepartureAssignments.filter(
        (assignment) => assignment.set_by === "seed_import",
      );
      const blockedPostDepartureAssignments = postDepartureAssignments.filter(
        (assignment) => assignment.set_by !== "seed_import",
      );
      const assignmentsToMove = openRes.rows.filter(
        (assignment) => assignment.effective_from <= left_date,
      );
      const coverageRes = await client.query(
        `SELECT coverage_id, state_canon, source, effective_from::text AS effective_from
         FROM person_state_coverage
         WHERE person_id = $1
           AND voided_at IS NULL
           AND effective_from > $2::date
         FOR UPDATE`,
        [personId, left_date],
      );
      const voidablePostDepartureCoverage = coverageRes.rows.filter(
        (coverage) => coverage.source === "seed_import" || coverage.source === "migration",
      );
      const blockedPostDepartureCoverage = coverageRes.rows.filter(
        (coverage) => coverage.source !== "seed_import" && coverage.source !== "migration",
      );
      if (blockedPostDepartureAssignments.length > 0 || blockedPostDepartureCoverage.length > 0) {
        await client.query("ROLLBACK");
        return void res.status(409).json({
          error:
            "A post-departure assignment or coverage row is not an imported source and cannot be back-dated or automatically voided.",
          postDepartureAssignments: blockedPostDepartureAssignments.map((assignment) => assignment.customer_id),
          postDepartureCoverage: blockedPostDepartureCoverage,
        });
      }
      if ((voidablePostDepartureAssignments.length > 0 || voidablePostDepartureCoverage.length > 0)
          && !voidPostDepartureImports) {
        await client.query("ROLLBACK");
        return void res.status(409).json({
          error:
            "Open coverage or customer assignments begin after this departure. Set voidPostDepartureImports=true to void the invalid imports into the unassigned queue.",
          postDepartureAssignments: voidablePostDepartureAssignments.map((assignment) => assignment.customer_id),
          postDepartureCoverage: voidablePostDepartureCoverage,
        });
      }

      // 3. Create a holding person only if there are genuine assignments to
      //    hand over. A post-departure import must not create a false holding
      //    territory for someone who had already left.
      let holdingId: number | null = null;
      if (assignmentsToMove.length > 0) {
        const existingHolding = await client.query(
          `SELECT person_id FROM person WHERE is_holding = true AND holding_for_person_id = $1 FOR UPDATE`,
          [personId],
        );
        if (existingHolding.rows[0]) {
          holdingId = existingHolding.rows[0].person_id;
          await client.query(
            `UPDATE person SET is_active = true, updated_at = NOW() WHERE person_id = $1`,
            [holdingId],
          );
        } else {
          const holdRes = await client.query(
            `INSERT INTO person
               (name, is_holding, holding_for_person_id, is_state_head, designation_id,
                is_active, source)
             VALUES ($1, true, $2, $3, $4, true, 'app_created')
             RETURNING person_id`,
            [`HOLDING — ${person.name}`, personId, person.is_state_head, person.designation_id],
          );
          holdingId = holdRes.rows[0].person_id;
        }
      }

      let moved = 0;
      for (const a of assignmentsToMove) {
        if (holdingId === null) throw new Error("Holding person was not created for a live assignment");
        const closed = await client.query(
          `UPDATE customer_assignment SET effective_to = $2
           WHERE id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
          [a.id, left_date],
        );
        if (closed.rowCount === 0) continue; // closed concurrently — skip
        await client.query(
          `INSERT INTO customer_assignment
             (customer_id, person_id, state_head_person_id, confidence,
              effective_from, set_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            a.customer_id,
            a.person_id === personId ? holdingId : a.person_id,
            a.state_head_person_id === personId ? holdingId : a.state_head_person_id,
            a.confidence,
            left_date,
            changed_by ?? "operator",
          ],
        );
        moved += 1;
      }

      // 4. Void impossible post-departure rows and recreate their customers as
      //    explicit entries in the unassigned queue. The source rows remain
      //    intact with void metadata for audit.
      const voidReason = `Imported after recorded departure on ${left_date}`;
      const voidedCustomerIds: string[] = [];
      for (const assignment of voidablePostDepartureAssignments) {
        const voidResult = await client.query(
          `UPDATE customer_assignment
           SET voided_at = NOW(), voided_by = $2, void_reason = $3
           WHERE id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
          [assignment.id, changed_by ?? "operator", voidReason],
        );
        if (voidResult.rowCount === 0) continue;
        await client.query(
          `INSERT INTO customer_assignment
             (customer_id, person_id, state_head_person_id, confidence,
              effective_from, set_by, former_person_name_raw)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
          [
            assignment.customer_id,
            assignment.state_head_person_id === personId ? null : assignment.state_head_person_id,
            assignment.confidence,
            assignment.effective_from,
            changed_by ?? "operator",
            person.name,
          ],
        );
        voidedCustomerIds.push(assignment.customer_id);
      }
      const voidedCoverage = await client.query(
        `UPDATE person_state_coverage
         SET voided_at = NOW(), voided_by = $2, void_reason = $3
         WHERE coverage_id = ANY($1::bigint[]) AND voided_at IS NULL
         RETURNING coverage_id, state_canon`,
        [
          voidablePostDepartureCoverage.map((coverage) => coverage.coverage_id),
          changed_by ?? "operator",
          voidReason,
        ],
      );

      // 5. Change log
      await client.query(
        `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
         VALUES
           ('person', $1, 'left_date',        NULL, $2, $4),
           ('person', $1, 'departure_reason', NULL, $3, $4),
            ('person', $1, 'departure_holding', NULL, $5, $4),
            ('person', $1, 'departure_voided_imports', NULL, $6, $4)`,
        [
          String(personId),
          left_date,
          departure_reason.trim(),
          changed_by ?? "operator",
          JSON.stringify({ holdingPersonId: holdingId, assignmentsMoved: moved }),
          JSON.stringify({
            customerIds: voidedCustomerIds,
            coverageIds: voidedCoverage.rows.map((coverage) => coverage.coverage_id),
            reason: voidReason,
          }),
        ],
      );

      await client.query("COMMIT");
      res.json({
        success: true,
        holdingPersonId: holdingId,
        assignmentsMoved: moved,
        assignmentsVoidedToUnassigned: voidedCustomerIds,
        coverageVoided: voidedCoverage.rows,
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

// ── GET /api/master/holding ───────────────────────────────────────────────────
// Every holding person that still holds ≥1 open customer assignment.
// Drives the persistent org-page warning banner. Holding persons whose
// customers have all been redistributed are auto-deactivated here (lazy clear)
// so the warning disappears once the last customer is moved off.

router.get("/master/holding", async (req, res) => {
  try {
    // Lazy clear: deactivate holding persons with zero open assignments.
    await pool.query(
      `UPDATE person h SET is_active = false, updated_at = NOW()
       WHERE h.is_holding = true AND h.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM customer_assignment ca
           WHERE ca.effective_to IS NULL AND ca.voided_at IS NULL
             AND (ca.state_head_person_id = h.person_id OR ca.person_id = h.person_id)
         )`,
    );

    const { rows } = await pool.query(
      `SELECT h.person_id AS holding_person_id, h.name AS holding_name,
              d.person_id AS departed_person_id, d.name AS departed_name,
              d.left_date::text, d.departure_reason, d.departure_note,
              (SELECT COUNT(DISTINCT ca.customer_id) FROM customer_assignment ca
               WHERE ca.effective_to IS NULL AND ca.voided_at IS NULL
                 AND (ca.state_head_person_id = h.person_id OR ca.person_id = h.person_id)
              ) AS open_customers
       FROM person h
       JOIN person d ON d.person_id = h.holding_for_person_id
       WHERE h.is_holding = true AND h.is_active = true
       ORDER BY d.left_date DESC NULLS LAST, d.name`,
    );
    // Departure reason/note are HR-sensitive — redact for non-admin callers;
    // the banner only needs name/date/count as operational status.
    const admin = hasAdminToken(req);
    const holdings = rows
      .filter((r: any) => Number(r.open_customers) > 0)
      .map((r: any) =>
        admin ? r : { ...r, departure_reason: null, departure_note: null },
      );
    res.json({ holdings });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/holding/:id/resolve ──────────────────────────────────────
// Resolution path 1: appoint a replacement head — bulk-move every open
// assignment from the holding person to the new head, effective-dated.
// (Path 2 — distribute individually — uses the existing per-customer
// /customers/:id/assign route; the holding state clears lazily via GET /holding.)

router.post("/master/holding/:id/resolve", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const holdingId = Number(req.params.id);
    const { new_head_person_id, effective_from, changed_by } = req.body as {
      new_head_person_id?: number;
      effective_from?: string;
      changed_by?: string;
    };
    if (!new_head_person_id)
      return void res.status(400).json({ error: "new_head_person_id is required" });
    const effFrom =
      effective_from && /^\d{4}-\d{2}-\d{2}$/.test(effective_from)
        ? effective_from
        : new Date().toISOString().slice(0, 10);

    const holdRes = await pool.query(
      `SELECT person_id, name, holding_for_person_id FROM person
       WHERE person_id = $1 AND is_holding = true`,
      [holdingId],
    );
    if (!holdRes.rows[0])
      return void res.status(404).json({ error: "Holding person not found" });

    const newHeadRes = await pool.query(
      `SELECT person_id, name, is_active, is_holding, left_date FROM person WHERE person_id = $1`,
      [new_head_person_id],
    );
    if (!newHeadRes.rows[0])
      return void res.status(404).json({ error: "Replacement person not found" });
    if (newHeadRes.rows[0].is_holding)
      return void res.status(400).json({ error: "Cannot assign customers to another holding person" });
    if (!newHeadRes.rows[0].is_active)
      return void res.status(400).json({ error: "Replacement person is inactive" });
    if (newHeadRes.rows[0].left_date)
      return void res.status(400).json({ error: "Replacement person has departed" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Serialize concurrent resolutions: lock the holding person and reject
      // if another transaction already resolved (deactivated) it.
      const holdLock = await client.query(
        `SELECT is_active FROM person WHERE person_id = $1 AND is_holding = true FOR UPDATE`,
        [holdingId],
      );
      if (!holdLock.rows[0] || !holdLock.rows[0].is_active) {
        await client.query("ROLLBACK");
        return void res
          .status(409)
          .json({ error: "This holding has already been resolved." });
      }

      // Revalidate + lock the replacement inside the transaction so a
      // concurrent departure of the replacement serializes with this resolve.
      const badReplacement = await lockAssignTargets(client, [new_head_person_id]);
      if (badReplacement !== null) {
        await client.query("ROLLBACK");
        return void res.status(400).json({
          error: `Person ${badReplacement} is not a valid replacement (inactive, departed, or holding).`,
        });
      }

      // Lock the open assignment rows; each close re-checks effective_to IS
      // NULL and the replacement is only inserted when the close happened,
      // so a concurrent individual reassignment can never be duplicated.
      const openRes = await client.query(
        `SELECT id, customer_id, person_id, state_head_person_id, confidence
         FROM customer_assignment
         WHERE effective_to IS NULL
           AND voided_at IS NULL
           AND (state_head_person_id = $1 OR person_id = $1)
         FOR UPDATE`,
        [holdingId],
      );

      let moved = 0;
      for (const a of openRes.rows) {
        const closed = await client.query(
          `UPDATE customer_assignment SET effective_to = $2
           WHERE id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
          [a.id, effFrom],
        );
        if (closed.rowCount === 0) continue; // closed concurrently — skip
        await client.query(
          `INSERT INTO customer_assignment
             (customer_id, person_id, state_head_person_id, confidence,
              effective_from, set_by)
           VALUES ($1, $2, $3, 'confirmed', $4, $5)`,
          [
            a.customer_id,
            a.person_id === holdingId ? new_head_person_id : a.person_id,
            a.state_head_person_id === holdingId ? new_head_person_id : a.state_head_person_id,
            effFrom,
            changed_by ?? "operator",
          ],
        );
        moved += 1;
      }

      // Holding fully resolved — deactivate the holding person.
      await client.query(
        `UPDATE person SET is_active = false, updated_at = NOW() WHERE person_id = $1`,
        [holdingId],
      );

      await client.query(
        `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by)
         VALUES ('person', $1, 'holding_resolved', NULL, $2, $3)`,
        [
          String(holdingId),
          JSON.stringify({ newHeadPersonId: new_head_person_id, assignmentsMoved: moved, effectiveFrom: effFrom }),
          changed_by ?? "operator",
        ],
      );

      await client.query("COMMIT");
      res.json({ success: true, assignmentsMoved: moved });
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

// ── GET /api/master/unresolved-links ─────────────────────────────────────────
// The distributor names from the seed that matched no customer row.
// Surfaced in Phase 3 UI so operators can map or confirm gone.

router.get("/master/unresolved-links", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, raw_name, link_count, notes, resolution, mapped_to_id, resolved_by, resolved_at::text
       FROM seed_unresolved_link
       ORDER BY resolution NULLS FIRST, link_count DESC`,
    );
    const totalLostLinks = rows.reduce((s: number, r: any) => s + Number(r.link_count ?? 0), 0);
    res.json({ items: rows, totalLostLinks, unresolvedCount: rows.filter((r: any) => !r.resolution).length });
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
    const { rows } = await pool.query(
      `SELECT p.person_id, p.name, p.employee_code,
              mgr.person_id AS manager_person_id, mgr.name AS manager_name
       FROM person p
       JOIN person mgr ON mgr.person_id = p.reports_to_person_id
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

// ── GET /api/master/customers/unassigned ─────────────────────────────────────
// Customers with person_id IS NULL in their current open assignment.
// Returns customers list + territory breakdown + suggestion data.
//
// Suggestion rules (priority order):
//   a. territory_majority — active person holding the most assigned customers
//      in the same territory. Cover count shown so the caller can trace the rule.
//   b. state_head — state_head_person_id already on the NULL-person assignment row.
//   c. null — no suggestion available; left blank, not guessed.
//
// Params: type, territory_id, page, limit

// ── Shared CTEs used by every unassigned-customer query ──────────────────────
//
// Three rules in priority order:
//   0. former_book — active TM now holding the most of a departed person's former
//      customers (derived once enough formerly-unassigned customers are accepted).
//   a. territory_majority — active TM holding the most currently-assigned customers
//      in the same territory (RANK CTE, cover_count + confidence_band).
//   b. state_head — state_head_person_id already stored on the NULL assignment row.
//   c. null — no suggestion.
//
// Confidence bands (territory_majority only):
//   strong   cover_count ≥ 20 AND share ≥ 50 %
//   moderate cover_count ≥ 5
//   weak     cover_count < 5  — "Accept all" must be blocked in the UI.
//
// Aliases use short prefixes (at_, rtm_, tm_, r0_) to avoid shadowing outer-query
// aliases (uca, c, t, sh).

const UNASSIGNED_SHARED_CTES = `
  -- 1. Total currently-assigned customers per territory (share denominator for band)
  at_ AS (
    SELECT c_at.territory_id, COUNT(*) AS total_assigned
    FROM customer_assignment ca_at
    JOIN customer c_at ON c_at.customer_id = ca_at.customer_id
    WHERE ca_at.effective_to IS NULL AND ca_at.voided_at IS NULL
      AND ca_at.person_id IS NOT NULL
    GROUP BY c_at.territory_id
  ),
  -- 2. Ranked territory-majority persons
  rtm AS (
    SELECT
      c_tm.territory_id,
      ca_tm.person_id,
      p_tm.name AS person_name,
      COUNT(*)   AS cover_count,
      RANK() OVER (
        PARTITION BY c_tm.territory_id
        ORDER BY COUNT(*) DESC, ca_tm.person_id ASC
      ) AS rk
    FROM customer_assignment ca_tm
    JOIN customer c_tm ON c_tm.customer_id = ca_tm.customer_id
    JOIN person   p_tm ON p_tm.person_id   = ca_tm.person_id
    WHERE ca_tm.effective_to IS NULL AND ca_tm.voided_at IS NULL
      AND ca_tm.person_id IS NOT NULL
      AND p_tm.is_active  = true
    GROUP BY c_tm.territory_id, ca_tm.person_id, p_tm.name
  ),
  -- 3. Territory majority (rank=1) + confidence_band
  tm AS (
    SELECT
      r.territory_id, r.person_id, r.person_name, r.cover_count,
      a.total_assigned,
      CASE
        WHEN r.cover_count >= 20
          AND r.cover_count::numeric / NULLIF(a.total_assigned, 0) >= 0.5
          THEN 'strong'
        WHEN r.cover_count >= 5 THEN 'moderate'
        ELSE 'weak'
      END AS confidence_band
    FROM rtm r
    LEFT JOIN at_ a ON a.territory_id = r.territory_id
    WHERE r.rk = 1
  ),
  -- 4. Rule 0 — for each departed person, find the active TM who has accepted
  --    the most of their former customers. Fires once at least one formerly-
  --    unassigned customer is accepted (initially yields 0 rows).
  r0_src AS (
    SELECT
      hist.former_person_name_raw AS former_head,
      curr.person_id,
      p0.name AS person_name,
      COUNT(*)  AS inherited_count,
      RANK() OVER (
        PARTITION BY hist.former_person_name_raw
        ORDER BY COUNT(*) DESC, curr.person_id ASC
      ) AS rk
    FROM customer_assignment hist
    JOIN customer_assignment curr
      ON curr.customer_id  = hist.customer_id
      AND curr.effective_to IS NULL AND curr.voided_at IS NULL
      AND curr.person_id   IS NOT NULL
    JOIN person p0 ON p0.person_id = curr.person_id AND p0.is_active = true
    WHERE hist.former_person_name_raw IS NOT NULL
    GROUP BY hist.former_person_name_raw, curr.person_id, p0.name
  ),
  r0 AS (
    SELECT former_head, person_id, person_name, inherited_count
    FROM r0_src WHERE rk = 1 AND inherited_count >= 5
  )
`;

router.get("/master/customers/unassigned", async (req, res) => {
  try {
    const type = String(req.query.type ?? "").trim();
    const territoryId = req.query.territory_id ? Number(req.query.territory_id) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    const conds = ["uca.effective_to IS NULL", "uca.voided_at IS NULL", "uca.person_id IS NULL"];
    const params: unknown[] = [];
    let pi = 1;
    if (type)        { conds.push(`c.type = $${pi++}`);         params.push(type); }
    if (territoryId) { conds.push(`c.territory_id = $${pi++}`); params.push(territoryId); }
    const where = conds.join(" AND ");

    // Count query: same filters, cheaper alias
    const countWhere = where.replace(/\buca\./g, "ca.");

    const [countRes, rowsRes, groupsRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)
         FROM customer_assignment ca
         JOIN customer c ON c.customer_id = ca.customer_id
         WHERE ${countWhere}`,
        params,
      ),
      // Customer list with Rule 0 / territory_majority / state_head suggestion fields
      pool.query(
        `WITH ${UNASSIGNED_SHARED_CTES}
         SELECT
           c.customer_id, c.name, c.type, c.status,
           c.territory_id,
           t.name  AS territory_name,
           uca.state_head_person_id,
           uca.former_person_name_raw,
           sh.name AS state_head_name,
           COALESCE(r0.person_id, tm.person_id, uca.state_head_person_id)  AS suggested_person_id,
           COALESCE(r0.person_name, tm.person_name, sh.name)               AS suggested_person_name,
           CASE
             WHEN r0.person_id             IS NOT NULL THEN 'former_book'
             WHEN tm.person_id             IS NOT NULL THEN 'territory_majority'
             WHEN uca.state_head_person_id IS NOT NULL THEN 'state_head'
             ELSE NULL
           END AS suggestion_rule,
           COALESCE(r0.inherited_count, tm.cover_count::bigint) AS suggestion_cover_count,
           tm.confidence_band,
           tm.cover_count      AS tm_cover_count,
           tm.total_assigned   AS territory_total_assigned
         FROM customer_assignment uca
         JOIN customer c ON c.customer_id = uca.customer_id
         LEFT JOIN territory t  ON t.territory_id  = c.territory_id
         LEFT JOIN person    sh ON sh.person_id     = uca.state_head_person_id
         LEFT JOIN tm           ON tm.territory_id  = c.territory_id
         LEFT JOIN r0           ON r0.former_head   = uca.former_person_name_raw
         WHERE ${where}
         ORDER BY t.name NULLS LAST, c.type, c.name
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset],
      ),
      // Territory groups — always unfiltered; suggestion data is territory-majority scoped
      pool.query(
        `WITH ${UNASSIGNED_SHARED_CTES}
         SELECT
           c.territory_id,
           t.name   AS territory_name,
           COUNT(*) AS customer_count,
           SUM(CASE WHEN c.type = 'retailer'
               THEN 1 ELSE 0 END) AS retailers,
           SUM(CASE WHEN c.type IN ('distributor','direct_dealer','sub_dealer')
               THEN 1 ELSE 0 END) AS dist_dealer,
           tm.person_id        AS suggested_person_id,
           tm.person_name      AS suggested_person_name,
           tm.cover_count      AS suggestion_cover_count,
           tm.total_assigned   AS territory_total_assigned,
           tm.confidence_band,
           SUM(CASE
             WHEN COALESCE(r0.person_id, tm.person_id, uca.state_head_person_id) IS NOT NULL
             THEN 1 ELSE 0 END) AS with_suggestion
         FROM customer_assignment uca
         JOIN customer c ON c.customer_id = uca.customer_id
         LEFT JOIN territory t ON t.territory_id = c.territory_id
         LEFT JOIN tm          ON tm.territory_id = c.territory_id
         LEFT JOIN r0          ON r0.former_head  = uca.former_person_name_raw
         WHERE uca.effective_to IS NULL AND uca.voided_at IS NULL
           AND uca.person_id IS NULL
         GROUP BY c.territory_id, t.name,
                  tm.person_id, tm.person_name, tm.cover_count,
                  tm.total_assigned, tm.confidence_band
         ORDER BY customer_count DESC`,
      ),
    ]);

    res.json({
      total:           Number(countRes.rows[0].count),
      customers:       rowsRes.rows,
      territoryGroups: groupsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/customers/bulk-assign-suggested ─────────────────────────
// Apply the computed suggestion to every unassigned customer in one territory.
//
// Suggestion rules applied server-side (same priority as GET unassigned):
//   0. former_book      — active TM who inherited the most of the departed person's book
//   a. territory_majority — most-common active TM in territory
//   b. state_head         — state_head_person_id on the NULL-person assignment row
//   c. skipped            — no suggestion; not moved
//
// Each moved customer gets:
//   • old NULL assignment closed (effective_to = CURRENT_DATE)
//   • new open assignment inserted (person_id = suggested, confidence = 'confirmed')
//   • ONE change_log entry  (field='person_id', old=NULL, new=person_id)
//
// Body: { territory_id, changed_by? }
// Returns: { moved, skipped, breakdown: [{ person_name, count, rule }] }

router.post("/master/customers/bulk-assign-suggested", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { territory_id, changed_by } = req.body as {
      territory_id: number;
      changed_by?: string;
    };

    if (!territory_id) {
      return void res.status(400).json({ error: "territory_id is required" });
    }

    // Step 1: territory majority + Rule 0 successors (parallel)
    const [majorityRes, rule0Res, unassignedRes] = await Promise.all([
      // Territory majority
      pool.query<{ person_id: number; person_name: string }>(
        `SELECT ca_tm.person_id, p_tm.name AS person_name, COUNT(*) AS cover_count
         FROM customer_assignment ca_tm
         JOIN customer c_tm ON c_tm.customer_id = ca_tm.customer_id
         JOIN person   p_tm ON p_tm.person_id   = ca_tm.person_id
         WHERE ca_tm.effective_to IS NULL AND ca_tm.voided_at IS NULL
           AND ca_tm.person_id IS NOT NULL AND p_tm.is_active = true
           AND p_tm.is_holding = false AND p_tm.left_date IS NULL
           AND c_tm.territory_id = $1
         GROUP BY ca_tm.person_id, p_tm.name
         ORDER BY COUNT(*) DESC, ca_tm.person_id ASC LIMIT 1`,
        [territory_id],
      ),
      // Rule 0: for each former_person_name_raw in this territory,
      // which active TM now holds the most of those customers?
      pool.query<{
        former_head: string; person_id: number; person_name: string;
      }>(
        `WITH r0_src AS (
           SELECT
             hist.former_person_name_raw AS former_head,
             curr.person_id,
             p0.name AS person_name,
             COUNT(*) AS inherited_count,
             RANK() OVER (
               PARTITION BY hist.former_person_name_raw
               ORDER BY COUNT(*) DESC, curr.person_id ASC
             ) AS rk
           FROM customer_assignment hist
           JOIN customer_assignment curr
             ON curr.customer_id  = hist.customer_id
             AND curr.effective_to IS NULL AND curr.voided_at IS NULL
             AND curr.person_id IS NOT NULL
           JOIN person p0 ON p0.person_id = curr.person_id AND p0.is_active = true
             AND p0.is_holding = false AND p0.left_date IS NULL
           WHERE hist.former_person_name_raw IS NOT NULL
           GROUP BY hist.former_person_name_raw, curr.person_id, p0.name
         )
         SELECT former_head, person_id, person_name FROM r0_src WHERE rk = 1 AND inherited_count >= 5`,
      ),
      // All unassigned customers in this territory
      pool.query<{
        customer_id: string;
        state_head_person_id: number | null;
        state_head_name: string | null;
        sh_is_active: boolean | null;
        former_person_name_raw: string | null;
      }>(
        `SELECT uca.customer_id, uca.state_head_person_id, uca.former_person_name_raw,
                sh.name AS state_head_name,
                (sh.is_active AND sh.is_holding = false AND sh.left_date IS NULL) AS sh_is_active
         FROM customer_assignment uca
         JOIN customer c ON c.customer_id = uca.customer_id
         LEFT JOIN person sh ON sh.person_id = uca.state_head_person_id
         WHERE uca.effective_to IS NULL AND uca.voided_at IS NULL
           AND uca.person_id IS NULL
           AND c.territory_id = $1`,
        [territory_id],
      ),
    ]);

    const majorityPerson = majorityRes.rows[0] ?? null;
    const rule0Map = new Map(rule0Res.rows.map((r) => [r.former_head, r]));

    // Step 2: derive per-customer suggestion (Rule 0 > territory_majority > state_head)
    type ToAssign = {
      customerId: string;
      personId: number;
      personName: string;
      rule: string;
      stateHeadPersonId: number | null;
    };
    const toAssign: ToAssign[] = [];
    const skippedIds: string[] = [];

    for (const row of unassignedRes.rows) {
      const r0 = row.former_person_name_raw
        ? rule0Map.get(row.former_person_name_raw) : undefined;

      if (r0) {
        toAssign.push({
          customerId:      row.customer_id,
          personId:        r0.person_id,
          personName:      r0.person_name,
          rule:            "former_book",
          stateHeadPersonId: row.state_head_person_id ?? null,
        });
      } else if (majorityPerson) {
        toAssign.push({
          customerId:      row.customer_id,
          personId:        majorityPerson.person_id,
          personName:      majorityPerson.person_name,
          rule:            "territory_majority",
          stateHeadPersonId: row.state_head_person_id ?? null,
        });
      } else if (row.state_head_person_id && row.sh_is_active) {
        toAssign.push({
          customerId:      row.customer_id,
          personId:        row.state_head_person_id,
          personName:      row.state_head_name ?? "",
          rule:            "state_head",
          stateHeadPersonId: row.state_head_person_id,
        });
      } else {
        skippedIds.push(row.customer_id);
      }
    }

    if (toAssign.length === 0) {
      return void res.json({
        moved: 0,
        skipped: skippedIds.length,
        noSuggestion: skippedIds.length,
        breakdown: [],
      });
    }

    // Step 4: apply in a single transaction
    const client = await pool.connect();
    let moved = 0;
    const breakdown = new Map<number, { person_name: string; count: number; rule: string }>();

    try {
      await client.query("BEGIN");
      // Lock + revalidate every suggested target (TMs and state heads) inside
      // the transaction so a concurrent departure serializes with this move.
      const suggestedIds = [
        ...new Set(
          toAssign.flatMap((a) =>
            [a.personId, a.stateHeadPersonId].filter(
              (v): v is number => typeof v === "number",
            ),
          ),
        ),
      ];
      const badSuggested = await lockAssignTargets(client, suggestedIds);
      if (badSuggested !== null) {
        await client.query("ROLLBACK");
        return void res.status(409).json({
          error: `Suggested target person ${badSuggested} is no longer a valid assignment target (inactive, departed, or holding). Re-run suggestions.`,
        });
      }
      for (const a of toAssign) {
        await client.query(
          `UPDATE customer_assignment SET effective_to = CURRENT_DATE
           WHERE customer_id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
          [a.customerId],
        );
        await client.query(
          `INSERT INTO customer_assignment
             (customer_id, person_id, state_head_person_id, confidence, effective_from, set_by)
           VALUES ($1, $2, $3, 'confirmed', CURRENT_DATE, $4)`,
          [a.customerId, a.personId, a.stateHeadPersonId, changed_by ?? "bulk_assign_suggested"],
        );
        await client.query(
          `INSERT INTO change_log
             (entity_type, entity_id, field, old_value, new_value, changed_by)
           VALUES ('customer', $1, 'person_id', NULL, $2, $3)`,
          [a.customerId, String(a.personId), changed_by ?? "bulk_assign_suggested"],
        );
        moved++;
        const b = breakdown.get(a.personId) ?? { person_name: a.personName, count: 0, rule: a.rule };
        b.count++;
        breakdown.set(a.personId, b);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({
      moved,
      skipped:  skippedIds.length,
      breakdown: [...breakdown.values()],
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/seed/backfill-former-persons ────────────────────────────
// Re-reads Prayag_Master_Seed.xlsx and backfills former_person_name_raw on the
// existing seed-imported customer_assignment rows where person_id IS NULL
// (i.e. the departed salesperson could not be resolved at import time).
//
// Safe to run multiple times — uses UPDATE … WHERE, never INSERT.
// Returns: { updated, noNameRows, alreadySet }

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// Locate the seed XLSX — the CWD differs between dev (artifact dir) and prod (repo root),
// and import.meta.url depth varies, so we probe known candidate paths instead.
function locateSeedFile(): string {
  const candidates = [
    // Prod / monorepo root cwd
    path.resolve(process.cwd(), "attached_assets/Prayag_Master_Seed_1786767527963.xlsx"),
    // Monorepo root derived from this file's location (src/routes/masterOrg.ts → ../../../../)
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../attached_assets/Prayag_Master_Seed_1786767527963.xlsx"),
    // Same but one fewer level (in case cwd is artifact root)
    path.resolve(process.cwd(), "../../attached_assets/Prayag_Master_Seed_1786767527963.xlsx"),
    // Absolute fallback for this known workspace layout
    "/home/runner/workspace/attached_assets/Prayag_Master_Seed_1786767527963.xlsx",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Seed file not found. Tried: ${candidates.join(", ")}`);
}

router.post("/master/seed/backfill-former-persons", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    // Lazy-import ExcelJS so it doesn't increase cold-start on every request
    const { default: ExcelJS } = await import("exceljs");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(locateSeedFile());

    const str = (v: unknown): string | null => {
      if (v == null || v === "") return null;
      return String(v).trim();
    };
    const readRows = (ws: ExcelJSTypes.Worksheet): unknown[][] => {
      const out: unknown[][] = [];
      ws.eachRow((row: ExcelJSTypes.Row, n: number) => {
        if (n <= 4) return;
        const vals = (row.values as unknown[]).slice(1);
        if (vals.every((v) => v == null || v === "")) return;
        out.push(vals);
      });
      return out;
    };

    // Collect person names already in the system
    const personRows = await pool.query<{ name: string }>(
      "SELECT name FROM person",
    );
    const personNames = new Set(personRows.rows.map((r) => r.name));

    // Customers tab: col 0=custId, col 10=salesperson
    // Retailers tab: col 0=custId, col 8=salesperson
    const custWs = wb.getWorksheet("Customers");
    const retWs  = wb.getWorksheet("Retailers");

    const pairs: { custId: string; formerName: string }[] = [];
    let noNameRows = 0;

    for (const row of (custWs ? readRows(custWs) : [])) {
      const custId = str(row[0]); const sp = str(row[10]);
      if (!custId) continue;
      if (!sp) { noNameRows++; continue; }
      if (personNames.has(sp)) continue; // still active → not departed
      pairs.push({ custId, formerName: sp });
    }
    for (const row of (retWs ? readRows(retWs) : [])) {
      const custId = str(row[0]); const sp = str(row[8]);
      if (!custId) continue;
      if (!sp) { noNameRows++; continue; }
      if (personNames.has(sp)) continue;
      pairs.push({ custId, formerName: sp });
    }

    // Bulk-update in one transaction
    const client = await pool.connect();
    let updated = 0; let alreadySet = 0;
    try {
      await client.query("BEGIN");
      for (const { custId, formerName } of pairs) {
        const r = await client.query(
          `UPDATE customer_assignment
             SET former_person_name_raw = $1
           WHERE customer_id = $2
             AND person_id IS NULL
             AND set_by = 'seed_import'
             AND former_person_name_raw IS NULL`,
          [formerName, custId],
        );
        if ((r.rowCount ?? 0) > 0) updated++;
        else alreadySet++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({
      updated,
      alreadySet,
      noNameRows,
      totalPairs: pairs.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/customers/bulk-assign ────────────────────────────────────
// Bulk reassign unassigned (person_id IS NULL) customers to a TM.
//
// Form A — explicit list:  { customer_ids: string[], to_person_id, ... }
// Form B — filter-based:   { type?, territory_id?, to_person_id, ... }
//   (all NULL-assigned customers matching optional type + territory filters)
//
// Each customer gets:
//   • its current open assignment closed (effective_to = CURRENT_DATE)
//   • a new open assignment inserted (effective_from = CURRENT_DATE)
//   • ONE change_log entry (field='person_id', old_value=NULL, new_value=id)
//
// FY2025-26 /by-head totals are invariant — sale_line is never touched here.

router.post("/master/customers/bulk-assign", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const {
      customer_ids,
      type: typeFilter,
      territory_id,
      to_person_id,
      to_state_head_person_id,
      changed_by,
    } = req.body as {
      customer_ids?: string[];
      type?: string;
      territory_id?: number;
      to_person_id: number;
      to_state_head_person_id?: number | null;
      changed_by?: string;
    };

    if (!to_person_id) {
      return void res.status(400).json({ error: "to_person_id is required" });
    }

    // Verify target person — must be active and not a holding/departed person.
    const targetRes = await pool.query(
      `SELECT person_id, name FROM person
       WHERE person_id = $1 AND is_active = true
         AND is_holding = false AND left_date IS NULL`,
      [to_person_id],
    );
    if (!targetRes.rows[0]) {
      return void res.status(404).json({
        error: `Person ${to_person_id} not found, inactive, departed, or a holding person`,
      });
    }

    // Resolve which customer_ids to move
    let targets: string[];
    if (customer_ids && customer_ids.length > 0) {
      // Form A — explicit list; validate each is actually unassigned
      const chk = await pool.query(
        `SELECT ca.customer_id FROM customer_assignment ca
         WHERE ca.effective_to IS NULL AND ca.voided_at IS NULL
           AND ca.person_id IS NULL
           AND ca.customer_id = ANY($1::text[])`,
        [customer_ids],
      );
      targets = chk.rows.map((r) => r.customer_id);
    } else {
      // Form B — filter-based
      const conds = ["ca.effective_to IS NULL", "ca.voided_at IS NULL", "ca.person_id IS NULL"];
      const params: unknown[] = [];
      let pi = 1;
      if (typeFilter) { conds.push(`c.type = $${pi++}`); params.push(typeFilter); }
      if (territory_id) { conds.push(`c.territory_id = $${pi++}`); params.push(territory_id); }
      const filt = await pool.query(
        `SELECT ca.customer_id FROM customer_assignment ca
         JOIN customer c ON c.customer_id = ca.customer_id
         WHERE ${conds.join(" AND ")}`,
        params,
      );
      targets = filt.rows.map((r) => r.customer_id);
    }

    if (targets.length === 0) {
      return void res.json({ moved: 0, toPersonId: to_person_id,
        toPersonName: targetRes.rows[0].name, customerIds: [] });
    }

    const client = await pool.connect();
    let moved = 0;
    try {
      await client.query("BEGIN");
      // Re-validate and lock ALL targets (TM + optional state head) inside the
      // transaction so a concurrent departure serializes with this bulk move.
      const bulkTargetIds = [to_person_id, to_state_head_person_id].filter(
        (v): v is number => typeof v === "number",
      );
      const badTarget = await lockAssignTargets(client, bulkTargetIds);
      if (badTarget !== null) {
        await client.query("ROLLBACK");
        return void res.status(400).json({
          error: `Person ${badTarget} is not a valid assignment target (inactive, departed, or holding).`,
        });
      }
      for (const customerId of targets) {
        await client.query(
          `UPDATE customer_assignment SET effective_to = CURRENT_DATE
           WHERE customer_id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
          [customerId],
        );
        await client.query(
          `INSERT INTO customer_assignment
             (customer_id, person_id, state_head_person_id, confidence, effective_from, set_by)
           VALUES ($1, $2, $3, 'confirmed', CURRENT_DATE, $4)`,
          [customerId, to_person_id, to_state_head_person_id ?? null, changed_by ?? "bulk_assign"],
        );
        await client.query(
          `INSERT INTO change_log
             (entity_type, entity_id, field, old_value, new_value, changed_by)
           VALUES ('customer', $1, 'person_id', NULL, $2, $3)`,
          [customerId, String(to_person_id), changed_by ?? "bulk_assign"],
        );
        moved++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({
      moved,
      toPersonId: to_person_id,
      toPersonName: targetRes.rows[0].name,
      customerIds: targets,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/master/customers/review-queue ─────────────────────────────────────
// List all entries in the customer review queue (proposed new customers).

router.get("/master/customers/review-queue", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, type, proposed_territory_id, proposed_person_id,
              notes, submitted_by, review_status, reviewed_by, reviewed_at,
              submitted_at::text AS created_at
       FROM customer_review_queue
       ORDER BY submitted_at DESC`,
    );
    const pending = result.rows.filter((r) => r.review_status === "pending").length;
    res.json({ total: result.rows.length, pending, items: result.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/customers/review-queue ────────────────────────────────────
// Propose a new customer. Lands in review queue — NOT in customer table.
// No admin secret required; anyone can propose; an admin must approve.

router.post("/master/customers/review-queue", async (req, res) => {
  try {
    const { name, type, proposed_territory_id, proposed_person_id, notes, submitted_by } =
      req.body as {
        name: string;
        type?: string;
        proposed_territory_id?: number;
        proposed_person_id?: number;
        notes?: string;
        submitted_by?: string;
      };

    if (!name?.trim()) {
      return void res.status(400).json({ error: "name is required" });
    }

    const validTypes = [
      "retailer","distributor","direct_dealer","sub_dealer","project","govt","other",
    ];
    const safeType = validTypes.includes(type ?? "") ? type! : "retailer";

    const result = await pool.query(
      `INSERT INTO customer_review_queue
         (name, type, proposed_territory_id, proposed_person_id, notes, submitted_by, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [
        name.trim(),
        safeType,
        proposed_territory_id ?? null,
        proposed_person_id ?? null,
        notes ?? null,
        submitted_by ?? null,
      ],
    );

    res.status(201).json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/master/customers/review-queue/:id/approve ───────────────────────
// Admin approves a pending entry → creates customer row + optional assignment.
// New customer_id is NEW#XXXXXX (queue item id zero-padded to 6 chars).

router.post("/master/customers/review-queue/:id/approve", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const queueId = Number(req.params.id);
    const { reviewed_by } = req.body as { reviewed_by?: string };

    const qRes = await pool.query(
      "SELECT * FROM customer_review_queue WHERE id = $1",
      [queueId],
    );
    if (!qRes.rows[0]) return void res.status(404).json({ error: "Queue item not found" });
    const item = qRes.rows[0];
    if (item.review_status !== "pending") {
      return void res.status(409).json({ error: `Item is already ${item.review_status}` });
    }

    const newCustomerId = `NEW#${String(queueId).padStart(6, "0")}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO customer (customer_id, name, type) VALUES ($1, $2, $3)`,
        [newCustomerId, item.name, item.type],
      );

      if (item.proposed_person_id) {
        // The proposed person must still be a valid assignment target —
        // locked in-transaction so a concurrent departure serializes here.
        const badProposed = await lockAssignTargets(client, [Number(item.proposed_person_id)]);
        if (badProposed !== null) {
          await client.query("ROLLBACK");
          return void res.status(400).json({
            error: `Proposed person ${badProposed} is not a valid assignment target (inactive, departed, or holding).`,
          });
        }
        await client.query(
          `INSERT INTO customer_assignment
             (customer_id, person_id, confidence, effective_from, set_by)
           VALUES ($1, $2, 'confirmed', CURRENT_DATE, $3)`,
          [newCustomerId, item.proposed_person_id, reviewed_by ?? "admin_approve"],
        );
      }

      await client.query(
        `UPDATE customer_review_queue
         SET review_status = 'approved', reviewed_by = $1,
             reviewed_at = now(), approved_customer_id = $2
         WHERE id = $3`,
        [reviewed_by ?? "admin_approve", newCustomerId, queueId],
      );

      await client.query("COMMIT");
      res.json({ success: true, customerId: newCustomerId });
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

// ── POST /api/master/customers/review-queue/:id/reject ────────────────────────

router.post("/master/customers/review-queue/:id/reject", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const queueId = Number(req.params.id);
    const { reviewed_by, reason } = req.body as { reviewed_by?: string; reason?: string };

    const result = await pool.query(
      `UPDATE customer_review_queue
       SET review_status = 'rejected',
           reviewed_by   = $1,
           reviewed_at   = now(),
           notes         = CASE WHEN notes IS NOT NULL
                             THEN notes || ' | Rejection: ' || COALESCE($2,'(no reason)')
                             ELSE 'Rejection: ' || COALESCE($2,'(no reason)')
                           END
       WHERE id = $3 AND review_status = 'pending'
       RETURNING id`,
      [reviewed_by ?? "admin_reject", reason ?? null, queueId],
    );
    if ((result.rowCount ?? 0) === 0) {
      return void res.status(409).json({ error: "Item not found or already reviewed" });
    }
    res.json({ success: true });
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

    const targetIds = [person_id, state_head_person_id].filter(
      (v): v is number => typeof v === "number",
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Assignment targets must be active, non-departed, non-holding people —
      // validated and locked inside the transaction so a concurrent departure
      // serializes with this assignment.
      const bad = await lockAssignTargets(client, targetIds);
      if (bad !== null) {
        await client.query("ROLLBACK");
        return void res.status(400).json({
          error: `Person ${bad} is not a valid assignment target (inactive, departed, or holding).`,
        });
      }

      // Read current open assignment for change_log
      const prevRes = await client.query(
        `SELECT person_id, state_head_person_id
         FROM customer_assignment
          WHERE customer_id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
        [customerId],
      );
      const prev = prevRes.rows[0] ?? null;

      // Close existing open assignment
      await client.query(
        `UPDATE customer_assignment
         SET effective_to = CURRENT_DATE
         WHERE customer_id = $1 AND effective_to IS NULL AND voided_at IS NULL`,
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

// ── PATCH /api/master/customers/:id/type ──────────────────────────────────────
// Change a customer's type (e.g. distributor → project).
//
// REASON IS MANDATORY — type changes silently broke year-on-year comparison
// in this system before. The reason is written to change_log.reason.
// changed_by holds the operator identity (who), reason holds the why.
// Both must be queryable independently ("who changed X?" vs "why was X changed?").
//
// Effective dating: the change_log row carries the timestamp; the customer
// row is updated in place. Use change_log to reconstruct the type history.

router.patch("/master/customers/:id/type", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const customerId = String(req.params.id);
    const { new_type, reason, changed_by } = req.body as {
      new_type: string;
      reason: string;
      changed_by?: string;
    };

    if (!reason?.trim()) {
      return void res.status(400).json({
        error:
          "reason is required for type changes — " +
          "type edits broke year-on-year comparison before and must carry a permanent audit note",
      });
    }

    const validTypes = [
      "retailer","distributor","direct_dealer","sub_dealer","project","govt","other",
    ];
    if (!validTypes.includes(new_type)) {
      return void res.status(400).json({
        error: `new_type must be one of: ${validTypes.join(", ")}`,
      });
    }

    const current = await pool.query(
      "SELECT type FROM customer WHERE customer_id = $1",
      [customerId],
    );
    if (!current.rows[0]) return void res.status(404).json({ error: "Customer not found" });

    const oldType = current.rows[0].type as string;
    if (oldType === new_type) return void res.json({ success: true, changed: false, reason: "no-op" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        "UPDATE customer SET type = $1 WHERE customer_id = $2",
        [new_type, customerId],
      );

      // changed_by = who made the change (operator identity)
      // reason     = why the type changed (mandatory audit note)
      await client.query(
        `INSERT INTO change_log (entity_type, entity_id, field, old_value, new_value, changed_by, reason)
         VALUES ('customer', $1, 'type', $2, $3, $4, $5)`,
        [customerId, oldType, new_type, changed_by?.trim() || "operator", reason.trim()],
      );

      await client.query("COMMIT");
      res.json({ success: true, changed: true, oldType, newType: new_type });
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
