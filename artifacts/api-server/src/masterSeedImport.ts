// One-time import of Prayag_Master_Seed.xlsx into the master org tables.
//
// Run ONCE after migration 030 is applied.  After this, the app is the master.
//
// Import order (dependency chain):
//   designation → territory (with stub parents) → person (2-pass) →
//   person_territory → customer (distributors+direct dealers+retailers) →
//   customer_assignment → customer_link
//
// Safe to re-run: uses ON CONFLICT DO NOTHING throughout.

import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The seed file path — resolve relative to repo root so it works from any cwd.
const SEED_FILE = path.resolve(
  __dirname,
  "../../../attached_assets/Prayag_Master_Seed_1786767527963.xlsx",
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v).trim();
}

function bool(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === "true" || s === "yes" || s === "1";
}

/** Read data rows from a worksheet (skip header rows 1-4; stop at blank row). */
function readRows(ws: ExcelJS.Worksheet): unknown[][] {
  const out: unknown[][] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 4) return;           // skip title + note + blank + header
    const vals = (row.values as unknown[]).slice(1); // drop the leading undefined
    if (vals.every((v) => v == null || v === "")) return; // blank row
    out.push(vals);
  });
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Opening seed workbook:", SEED_FILE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SEED_FILE);

  const client = await pool.connect();

  try {
    // ── 1. Designations ──────────────────────────────────────────────────────
    console.log("\n── 1. Designations ────────────────────────────────────────");
    const desigWs = wb.getWorksheet("Designations")!;
    const desigRows = readRows(desigWs);
    // cols: designation, rank, people_count, is_system
    let desigInserted = 0;
    for (const row of desigRows) {
      const name = str(row[0]);
      const rank = Number(row[1]) || 0;
      const isSystem = bool(row[3]);
      if (!name) continue;
      const res = await client.query(
        `INSERT INTO designation (name, rank, is_system, created_by)
         VALUES ($1, $2, $3, 'seed_import')
         ON CONFLICT (name) DO NOTHING`,
        [name, rank, isSystem],
      );
      desigInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${desigInserted}  (expected 14)`);

    // Build name → designation_id map
    const desigMap = new Map<string, number>();
    const desigRes = await client.query<{ designation_id: number; name: string }>(
      "SELECT designation_id, name FROM designation",
    );
    for (const r of desigRes.rows) desigMap.set(r.name, r.designation_id);

    // ── 2. Territories ───────────────────────────────────────────────────────
    console.log("\n── 2. Territories ─────────────────────────────────────────");
    const terrWs = wb.getWorksheet("Territories")!;
    const terrRows = readRows(terrWs);
    // cols: territory, parent_territory, is_split, people_assigned, customers

    // Collect all parent names that are NOT themselves in the territory list
    const terrNames = new Set(terrRows.map((r) => str(r[0])).filter(Boolean));
    const parentNames = new Set(terrRows.map((r) => str(r[1])).filter(Boolean));
    const stubParents = [...parentNames].filter((p) => p && !terrNames.has(p)) as string[];

    // Insert stub parents first (not split, no parent)
    let terrInserted = 0;
    for (const name of stubParents) {
      const res = await client.query(
        `INSERT INTO territory (name, is_split)
         VALUES ($1, false)
         ON CONFLICT (name) DO NOTHING`,
        [name],
      );
      terrInserted += res.rowCount ?? 0;
    }
    console.log(`  Stub parent territories: ${terrInserted} (${stubParents.join(", ")})`);

    // Insert actual territories (without parent_territory_id first)
    let terrDataInserted = 0;
    for (const row of terrRows) {
      const name = str(row[0]);
      const isSplit = bool(row[2]);
      if (!name) continue;
      const res = await client.query(
        `INSERT INTO territory (name, is_split)
         VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING`,
        [name, isSplit],
      );
      terrDataInserted += res.rowCount ?? 0;
    }
    console.log(`  Territory rows inserted: ${terrDataInserted}  (expected 36)`);

    // Build name → territory_id map
    const terrMap = new Map<string, number>();
    const terrRes = await client.query<{ territory_id: number; name: string }>(
      "SELECT territory_id, name FROM territory",
    );
    for (const r of terrRes.rows) terrMap.set(r.name, r.territory_id);

    // Update parent_territory_id for split territories
    let parentUpdated = 0;
    for (const row of terrRows) {
      const name = str(row[0]);
      const parentName = str(row[1]);
      const isSplit = bool(row[2]);
      if (!name || !parentName || !isSplit || parentName === name) continue;
      const parentId = terrMap.get(parentName);
      const selfId = terrMap.get(name);
      if (!parentId || !selfId) {
        console.warn(`  WARN: Cannot resolve parent "${parentName}" for "${name}"`);
        continue;
      }
      await client.query(
        `UPDATE territory SET parent_territory_id = $1 WHERE territory_id = $2`,
        [parentId, selfId],
      );
      parentUpdated++;
    }
    console.log(`  Parent links set: ${parentUpdated}`);
    const terrTotal = (await client.query("SELECT COUNT(*) FROM territory")).rows[0].count;
    console.log(`  Total territory rows: ${terrTotal}`);

    // ── 3. Persons — pass 1 (insert without FK refs) ─────────────────────────
    console.log("\n── 3. Persons (pass 1 — insert) ────────────────────────────");
    const peopleWs = wb.getWorksheet("People")!;
    const peopleRows = readRows(peopleWs);
    // cols: name, employee_code, designation, designation_rank, reports_to,
    //       state_head, tier, is_state_head, is_active, headquarter, order_type, source

    let personInserted = 0;
    for (const row of peopleRows) {
      const name = str(row[0]);
      const empCode = str(row[1]);
      const desigName = str(row[2]);
      const isStateHead = bool(row[7]);
      const isActive = row[8] == null ? true : bool(row[8]);
      const hq = str(row[9]);
      const orderType = str(row[10]);
      const source = str(row[11]) ?? "hr_sheet";
      if (!name) continue;
      const desigId = desigName ? (desigMap.get(desigName) ?? null) : null;
      const res = await client.query(
        `INSERT INTO person
           (name, employee_code, designation_id, is_state_head, is_active,
            headquarter, order_type, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [name, empCode, desigId, isStateHead, isActive, hq, orderType, source],
      );
      personInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${personInserted}  (expected 179)`);

    // Build name → person_id map (for FK resolution)
    const personMap = new Map<string, number>();
    const personRes = await client.query<{ person_id: number; name: string }>(
      "SELECT person_id, name FROM person",
    );
    for (const r of personRes.rows) personMap.set(r.name, r.person_id);

    // ── 4. Persons — pass 2 (update FK refs: reports_to, state_head) ─────────
    console.log("\n── 4. Persons (pass 2 — FK links) ──────────────────────────");
    let reportsUpdated = 0;
    let stateHeadUpdated = 0;
    const unresolved: string[] = [];
    for (const row of peopleRows) {
      const name = str(row[0]);
      const reportsToName = str(row[4]);
      const stateHeadName = str(row[5]);
      if (!name) continue;
      const selfId = personMap.get(name);
      if (!selfId) { unresolved.push(`NOT FOUND: ${name}`); continue; }

      const reportsToId = reportsToName ? (personMap.get(reportsToName) ?? null) : null;
      const stateHeadId = stateHeadName ? (personMap.get(stateHeadName) ?? null) : null;

      if (reportsToName && !reportsToId) {
        console.warn(`  WARN: reports_to "${reportsToName}" (for "${name}") not found in person table`);
      }
      if (stateHeadName && !stateHeadId) {
        console.warn(`  WARN: state_head "${stateHeadName}" (for "${name}") not found in person table`);
      }

      await client.query(
        `UPDATE person
            SET reports_to_person_id  = $1,
                state_head_person_id  = $2
          WHERE person_id = $3`,
        [reportsToId, stateHeadId, selfId],
      );
      if (reportsToId) reportsUpdated++;
      if (stateHeadId) stateHeadUpdated++;
    }
    console.log(`  reports_to links: ${reportsUpdated}  state_head links: ${stateHeadUpdated}`);
    if (unresolved.length) console.warn("  Unresolved:", unresolved);

    // ── 5. Person territories ─────────────────────────────────────────────────
    console.log("\n── 5. Person territories ───────────────────────────────────");
    const ptWs = wb.getWorksheet("Person territories")!;
    const ptRows = readRows(ptWs);
    // cols: person, territory, state_head, designation
    let ptInserted = 0;
    let ptSkipped = 0;
    for (const row of ptRows) {
      const personName = str(row[0]);
      const terrName = str(row[1]);
      if (!personName || !terrName) continue;
      const personId = personMap.get(personName);
      const terrId = terrMap.get(terrName);
      if (!personId) { ptSkipped++; console.warn(`  SKIP person_territory: person "${personName}" not found`); continue; }
      if (!terrId)   { ptSkipped++; console.warn(`  SKIP person_territory: territory "${terrName}" not found`); continue; }
      const res = await client.query(
        `INSERT INTO person_territory (person_id, territory_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [personId, terrId],
      );
      ptInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${ptInserted}  skipped: ${ptSkipped}  (expected 260)`);

    // ── 6. Customers (distributors + direct dealers) ──────────────────────────
    console.log("\n── 6. Customers (distributors / direct dealers) ────────────");
    const custWs = wb.getWorksheet("Customers")!;
    const custRows = readRows(custWs);
    // cols: customer_id, company, type, territory, parent_territory, district,
    //       city, status, state_head, confidence, assigned_salesperson,
    //       all_salespeople, salesperson_status, contact_number, gst
    let custInserted = 0;
    const custNameToId = new Map<string, string>(); // company → customer_id (for link resolution)
    for (const row of custRows) {
      const custId = str(row[0]);
      const name = str(row[1]);
      const type = str(row[2]) ?? "distributor";
      const terrName = str(row[3]);
      const status = str(row[7]);
      if (!custId || !name) continue;
      custNameToId.set(name, custId);
      const terrId = terrName ? (terrMap.get(terrName) ?? null) : null;
      const safeType = ["distributor","direct_dealer","retailer","sub_dealer","project","govt","other"].includes(type)
        ? type : "other";
      const res = await client.query(
        `INSERT INTO customer (customer_id, name, type, territory_id, status, source)
         VALUES ($1, $2, $3, $4, $5, 'import')
         ON CONFLICT (customer_id) DO NOTHING`,
        [custId, name, safeType, terrId, status],
      );
      custInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${custInserted}  (expected 3316)`);

    // ── 7. Retailers ─────────────────────────────────────────────────────────
    console.log("\n── 7. Retailers ────────────────────────────────────────────");
    const retWs = wb.getWorksheet("Retailers")!;
    const retRows = readRows(retWs);
    // cols: customer_id, company, territory, parent_territory, district, city,
    //       state_head, confidence, assigned_salesperson, salesperson_status,
    //       n_distributors, contact_number
    let retInserted = 0;
    for (const row of retRows) {
      const custId = str(row[0]);
      const name = str(row[1]);
      const terrName = str(row[2]);
      if (!custId || !name) continue;
      custNameToId.set(name, custId);
      const terrId = terrName ? (terrMap.get(terrName) ?? null) : null;
      const res = await client.query(
        `INSERT INTO customer (customer_id, name, type, territory_id, status, source)
         VALUES ($1, $2, 'retailer', $3, 'Approved', 'import')
         ON CONFLICT (customer_id) DO NOTHING`,
        [custId, name, terrId],
      );
      retInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${retInserted}  (expected 5485)`);

    // ── 8. Customer assignments ───────────────────────────────────────────────
    console.log("\n── 8. Customer assignments ─────────────────────────────────");
    let caInserted = 0;
    let caNoStateHead = 0;  // track customers with no state head (blank → stays blank)
    // Process Customers tab
    for (const row of custRows) {
      const custId = str(row[0]);
      const stateHeadName = str(row[8]);
      const confidence = str(row[9]) ?? "guessed";
      const salespersonName = str(row[10]);
      if (!custId) continue;
      // Blank state_head → blank in DB (do NOT guess)
      const stateHeadId = stateHeadName ? (personMap.get(stateHeadName) ?? null) : null;
      const personId = salespersonName ? (personMap.get(salespersonName) ?? null) : null;
      if (!stateHeadName) caNoStateHead++;
      const safeConf = ["confirmed","assign_user_chain","state_lookup","guessed"].includes(confidence)
        ? confidence : "guessed";
      const res = await client.query(
        `INSERT INTO customer_assignment
           (customer_id, person_id, state_head_person_id, confidence, set_by)
         VALUES ($1, $2, $3, $4, 'seed_import')
         ON CONFLICT DO NOTHING`,
        [custId, personId, stateHeadId, safeConf],
      );
      caInserted += res.rowCount ?? 0;
    }
    // Process Retailers tab
    for (const row of retRows) {
      const custId = str(row[0]);
      const stateHeadName = str(row[6]);
      const confidence = str(row[7]) ?? "guessed";
      const salespersonName = str(row[8]);
      if (!custId) continue;
      const stateHeadId = stateHeadName ? (personMap.get(stateHeadName) ?? null) : null;
      const personId = salespersonName ? (personMap.get(salespersonName) ?? null) : null;
      if (!stateHeadName) caNoStateHead++;
      const safeConf = ["confirmed","assign_user_chain","state_lookup","guessed"].includes(confidence)
        ? confidence : "guessed";
      const res = await client.query(
        `INSERT INTO customer_assignment
           (customer_id, person_id, state_head_person_id, confidence, set_by)
         VALUES ($1, $2, $3, $4, 'seed_import')
         ON CONFLICT DO NOTHING`,
        [custId, personId, stateHeadId, safeConf],
      );
      caInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${caInserted}  (expected 8801 = 3316+5485)`);
    console.log(`  Customers with NO state head (blank, not guessed): ${caNoStateHead}`);

    // ── 9. Customer links (retailer → distributor) ────────────────────────────
    console.log("\n── 9. Customer links ───────────────────────────────────────");
    const linkWs = wb.getWorksheet("Retailer links")!;
    const linkRows = readRows(linkWs);
    // cols: retailer_id, retailer, distributor (name), link_order, territory
    let linkInserted = 0;
    let linkSkippedNoMatch = 0;
    let linkSkippedNoRetailer = 0;
    const unmatchedDists = new Set<string>();
    for (const row of linkRows) {
      const retailerId = str(row[0]);
      const distName = str(row[2]);
      const linkOrder = Number(row[3]) || 1;
      if (!retailerId || !distName) continue;
      // Look up distributor customer_id by name
      const distId = custNameToId.get(distName) ?? null;
      if (!distId) {
        linkSkippedNoMatch++;
        unmatchedDists.add(distName);
        continue;
      }
      // Verify retailer exists in customer table
      const retCheck = await client.query(
        "SELECT 1 FROM customer WHERE customer_id = $1",
        [retailerId],
      );
      if (!retCheck.rowCount) { linkSkippedNoRetailer++; continue; }
      const res = await client.query(
        `INSERT INTO customer_link (retailer_id, distributor_id, link_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (retailer_id, distributor_id, effective_from) DO NOTHING`,
        [retailerId, distId, linkOrder],
      );
      linkInserted += res.rowCount ?? 0;
    }
    console.log(`  Inserted: ${linkInserted}  (expected ~8630 minus unmatched)`);
    console.log(`  Skipped (distributor name not in customer tab): ${linkSkippedNoMatch}`);
    console.log(`  Skipped (retailer not in customer table): ${linkSkippedNoRetailer}`);
    if (unmatchedDists.size > 0) {
      console.log(`  Unmatched distributor names (${unmatchedDists.size}):`);
      for (const n of unmatchedDists) console.log(`    - ${n}`);
    }

    // ── 10. Final counts and verification ────────────────────────────────────
    console.log("\n── 10. Verification counts ─────────────────────────────────");
    const counts = await client.query<{ tbl: string; cnt: string }>(`
      SELECT 'designation'        AS tbl, COUNT(*)::text AS cnt FROM designation
      UNION ALL
      SELECT 'person',                    COUNT(*)::text         FROM person
      UNION ALL
      SELECT 'territory',                 COUNT(*)::text         FROM territory
      UNION ALL
      SELECT 'person_territory',          COUNT(*)::text         FROM person_territory
      UNION ALL
      SELECT 'customer',                  COUNT(*)::text         FROM customer
      UNION ALL
      SELECT 'customer_assignment',       COUNT(*)::text         FROM customer_assignment
      UNION ALL
      SELECT 'customer_link',             COUNT(*)::text         FROM customer_link
      UNION ALL
      SELECT 'change_log',                COUNT(*)::text         FROM change_log
      ORDER BY tbl
    `);
    console.log("  Table                  Rows");
    console.log("  ──────────────────────────────────────");
    for (const r of counts.rows) {
      console.log(`  ${r.tbl.padEnd(22)} ${r.cnt}`);
    }

    // Confidence distribution
    const confRes = await client.query<{ confidence: string; cnt: string }>(
      `SELECT confidence, COUNT(*)::text AS cnt
       FROM customer_assignment
       GROUP BY confidence ORDER BY confidence`,
    );
    console.log("\n  Confidence distribution:");
    for (const r of confRes.rows) {
      console.log(`    ${r.confidence.padEnd(20)} ${r.cnt}`);
    }

    // Customers with no state head
    const noShRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM customer_assignment
       WHERE state_head_person_id IS NULL`,
    );
    console.log(`\n  Customers with no state head: ${noShRes.rows[0].cnt}`);
    console.log("  (These are the 'red rows' in the seed — blank, not guessed)");

    // reports_to orphans (points to non-existent person)
    const orphanRes = await client.query<{ name: string; reports_to_id: number }>(
      `SELECT p.name, p.reports_to_person_id AS reports_to_id
       FROM person p
       WHERE p.reports_to_person_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM person p2 WHERE p2.person_id = p.reports_to_person_id
         )`,
    );
    if (orphanRes.rows.length > 0) {
      console.log("\n  ⚠ reports_to points to MISSING person_id:");
      for (const r of orphanRes.rows) console.log(`    ${r.name} → id ${r.reports_to_id}`);
    } else {
      console.log("\n  ✓ All reports_to resolve to existing persons (or are null for roots).");
    }

    // Cycle check in person hierarchy (simple: if any person can reach itself via reports_to)
    const cycleRes = await client.query<{ person_id: number; name: string }>(`
      WITH RECURSIVE hier AS (
        SELECT person_id, reports_to_person_id, ARRAY[person_id] AS path, false AS cycle
        FROM person WHERE reports_to_person_id IS NOT NULL
        UNION ALL
        SELECT p.person_id, p.reports_to_person_id,
               hier.path || p.person_id,
               p.person_id = ANY(hier.path)
        FROM person p
        JOIN hier ON hier.reports_to_person_id = p.person_id
        WHERE NOT hier.cycle
      )
      SELECT DISTINCT p.person_id, p.name
      FROM hier h
      JOIN person p ON p.person_id = h.person_id
      WHERE h.cycle
    `);
    if (cycleRes.rows.length > 0) {
      console.log("\n  ⚠ CYCLE DETECTED in person hierarchy:");
      for (const r of cycleRes.rows) console.log(`    person_id=${r.person_id} ${r.name}`);
    } else {
      console.log("  ✓ No cycle in person hierarchy.");
    }

    // People whose reports_to is an INACTIVE person
    const inactiveManagerRes = await client.query<{ name: string; manager: string }>(`
      SELECT p.name, m.name AS manager
      FROM person p
      JOIN person m ON m.person_id = p.reports_to_person_id
      WHERE m.is_active = false AND p.reports_to_person_id IS NOT NULL
    `);
    console.log(`\n  People reporting to an INACTIVE person (${inactiveManagerRes.rows.length}):`);
    for (const r of inactiveManagerRes.rows) {
      console.log(`    ${r.name} → ${r.manager} (inactive)`);
    }

    // Untouched source tables
    const srcCounts = await client.query<{ tbl: string; cnt: string }>(`
      SELECT 'sale_line_all'        AS tbl, COUNT(*)::text AS cnt FROM sale_line_all
      UNION ALL
      SELECT 'margin_fact',                 COUNT(*)::text         FROM margin_fact
      UNION ALL
      SELECT 'mrp_history',                 COUNT(*)::text         FROM mrp_history
      UNION ALL
      SELECT 'market_survey',               COUNT(*)::text         FROM market_survey
    `);
    console.log("\n  Source tables (must be UNTOUCHED):");
    for (const r of srcCounts.rows) {
      console.log(`    ${r.tbl.padEnd(22)} ${r.cnt}`);
    }

    console.log("\n✅ Import complete.");

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Import failed:", err);
  process.exit(1);
});
