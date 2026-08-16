#!/usr/bin/env tsx
/**
 * Phase 1 — Populate person_registry.state_head via the person's own chain.
 *
 * Resolution order (MUST match Phase 1 spec exactly):
 *   1. self           — row IS a state head → state_head = canonical_name
 *   2. reports_to_chain — walk reporting_manager upward until is_state_head=true
 *                         • Walk THROUGH inactive/deactive managers (do not stop)
 *                         • Cap at MAX_HOPS to break cycles; report cap hits
 *                         • Resolve manager names via all alias variants
 *   3. crm_roster     — person table gives a direct member→head FK mapping (178 rows)
 *   4. unresolved     — leave state_head NULL, record source
 *
 * Writes state_head AND state_head_source on every is_person=true row.
 * Does NOT touch sale_line, secondary_sku_line, margin_fact or customer_master.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx scripts/populate-state-head-chain.ts
 */

import { pool } from "@workspace/db";

// ── Types ────────────────────────────────────────────────────────────────────

interface RegistryRow {
  id: number;
  canonical_name: string;
  alias_primary: string[] | null;
  alias_secondary: string | null;
  alias_sheet: string | null;
  reporting_manager: string | null;
  state_head: string | null;
  is_state_head: boolean;
  is_person: boolean;
  hr_status: string | null;
}

// ── Name normalisation ────────────────────────────────────────────────────────

