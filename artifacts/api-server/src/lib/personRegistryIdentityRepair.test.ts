import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

function repairMigrationSql(): string {
  const source = readFileSync(
    resolve(process.cwd(), "../../lib/db/src/runMigrations.ts"),
    "utf8",
  );
  const match = source.match(
    /id: "070_person_registry_identity_link_repair",\s+sql: `([\s\S]*?)`,\s+},/,
  );
  if (!match) throw new Error("Could not locate migration 070");
  return match[1];
}

describe("migration 070 person-registry identity repair", () => {
  it("clears an old shared-code mislink and relinks only through name and manager evidence", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TEMP TABLE person (
        person_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        employee_code TEXT,
        reports_to_person_id INTEGER
      ) ON COMMIT DROP;
      CREATE TEMP TABLE person_registry (
        id INTEGER PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        reporting_manager TEXT,
        employee_code TEXT,
        person_id INTEGER,
        is_person BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      ) ON COMMIT DROP;

      INSERT INTO person (person_id, name, employee_code, reports_to_person_id) VALUES
        (10, 'Nasir Hussain Khan', NULL, NULL),
        (11, 'Sanoj M.', NULL, NULL),
        (97, 'Basit Ahmad Pala', '5900000000000', 10),
        (127, 'Jijo', '5900000000000', 11),
        (200, 'Wrong Shared-Code Match', '5900000000000', 10),
        (300, 'K. Suresh Kumar', '25696++21111', 10);

      INSERT INTO person_registry
        (id, canonical_name, reporting_manager, employee_code, person_id)
      VALUES
        (73, 'Basit Ahmad Pala', 'Nasir Hussain Khan', '5900000000000', 200),
        (129, 'Jijo', 'Sanoj M.', '5900000000000', 127),
        (130, 'No Name Evidence', 'Nasir Hussain Khan', '5900000000000', 97),
        (134, 'K Suresh Kumar', 'Nasir Hussain Khan', '25696++21111', NULL);
      `);

      await client.query(repairMigrationSql());

      const { rows } = await client.query<{
        id: number;
        person_id: number | null;
      }>("SELECT id, person_id FROM person_registry ORDER BY id");
      expect(rows).toEqual([
        { id: 73, person_id: 97 },
        { id: 129, person_id: 127 },
        { id: 130, person_id: null },
        { id: 134, person_id: 300 },
      ]);

      const { rows: audit } = await client.query<{
        registry_id: number;
        action: string;
      }>(`
        SELECT registry_id, action
        FROM person_registry_person_link_repair_audit
        WHERE migration_id = '070_person_registry_identity_link_repair'
        ORDER BY registry_id, action
      `);
      expect(audit).toEqual([
        { registry_id: 73, action: "cleared" },
        { registry_id: 73, action: "relinked" },
        { registry_id: 130, action: "cleared" },
        { registry_id: 134, action: "relinked" },
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});