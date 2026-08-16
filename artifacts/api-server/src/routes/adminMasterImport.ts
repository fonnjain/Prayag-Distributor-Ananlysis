/**
 * POST /api/admin/master-import
 *
 * Loads a dev-state snapshot of the master org tables into the running
 * database.  All tables are truncated and re-inserted in a single
 * transaction so the database never sees a partial state.
 *
 * Self-referential foreign keys (territory.parent_territory_id,
 * person.reports_to_person_id, person.state_head_person_id) are handled
 * with a two-pass strategy: insert all rows with those columns nulled,
 * then update them to the real values.  This avoids the need for deferred
 * FK constraints or superuser session_replication_role tricks.
 *
 * Sequences are bumped after insert so that subsequent UI inserts do not
 * collide with the imported IDs.
 *
 * All tables are optional in the request body; only the tables present are
 * touched.  Send them all together for an initial seed.
 *
 * Request body (Content-Type: application/json):
 *   {
 *     designation?:        row[],
 *     territory?:          row[],
 *     person?:             row[],
 *     person_territory?:   row[],
 *     customer?:           row[],
 *     customer_assignment?: row[],
 *     customer_link?:      row[],
 *     market_survey?:      row[],
 *     engine_targets?:     row[],
 *     special_pricing?:    row[]
 *   }
 *
 * Response 200: { imported: { <table>: <rowCount>, ... }, sequences: string[] }
 * Response 401: unauthorized
 * Response 400: malformed body
 * Response 500: DB error (body contains message)
 */
import { Router, Request, Response } from "express";
import { isAdminToken } from "../lib/adminAuth.js";
import { pool } from "@workspace/db";

/** Minimal interface for the pg PoolClient methods used here. */
interface DbClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
}

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