/** Lowercase, trim, collapse internal whitespace.  "CHANGAL  CHANDEEP" → "changal chandeep". */
function norm(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const MAX_HOPS = 20; // cycle guard

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Load all registry rows ────────────────────────────────────────────
  const { rows } = await pool.query<RegistryRow>(`
    SELECT id, canonical_name, alias_primary, alias_secondary, alias_sheet,
           reporting_manager, state_head, is_state_head, is_person, hr_status
    FROM person_registry
    ORDER BY id
  `);

  console.log(`Loaded ${rows.length} person_registry rows.`);

  // ── 2. Build name → row lookup  (canonical + all aliases) ────────────────
  // A normalised name can map to multiple rows (duplicates exist in the registry).
  const nameToIds = new Map<string, number[]>();
  const rowById   = new Map<number, RegistryRow>();

  for (const row of rows) {
    rowById.set(row.id, row);

    const names: (string | null | undefined)[] = [
      row.canonical_name,
      ...(row.alias_primary ?? []),
      row.alias_secondary,
      row.alias_sheet,
    ];

    for (const raw of names) {
      const key = norm(raw);
      if (!key) continue;
      const ids = nameToIds.get(key) ?? [];
      if (!ids.includes(row.id)) ids.push(row.id);
      nameToIds.set(key, ids);
    }
  }

  /**
   * Resolve a raw name to the best registry row:
   *   prefer is_state_head=true, then prefer 'Active' hr_status, then first match.
   */
  function resolveNameToRow(rawName: string | null | undefined): RegistryRow | null {
    const key = norm(rawName);
    if (!key) return null;
    const ids = nameToIds.get(key);
    if (!ids || ids.length === 0) return null;
    const candidates = ids.map(id => rowById.get(id)!);
    return (
      candidates.find(r => r.is_state_head) ??
      candidates.find(r => r.hr_status?.toLowerCase().startsWith("active")) ??
      candidates[0]
    );
  }

  // ── 3. Build CRM roster map (person table = STATE HEAD DASHBOARD members) ─
  //
  // The person table has 179 rows seeded from the live STATE HEAD DASHBOARD
  // Data tab; all 179 have state_head_person_id set.  This is source = crm_roster.
  //
  // We map norm(person.name) → canonical state head name (via person_registry lookup).

  const { rows: personRows } = await pool.query<{
    member_name: string;
    sh_name: string;
  }>(`
    SELECT p.name  AS member_name,
           sh.name AS sh_name
    FROM person p
    JOIN person sh ON sh.person_id = p.state_head_person_id
  `);

  // norm(member_name) → state head canonical_name as stored in person_registry
  const crmRoster = new Map<string, string>();

  for (const pr of personRows) {
    // The sh_name from person table may differ from registry canonical
    // (e.g. "Aqil Rizvi" vs "Syed Aqil Rizvi").  Resolve via registry alias map
    // so we always store the registry's own canonical_name.
    const shRow = resolveNameToRow(pr.sh_name);
    const resolvedShName = (shRow && shRow.is_state_head)
      ? shRow.canonical_name
      : pr.sh_name; // keep as-is if not found; still useful

    crmRoster.set(norm(pr.member_name), resolvedShName);
  }

  console.log(`CRM roster loaded: ${crmRoster.size} member→head mappings.`);

  // ── 4. Walk chains ────────────────────────────────────────────────────────

  interface UpdateRow {
    id: number;
    state_head: string | null;
    source: "self" | "reports_to_chain" | "crm_roster" | "unresolved";
    cycled: boolean;
    hops: number;
  }

  const updates: UpdateRow[] = [];
  const cycledNames: string[] = [];

  for (const row of rows) {
    // Only persons are in scope.  Non-person rows (institutional heads, garbled
    // hr_status entries) are skipped — they never appear in state_head rolls.
    if (!row.is_person) continue;

    // ── Step 1: self ──────────────────────────────────────────────────────
    if (row.is_state_head) {
      updates.push({ id: row.id, state_head: row.canonical_name, source: "self", cycled: false, hops: 0 });
      continue;
    }

    // ── Step 2: reports_to_chain ──────────────────────────────────────────
    let resolved: string | null = null;
    let source: UpdateRow["source"] = "unresolved";
    let cycled = false;
    let hops = 0;

    const visited = new Set<number>();
    visited.add(row.id);
    let currentManager: string | null | undefined = row.reporting_manager;

    while (currentManager && hops < MAX_HOPS) {
      const mgrRow = resolveNameToRow(currentManager);
      if (!mgrRow) break; // manager name not in registry

      if (visited.has(mgrRow.id)) {
        // Cycle detected — cap and report
        cycled = true;
        cycledNames.push(`${row.canonical_name} (id=${row.id}, cycled at ${mgrRow.canonical_name})`);
        break;
      }

      visited.add(mgrRow.id);
      hops++;

      if (mgrRow.is_state_head) {
        resolved = mgrRow.canonical_name;
        source = "reports_to_chain";
        break;
      }

      // Walk THROUGH this manager even if inactive/deactive — do not stop here.
      currentManager = mgrRow.reporting_manager;
    }

    // ── Step 3: crm_roster fallback ───────────────────────────────────────
    if (!resolved) {
      const crmHead = crmRoster.get(norm(row.canonical_name));
      if (crmHead) {
        // Double-check that the CRM head is a state head in the registry.
        const shRow = resolveNameToRow(crmHead);
        if (shRow && shRow.is_state_head) {
          resolved = shRow.canonical_name;
          source = "crm_roster";
        } else {
          // CRM head name not in registry as a state head — store as-is and
          // mark crm_roster so operators can investigate.
          resolved = crmHead;
          source = "crm_roster";
        }
      }
    }

    // ── Step 4: unresolved ────────────────────────────────────────────────
    updates.push({
      id: row.id,
      state_head: resolved,
      source: resolved ? source : "unresolved",
      cycled,
      hops,
    });
  }

  // ── 5. Bulk UPDATE person_registry ───────────────────────────────────────
  console.log(`Writing ${updates.length} row updates …`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of updates) {
      await client.query(
        `UPDATE person_registry
         SET state_head        = $1,
             state_head_source = $2,
             updated_at        = now()
         WHERE id = $3`,
        [u.state_head, u.source, u.id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log("Update committed.");

  // ── 6. Verification report ────────────────────────────────────────────────

  const { rows: summary } = await pool.query<{
    source: string;
    cnt: string;
  }>(`
    SELECT state_head_source AS source, COUNT(*)::text AS cnt
    FROM person_registry
    WHERE is_person = true
    GROUP BY state_head_source
    ORDER BY COUNT(*) DESC
  `);

  const { rows: nullRemaining } = await pool.query<{ cnt: string }>(`
    SELECT COUNT(*)::text AS cnt FROM person_registry
    WHERE is_person = true AND state_head IS NULL
  `);

  console.log("\n=== BREAKDOWN BY state_head_source ===");
  for (const r of summary) {
    console.log(`  ${(r.source ?? "NULL").padEnd(20)} ${r.cnt}`);
  }
  console.log(`\n  Rows still with NULL state_head: ${nullRemaining[0]?.cnt ?? "?"}`);

  // Cycle hits
  if (cycledNames.length > 0) {
    console.warn(`\n⚠  ${cycledNames.length} row(s) hit the ${MAX_HOPS}-hop cap (potential cycles):`);
    for (const n of cycledNames) console.warn(`  ${n}`);
  } else {
    console.log("\n✓  No cycle cap hits.");
  }

  // Distinct state_head values with member counts
  const { rows: shDist } = await pool.query<{
    state_head: string | null;
    cnt: string;
    is_sh: boolean;
  }>(`
    SELECT pr.state_head,
           COUNT(*)::text AS cnt,
           bool_or(sh.is_state_head) AS is_sh
    FROM person_registry pr
    LEFT JOIN person_registry sh
           ON REGEXP_REPLACE(LOWER(TRIM(sh.canonical_name)), '\s+', ' ', 'g')
            = REGEXP_REPLACE(LOWER(TRIM(pr.state_head)),     '\s+', ' ', 'g')
    WHERE pr.is_person = true
    GROUP BY pr.state_head
    ORDER BY COUNT(*) DESC
  `);

  console.log("\n=== DISTINCT state_head VALUES ===");
  for (const r of shDist) {
    const flag = r.is_sh ? "✓ real SH" : r.state_head ? "⚠ NOT a SH" : "—";
    console.log(`  ${String(r.state_head ?? "NULL").padEnd(30)} ${r.cnt.padStart(4)} members  ${flag}`);
  }
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exit(1); })
  .finally(() => pool.end());