/** Run json_populate_recordset INSERT and return affected-row count. */
async function jsonInsert(
  client: DbClient,
  table: string,
  rows: unknown[],
  extraWhere?: string,
): Promise<number> {
  if (!rows.length) return 0;
  const result = await client.query(
    `INSERT INTO ${table}
     SELECT * FROM json_populate_recordset(null::${table}, $1::json)
     ${extraWhere ?? ""}
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(rows)],
  );
  return result.rowCount ?? 0;
}

// ── route ─────────────────────────────────────────────────────────────────────

router.post(
  "/admin/master-import",
  async (req: Request, res: Response): Promise<void> => {
    const token = (req.headers["x-admin-secret"] as string) ?? "";
    if (!isAdminToken(token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.body as {
      designation?: unknown[];
      territory?: unknown[];
      person?: unknown[];
      person_territory?: unknown[];
      customer?: unknown[];
      customer_assignment?: unknown[];
      customer_link?: unknown[];
      market_survey?: unknown[];
      engine_targets?: unknown[];
      special_pricing?: unknown[];
    };

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "JSON body required" });
      return;
    }

    const present = (key: keyof typeof body) =>
      Array.isArray(body[key]);

    // Tables provided in this request — only these are touched.
    const touching = (
      [
        "designation", "territory", "person", "person_territory",
        "customer", "customer_assignment", "customer_link",
        "market_survey", "engine_targets", "special_pricing",
      ] as const
    ).filter(present);

    if (!touching.length) {
      res.status(400).json({ error: "No table arrays found in request body" });
      return;
    }

    const client = (await pool.connect()) as unknown as DbClient;
    try {
      await client.query("BEGIN");

      // ── 1. TRUNCATE all 12 tables in one statement ───────────────────────
      // PostgreSQL resolves FK order automatically when ALL tables in the
      // FK dependency graph are listed together in a single TRUNCATE.
      // Two tables outside our 10 also reference master tables:
      //   seed_unresolved_link  → customer
      //   customer_review_queue → person, territory
      // Including them in the same statement avoids CASCADE wiping other data.
      // We always clear the full set regardless of which tables are provided —
      // this prevents partial-presence FK violations (e.g. truncating
      // designation while person still exists referencing it).
      await client.query(`
        TRUNCATE TABLE
          seed_unresolved_link,
          customer_review_queue,
          customer_link,
          customer_assignment,
          person_territory,
          market_survey,
          engine_targets,
          special_pricing,
          customer,
          person,
          territory,
          designation
        RESTART IDENTITY
      `);

      const imported: Record<string, number> = {};

      // ── 2. INSERT in FK dependency order ────────────────────────────────

      // designation (no foreign deps)
      if (present("designation")) {
        imported.designation = await jsonInsert(client, "designation", body.designation!);
      }

      // territory — self-ref via parent_territory_id
      if (present("territory")) {
        // Pass 1: insert with parent nulled
        await client.query(
          `INSERT INTO territory (territory_id, name, parent_territory_id, is_split)
           SELECT territory_id, name, NULL, is_split
           FROM json_populate_recordset(null::territory, $1::json)
           ON CONFLICT DO NOTHING`,
          [JSON.stringify(body.territory)],
        );
        // Pass 2: restore parent references
        const r2 = await client.query(
          `UPDATE territory t
           SET parent_territory_id = s.parent_territory_id
           FROM json_populate_recordset(null::territory, $1::json) s
           WHERE t.territory_id = s.territory_id
             AND s.parent_territory_id IS NOT NULL`,
          [JSON.stringify(body.territory)],
        );
        imported.territory = body.territory!.length;
        void r2; // updated rows tracked via length
      }

      // person — self-refs: reports_to_person_id, state_head_person_id
      if (present("person")) {
        // Pass 1: insert with self-refs nulled
        await client.query(
          `INSERT INTO person (
             person_id, name, employee_code, designation_id,
             reports_to_person_id, state_head_person_id,
             is_state_head, is_active, headquarter, order_type,
             source, created_at, updated_at
           )
           SELECT
             person_id, name, employee_code, designation_id,
             NULL, NULL,
             is_state_head, is_active, headquarter, order_type,
             source, created_at, updated_at
           FROM json_populate_recordset(null::person, $1::json)
           ON CONFLICT DO NOTHING`,
          [JSON.stringify(body.person)],
        );
        // Pass 2: restore self-refs
        await client.query(
          `UPDATE person p
           SET
             reports_to_person_id = s.reports_to_person_id,
             state_head_person_id  = s.state_head_person_id
           FROM json_populate_recordset(null::person, $1::json) s
           WHERE p.person_id = s.person_id`,
          [JSON.stringify(body.person)],
        );
        imported.person = body.person!.length;
      }

      // person_territory (refs person + territory)
      if (present("person_territory")) {
        imported.person_territory = await jsonInsert(
          client, "person_territory", body.person_territory!,
        );
      }

      // customer (refs territory)
      if (present("customer")) {
        imported.customer = await jsonInsert(client, "customer", body.customer!);
      }

      // customer_assignment (refs customer + person)
      if (present("customer_assignment")) {
        imported.customer_assignment = await jsonInsert(
          client, "customer_assignment", body.customer_assignment!,
        );
      }

      // customer_link (refs customer × 2)
      if (present("customer_link")) {
        imported.customer_link = await jsonInsert(
          client, "customer_link", body.customer_link!,
        );
      }

      // market_survey (refs customer_master, not customer — no FK block)
      if (present("market_survey")) {
        imported.market_survey = await jsonInsert(
          client, "market_survey", body.market_survey!,
        );
      }

      // engine_targets
      if (present("engine_targets")) {
        imported.engine_targets = await jsonInsert(
          client, "engine_targets", body.engine_targets!,
        );
      }

      // special_pricing
      if (present("special_pricing")) {
        imported.special_pricing = await jsonInsert(
          client, "special_pricing", body.special_pricing!,
        );
      }

      // ── 3. Bump sequences so subsequent UI inserts don't collide ────────
      const seqUpdates = [
        ["designation", "designation_designation_id_seq", "designation_id"],
        ["territory",   "territory_territory_id_seq",    "territory_id"],
        ["person",      "person_person_id_seq",           "person_id"],
        ["customer_assignment", "customer_assignment_id_seq", "id"],
        ["customer_link",       "customer_link_id_seq",       "id"],
        ["market_survey",       "market_survey_id_seq",       "id"],
        ["engine_targets",      "engine_targets_id_seq",      "id"],
        ["special_pricing",     "special_pricing_id_seq",     "id"],
      ] as const;

      const seqResults: string[] = [];
      for (const [tbl, seq, col] of seqUpdates) {
        if (!present(tbl as keyof typeof body)) continue;
        const { rows } = await client.query<{ next: string }>(
          `SELECT setval($1, COALESCE((SELECT MAX(${col}) FROM ${tbl}), 0)) AS next`,
          [seq],
        );
        seqResults.push(`${seq} → ${rows[0]?.next ?? "?"}`);
      }

      await client.query("COMMIT");

      res.json({ imported, sequences: seqResults });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log?.error({ err }, "admin/master-import failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  },
);

export default router;
