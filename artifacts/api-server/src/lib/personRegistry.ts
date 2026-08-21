// Person Registry — single source of truth for person/head identities.
//
// Replaces head_alias.json + normalize.json territory_heads as pipeline sources.
//
// STARTUP CONTRACT
//   Call loadPersonRegistry() before any register ingest or SAP derive begins.
//   The exported maps (headAliasLookup, territoryHeads, etc.) start empty and
//   are populated by loadPersonRegistry(). They are safe for synchronous read
//   after that call completes.
//
// PAWAN KUMAR TRAP
//   "PAWAN KUMAR" in the register STATE HEAD column = Pawan Kumar Sharma (state head).
//   "PAWAN KUMAR" in the CRM roster member column = a different team member under
//   Nasir Hussain Khan. Two separate rows. Never merged. A prior name-based merge
//   left Rs 259.4 Cr reading as zero prior-year.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { normSecKey } from "./mgmt/names.js";
import {
  normaliseEmployeeCode,
  resolveEmployeeCode,
  type EmployeeCodeResolution,
} from "./employeeCodeIdentity.js";

// Raw Postgres row shape (snake_case) returned by pool.query.
export interface PersonRegistryRow {
  id: number;
  employee_code: string | null;
  code_plausible: boolean;
  norm_key: string;
  canonical_name: string;
  alias_primary: string[] | null;
  alias_secondary: string | null;
  alias_sheet: string | null;
  reporting_manager: string | null;
  state_head: string | null;
  is_state_head: boolean;
  is_person: boolean;
  hr_status: string | null;
  flag_notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PersonEmployeeCodeCandidate {
  personId: number;
  name: string;
  employeeCode: string | null;
}

/**
 * Canonical runtime employee-code lookup. A shared code deliberately returns
 * both candidates; callers must request human evidence instead of choosing one.
 */
export async function resolvePeopleByEmployeeCode(
  employeeCode: string | null | undefined,
): Promise<EmployeeCodeResolution<PersonEmployeeCodeCandidate>> {
  const code = normaliseEmployeeCode(employeeCode);
  if (!code) return { status: "none", code: null, candidates: [] };

  const { rows } = await pool.query<PersonEmployeeCodeCandidate>(
    `SELECT person_id AS "personId", name, employee_code AS "employeeCode"
       FROM person
      WHERE NULLIF(TRIM(employee_code), '') = $1
      ORDER BY person_id`,
    [code],
  );
  return resolveEmployeeCode(code, rows, (candidate) => candidate.employeeCode);
}

// ── Module-level maps (populated by loadPersonRegistry()) ────────────────────
//
// These are intentionally mutable module-level variables.  They are empty at
// module load time and are populated exactly once during startup by
// loadPersonRegistry().  After that call completes they are effectively
// read-only — no code should ever modify them after startup.

/** raw uppercase key → canonical display name (all persons + non-persons) */
export const headAliasLookup = new Map<string, string>();

/** uppercase raw keys that classify a register row as a territory head */
export const territoryHeads = new Set<string>();

/** uppercase canonical names of institutional (non-person) heads */
export const institutionalHeads = new Set<string>();

/** canonical display names of all state heads (for buildHeadResolver) */
export const canonicalStateHeads: string[] = [];

// ── Registry load ─────────────────────────────────────────────────────────────

export async function loadPersonRegistry(): Promise<void> {
  const { rows } = await pool.query<PersonRegistryRow>(`
    SELECT id, employee_code, code_plausible, norm_key, canonical_name,
           alias_primary, alias_secondary, alias_sheet,
           reporting_manager, state_head,
           is_state_head, is_person, hr_status, flag_notes,
           created_at, updated_at
    FROM person_registry
    ORDER BY id
  `);

  // Clear then repopulate — safe since this only runs at startup.
  headAliasLookup.clear();
  territoryHeads.clear();
  institutionalHeads.clear();
  canonicalStateHeads.length = 0;

  for (const row of rows) {
    const canonical = row.canonical_name;

    if (!row.is_person) {
      // Non-person heads: map their own name and any primary aliases.
      institutionalHeads.add(canonical.toUpperCase());
      headAliasLookup.set(canonical.toUpperCase(), canonical);
      for (const alias of row.alias_primary ?? []) {
        headAliasLookup.set(alias.toUpperCase().trim(), canonical);
      }
      continue;
    }

    // alias_secondary is the display name written into sale_line.head_canon
    // (e.g. "Pawan Sharma" for the state head whose HR name is "Pawan Kumar Sharma").
    // All alias_primary entries must resolve to this same display name so that
    // the register pipeline produces consistent head_canon values.
    // If alias_secondary is absent, fall back to canonical_name.
    const lookupTarget = row.alias_secondary ?? canonical;

    // Map every alias form → lookupTarget.
    for (const alias of row.alias_primary ?? []) {
      headAliasLookup.set(alias.toUpperCase().trim(), lookupTarget);
    }
    if (row.alias_sheet) {
      headAliasLookup.set(row.alias_sheet.toUpperCase().trim(), lookupTarget);
    }
    // Self-mappings so already-canonical spellings pass through.
    // Use conditional set so that a non-state-head's canonical name does not
    // overwrite a state-head alias that was registered earlier.
    // (State heads have lower IDs and are processed first; ORDER BY id ensures
    // their alias_primary entries land in the map before non-state-heads.)
    if (!headAliasLookup.has(canonical.toUpperCase().trim())) {
      headAliasLookup.set(canonical.toUpperCase().trim(), lookupTarget);
    }
    if (row.alias_secondary) {
      // The display name itself should also resolve to lookupTarget.
      if (!headAliasLookup.has(row.alias_secondary.toUpperCase().trim())) {
        headAliasLookup.set(row.alias_secondary.toUpperCase().trim(), lookupTarget);
      }
    }

    if (row.is_state_head) {
      // Gate set: primary aliases that identify this person as a state head
      // when seen in the register STATE HEAD column.
      for (const alias of row.alias_primary ?? []) {
        territoryHeads.add(alias.toUpperCase().trim());
      }
      canonicalStateHeads.push(canonical);
    }
  }

  console.log(
    `[personRegistry] Loaded ${rows.length} rows. ` +
    `State heads: ${canonicalStateHeads.length}. ` +
    `Territory alias keys: ${territoryHeads.size}.`,
  );
}

// ── Startup head-coverage assertion ──────────────────────────────────────────

/** Call after loadPersonRegistry() + after FY2026-27 register data is ready. */
export async function assertHeadCoverage(): Promise<void> {
  const { rows } = await pool.query<{ head_canon: string; cnt: number }>(`
    SELECT head_canon, COUNT(*)::int AS cnt
    FROM sale_line_current
    WHERE fy = '2026-27' AND head_canon IS NOT NULL
    GROUP BY head_canon
    ORDER BY head_canon
  `);

  // Computed bucket labels produced by normalize.ts's classifyHead() for
  // rows that don't belong to any territory head.  These are intentional
  // and must not be flagged as "missing from the registry".
  const COMPUTED_BUCKETS = new Set([
    "NON-TERRITORY / PROJECT / GOVT",
    "PROJECT",
    "GOVT",
    "UNMAPPED",
    "[UNRESOLVED]",
  ]);

  const missing: string[] = [];
  for (const { head_canon } of rows) {
    if (!head_canon) continue;
    const key = head_canon.toUpperCase().trim();
    // Skip computed bucket labels — they are not raw register heads.
    if (COMPUTED_BUCKETS.has(key)) continue;
    // Check: is this head resolvable via the alias maps or institutional set?
    if (!headAliasLookup.has(key) && !institutionalHeads.has(key)) {
      missing.push(head_canon);
    }
  }

  if (missing.length > 0) {
    console.error(
      `[personRegistry] Head-coverage assertion FAILED — ` +
      `${missing.length} head_canon value(s) in FY2026-27 sale register ` +
      `have no registry entry:\n  ${missing.join("\n  ")}`,
    );
    // Non-fatal: warn rather than crash the server, so operators can fix the
    // registry without a restart cycle.  All unresolved heads already land in
    // the "Unmapped" bucket in the analytics.
  } else {
    console.log("[personRegistry] Head-coverage assertion passed — all FY2026-27 heads resolved.");
  }
}

// ── Seed ──────────────────────────────────────────────────────────────────────
//
// One-time operation.  Idempotent: each row has a name-and-manager-derived
// unique norm_key; conflicts are skipped. Employee codes are stored only as
// roster evidence. Parses:
//   1. config/head_alias.json  — alias → canonical mapping (437 entries)
//   2. config/normalize.json   — territory_heads list (25 entries)
//   3. config/hr_roster.csv    — HR member data (862 rows)
// Then resolves state-head enrichment and employee-code plausibility.

export interface SeedReport {
  stateHeads: number;
  members: number;
  nonPersons: number;
  skipped: number;
  implausibleCodes: number;
  flagged: number;
}

function resolveConfigDir(): string {
  // Dev: cwd = artifacts/api-server → config/ is directly under cwd.
  // Prod / deployed: cwd = repo root → need artifacts/api-server/config.
  for (const candidate of [
    join(process.cwd(), "config"),
    join(process.cwd(), "artifacts/api-server/config"),
  ]) {
    try {
      readFileSync(join(candidate, "head_alias.json"));
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error("[personRegistry] Cannot find config/head_alias.json in cwd or artifacts/api-server/config");
}

export async function seedPersonRegistry(): Promise<SeedReport> {
  const configDir = resolveConfigDir();

  // ── Load source files ─────────────────────────────────────────────────────
  const headAlias: Record<string, string> = JSON.parse(
    readFileSync(join(configDir, "head_alias.json"), "utf8"),
  );
  const normalizeConf: { territory_heads: string[]; institutional: string[] } = JSON.parse(
    readFileSync(join(configDir, "normalize.json"), "utf8"),
  );

  const hrRows = parseHrCsv(join(configDir, "hr_roster.csv"));

  // ── Build alias groups: canonical → [all raw keys] ───────────────────────
  const byCanonical = new Map<string, string[]>(); // canonical → raw alias list
  for (const [raw, canon] of Object.entries(headAlias)) {
    const list = byCanonical.get(canon) ?? [];
    list.push(raw.toUpperCase().trim());
    byCanonical.set(canon, list);
  }

  // ── Identify state heads ──────────────────────────────────────────────────
  const territoryKeySet = new Set(
    normalizeConf.territory_heads.map((k) => k.toUpperCase().trim()),
  );
  // A canonical is a state head if at least one of its raw aliases is in territory_heads.
  const stateHeadCanonicals = new Set<string>();
  for (const [raw, canon] of Object.entries(headAlias)) {
    if (territoryKeySet.has(raw.toUpperCase().trim())) {
      stateHeadCanonicals.add(canon);
    }
  }

  // ── Build HR lookup: normSecKey(name) → HR row ───────────────────────────
  const hrByNormName = new Map<string, HrRow>();
  const hrByNormNameManager = new Map<string, HrRow>(); // key = norm(name):norm(manager)
  for (const hr of hrRows) {
    hrByNormName.set(normSecKey(hr.name), hr);
    const compoundKey =
      normSecKey(hr.name) + ":" + normSecKey(hr.reportingManager);
    hrByNormNameManager.set(compoundKey, hr);
  }

  const report: SeedReport = {
    stateHeads: 0,
    members: 0,
    nonPersons: 0,
    skipped: 0,
    implausibleCodes: 0,
    flagged: 0,
  };

  const rows: SeedRow[] = [];

  // ── 1. Non-person institutional heads ────────────────────────────────────
  const institutionalNames = normalizeConf.institutional;
  for (const name of institutionalNames) {
    rows.push({
      normKey: normSecKey(name),
      canonicalName: name,
      aliasPrimary: [name.toUpperCase()],
      aliasSecondary: null,
      aliasSheet: null,
      reportingManager: null,
      stateHead: null,
      isStateHead: false,
      isPerson: false,
      employeeCode: null,
      codePlausible: false,
      hrStatus: null,
      flagNotes: null,
    });
    report.nonPersons++;
  }

  // ── 2. State heads ────────────────────────────────────────────────────────
  //
  // PAWAN KUMAR TRAP: "Pawan Sharma" is the current JSON canonical for Pawan
  // Kumar Sharma (state head), but the HR canonical is "Pawan Kumar Sharma".
  // The team member PAWAN KUMAR has canonical "Pawan Kumar (HR)".
  // We rename "Pawan Sharma" to "Pawan Kumar Sharma" here per the spec.

  for (const canon of stateHeadCanonicals) {
    // Determine canonical_name (prefer HR name where known).
    let canonicalName = canon;
    if (canon === "Pawan Sharma") canonicalName = "Pawan Kumar Sharma";

    // All raw aliases for this canonical from head_alias.json.
    const allAliases = byCanonical.get(canon) ?? [];
    // alias_primary = only the territory-head keys (those in territory_heads).
    const primaryAliases = allAliases.filter((r) => territoryKeySet.has(r));

    // Enrich from HR by matching the canonical (or the HR-renamed canonical).
    let hrRow = hrByNormName.get(normSecKey(canonicalName));
    if (!hrRow && canonicalName !== canon) {
      hrRow = hrByNormName.get(normSecKey(canon));
    }

    const { employeeCode, codePlausible, normKey, flagNotes } =
      resolveNormKey(canonicalName, hrRow);

    rows.push({
      normKey,
      canonicalName,
      aliasPrimary: primaryAliases,
      aliasSecondary: canon !== canonicalName ? canon : null,
      aliasSheet: null,
      reportingManager: hrRow?.reportingManager ?? null,
      stateHead: null, // state heads roll up to themselves
      isStateHead: true,
      isPerson: true,
      employeeCode,
      codePlausible,
      hrStatus: hrRow?.status ?? null,
      flagNotes,
    });
    report.stateHeads++;
    if (!codePlausible && employeeCode) report.implausibleCodes++;
  }

  // ── 3. Non-state-head persons from head_alias.json ───────────────────────
  //
  // These are persons whose canonical does NOT appear as a state head.
  // They include the PAWAN KUMAR (HR) team member row.

  for (const [canon, allAliases] of byCanonical) {
    if (stateHeadCanonicals.has(canon)) continue; // handled above
    // institutional heads are handled above too (as non-persons), but their
    // entries shouldn't appear in head_alias (they don't map to people).

    const { employeeCode, codePlausible, normKey, flagNotes } =
      resolveNormKey(canon, hrByNormName.get(normSecKey(canon)));

    // Determine if this person rolls up to a state head.
    const hrRow = hrByNormName.get(normSecKey(canon));
    const reportingMgr = hrRow?.reportingManager ?? null;
    const resolvedStateHead = reportingMgr
      ? resolveStateHead(reportingMgr, stateHeadCanonicals, headAlias)
      : null;

    rows.push({
      normKey,
      canonicalName: canon,
      aliasPrimary: allAliases,
      aliasSecondary: null,
      aliasSheet: null,
      reportingManager: reportingMgr,
      stateHead: resolvedStateHead,
      isStateHead: false,
      isPerson: true,
      employeeCode,
      codePlausible,
      hrStatus: hrRow?.status ?? null,
      flagNotes,
    });
    report.members++;
    if (!codePlausible && employeeCode) report.implausibleCodes++;
  }

  // ── 4. HR members not in head_alias.json ─────────────────────────────────
  //
  // Any active HR member whose normSecKey(name) does not match any canonical
  // already inserted.  These are people visible in the CRM who have no
  // primary-register alias yet.

  const insertedNormKeys = new Set(rows.map((r) => r.normKey));
  for (const hr of hrRows) {
    const nk0 = normSecKey(hr.name);
    // Skip if already covered by head_alias.json group.
    if (insertedNormKeys.has(nk0)) continue;

    const { employeeCode, codePlausible, normKey, flagNotes } =
      resolveNormKey(hr.name, hr);

    if (insertedNormKeys.has(normKey)) {
      // norm_key collision (e.g. reverse-name duplicate like V. Balamurugan).
      // Add a flag note and skip — these are the "flag, do not merge" cases.
      report.flagged++;
      report.skipped++;
      continue;
    }

    const resolvedStateHead = resolveStateHead(
      hr.reportingManager,
      stateHeadCanonicals,
      headAlias,
    );

    rows.push({
      normKey,
      canonicalName: hr.name,
      aliasPrimary: [],
      aliasSecondary: null,
      aliasSheet: null,
      reportingManager: hr.reportingManager,
      stateHead: resolvedStateHead,
      isStateHead: false,
      isPerson: true,
      employeeCode,
      codePlausible,
      hrStatus: hr.status,
      flagNotes,
    });
    report.members++;
    if (!codePlausible && employeeCode) report.implausibleCodes++;
    insertedNormKeys.add(normKey);
  }

  // ── Insert (idempotent; legacy numeric keys remain compatible) ────────────
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const { rowCount } = await client.query(
        `INSERT INTO person_registry
           (norm_key, canonical_name, alias_primary, alias_secondary, alias_sheet,
            reporting_manager, state_head, is_state_head, is_person,
            employee_code, code_plausible, hr_status, flag_notes)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
         WHERE NOT EXISTS (
           SELECT 1
           FROM person_registry existing
           WHERE LOWER(REGEXP_REPLACE(existing.canonical_name, '[^a-z0-9]', '', 'gi'))
                 = LOWER(REGEXP_REPLACE($2, '[^a-z0-9]', '', 'gi'))
             AND LOWER(REGEXP_REPLACE(COALESCE(existing.reporting_manager, ''), '[^a-z0-9]', '', 'gi'))
                 = LOWER(REGEXP_REPLACE(COALESCE($6, ''), '[^a-z0-9]', '', 'gi'))
         )
         ON CONFLICT (norm_key) DO NOTHING`,
        [
          r.normKey,
          r.canonicalName,
          r.aliasPrimary,
          r.aliasSecondary,
          r.aliasSheet,
          r.reportingManager,
          r.stateHead,
          r.isStateHead,
          r.isPerson,
          r.employeeCode,
          r.codePlausible,
          r.hrStatus,
          r.flagNotes,
        ],
      );
      if (rowCount === 0) report.skipped++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return report;
}

// ── State-head reconciliation ─────────────────────────────────────────────────

/**
 * Idempotent reconciliation: propagate `state_head` from the Phase 1 `person`
 * table into `person_registry`.  Must be called after the master seed import
 * because migration 034 fires before seed data exists on fresh deployments.
 *
 * Step A — members: join person → person.state_head_person_id → sh.name.
 * Step B — state heads themselves: set state_head = canonical_name.
 *
 * Only touches rows where state_head IS NULL.  Safe to call multiple times.
 *
 * @returns Object with counts of rows updated in each step.
 */
export async function reconcilePersonRegistryStateHeads(): Promise<{
  membersUpdated: number;
  stateHeadsUpdated: number;
}> {
  // Step A: propagate from person table (requires seed data to be present).
  //
  // The join normalises both sides with REGEXP_REPLACE + LOWER + TRIM so that
  // internal whitespace differences ("Anant  Singh" vs "Anant Singh") do not
  // prevent a match.  This must stay in sync with the JS normalisation in
  // findRegistryMembersWithoutPersonRow() so the startup coverage check and
  // this reconciliation step are always in agreement about which members are
  // "covered".
  const memberRes = await pool.query<{ count: string }>(`
    WITH updated AS (
      UPDATE person_registry pr
      SET state_head = sh.name,
          updated_at = now()
      FROM person p
      JOIN person sh ON sh.person_id = p.state_head_person_id
      WHERE REGEXP_REPLACE(LOWER(TRIM(p.name)),           '\\s+', ' ', 'g')
          = REGEXP_REPLACE(LOWER(TRIM(pr.canonical_name)), '\\s+', ' ', 'g')
        AND p.state_head_person_id IS NOT NULL
        AND pr.state_head IS NULL
      RETURNING pr.id
    )
    SELECT COUNT(*)::text AS count FROM updated
  `);

  // Step B: state heads' own registry row
  const headRes = await pool.query<{ count: string }>(`
    WITH updated AS (
      UPDATE person_registry pr
      SET state_head = pr.canonical_name,
          updated_at = now()
      WHERE pr.is_state_head = TRUE
        AND pr.state_head IS NULL
      RETURNING pr.id
    )
    SELECT COUNT(*)::text AS count FROM updated
  `);

  return {
    membersUpdated: parseInt(memberRes.rows[0]?.count ?? "0", 10),
    stateHeadsUpdated: parseInt(headRes.rows[0]?.count ?? "0", 10),
  };
}

// ── Person-table coverage check ──────────────────────────────────────────────
//
// If a team member is seeded into person_registry (from the HR roster) but
// never added to the person table (migration 030), migration 034 / the
// reconcilePersonRegistryStateHeads() call cannot set state_head on their
// registry row.  That leaves secondary_sku_line rows attributed to that member
// with state_canon=NULL, making them invisible in territory roll-ups.
//
// This function compares every person_registry member (is_person=true,
// is_state_head=false) against the person table and emits a WARNING for each
// registry member that has no matching person row.  It is non-fatal: the server
// starts regardless so operators can fix the gap without a restart cycle.

export interface PersonTableCoverageResult {
  /** Registry members with no matching person table row (by canonical_name). */
  missing: string[];
  /** Total registry members checked (is_person=true, is_state_head=false). */
  total: number;
}

/**
 * Pure helper: given two name sets, return the names present in registryNames
 * but absent from personNames (case-insensitive, whitespace-normalised).
 *
 * Exported so unit tests can exercise the matching logic without a DB.
 */
export function findRegistryMembersWithoutPersonRow(
  registryNames: string[],
  personNames: string[],
): string[] {
  const personNormSet = new Set(
    personNames.map((n) => n.toLowerCase().replace(/\s+/g, " ").trim()),
  );
  return registryNames.filter(
    (n) => !personNormSet.has(n.toLowerCase().replace(/\s+/g, " ").trim()),
  );
}

/**
 * Startup check — call after loadPersonRegistry().
 *
 * Compares person_registry members against the person table and warns when
 * a member has no matching person row.  Non-fatal: always resolves, never
 * rejects.
 */
export async function assertPersonTableCoverage(): Promise<PersonTableCoverageResult> {
  // Fetch all non-state-head persons from person_registry.
  const { rows: regRows } = await pool.query<{ canonical_name: string }>(`
    SELECT canonical_name
    FROM person_registry
    WHERE is_person = TRUE
      AND is_state_head = FALSE
    ORDER BY canonical_name
  `);

  // Fetch all names from the person table (migration 030).
  const { rows: personRows } = await pool.query<{ name: string }>(`
    SELECT name FROM person
  `);

  const registryNames = regRows.map((r) => r.canonical_name);
  const personNames = personRows.map((r) => r.name);

  const missing = findRegistryMembersWithoutPersonRow(registryNames, personNames);
  const total = registryNames.length;

  if (missing.length > 0) {
    console.warn(
      `[personRegistry] PERSON TABLE GAP — ${missing.length} of ${total} registry ` +
        `member(s) have no matching row in the person table. ` +
        `Their secondary_sku_line rows will have state_canon=NULL and be invisible ` +
        `in territory roll-ups until a person row is added for each:\n` +
        missing.map((n) => `  • ${n}`).join("\n"),
    );
  } else if (total > 0) {
    console.log(
      `[personRegistry] Person-table coverage OK: all ${total} registry ` +
        `member(s) have a matching person table row.`,
    );
  }

  return { missing, total };
}

// ── Registry read helpers (for API routes) ───────────────────────────────────

export async function getRegistryRows(): Promise<PersonRegistryRow[]> {
  const { rows } = await pool.query<PersonRegistryRow>(`
    SELECT * FROM person_registry ORDER BY is_state_head DESC, canonical_name
  `);
  return rows;
}

export type RegistryPatch = {
  aliasPrimary?: string[];
  aliasSecondary?: string | null;
};

export interface RegistryAliasImpact {
  rowCount: number;
  affectedCustomers: string[];
  /** Optimistic-lock value proving the save uses the previewed row version. */
  sourceUpdatedAt: string;
  /** Binds acknowledgement to the exact canonicalized alias proposal. */
  proposalHash: string;
}

export interface RegistryPatchAudit {
  changedBy: string;
  reason: string;
  acknowledgedImpact?: RegistryAliasImpact;
}

export class RegistryImpactRequiredError extends Error {
  constructor(message = "Alias changes require a fresh impact preview acknowledgement.") {
    super(message);
    this.name = "RegistryImpactRequiredError";
  }
}

export class RegistryImpactChangedError extends Error {
  constructor(message = "Registry aliases changed since the impact preview. Preview again before saving.") {
    super(message);
    this.name = "RegistryImpactChangedError";
  }
}

type RegistryPatchField = {
  column: "alias_primary" | "alias_secondary";
  value: string[] | string | null;
  previous: string[] | string | null;
};

type Queryable = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

function sameArray(left: string[] | null, right: string[] | null): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function patchFields(current: PersonRegistryRow, patch: RegistryPatch): RegistryPatchField[] {
  const fields: RegistryPatchField[] = [];
  if (patch.aliasPrimary !== undefined && !sameArray(current.alias_primary, patch.aliasPrimary)) {
    fields.push({ column: "alias_primary", previous: current.alias_primary, value: patch.aliasPrimary });
  }
  if (patch.aliasSecondary !== undefined && current.alias_secondary !== patch.aliasSecondary) {
    fields.push({ column: "alias_secondary", previous: current.alias_secondary, value: patch.aliasSecondary });
  }
  return fields;
}

function canonicalAliasProposal(current: PersonRegistryRow, patch: RegistryPatch) {
  const primary = patch.aliasPrimary ?? current.alias_primary ?? [];
  const secondary = patch.aliasSecondary !== undefined
    ? patch.aliasSecondary
    : current.alias_secondary;
  return {
    aliasPrimary: primary
      .map((value) => value.trim())
      .filter(Boolean)
      .sort(),
    aliasSecondary: secondary?.trim() || null,
  };
}

function aliasProposalHash(current: PersonRegistryRow, patch: RegistryPatch): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalAliasProposal(current, patch)))
    .digest("hex");
}

function attributionAliasKeys(current: PersonRegistryRow, patch: RegistryPatch): string[] {
  const proposal = canonicalAliasProposal(current, patch);
  return [...new Set([
    current.canonical_name,
    current.alias_secondary,
    current.alias_sheet,
    ...(current.alias_primary ?? []),
    current.canonical_name,
    proposal.aliasSecondary,
    ...proposal.aliasPrimary,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toUpperCase()))];
}

async function calculateAliasImpact(
  queryable: Queryable,
  current: PersonRegistryRow,
  patch: RegistryPatch,
): Promise<Pick<RegistryAliasImpact, "rowCount" | "affectedCustomers">> {
  const aliases = attributionAliasKeys(current, patch);
  if (aliases.length === 0) return { rowCount: 0, affectedCustomers: [] };
  const { rows } = await queryable.query<{ head_canon: string; cnt: number }>(`
    SELECT head_canon, COUNT(*)::int AS cnt
    FROM sale_line_current
    WHERE upper(trim(head_canon)) = ANY($1::text[])
    GROUP BY head_canon
    ORDER BY head_canon
  `, [aliases]);
  return {
    rowCount: rows.reduce((sum, row) => sum + Number(row.cnt), 0),
    affectedCustomers: rows.map((row) => row.head_canon),
  };
}

function sameImpact(left: RegistryAliasImpact, right: RegistryAliasImpact): boolean {
  return left.rowCount === right.rowCount
    && left.sourceUpdatedAt === right.sourceUpdatedAt
    && left.proposalHash === right.proposalHash
    && JSON.stringify([...left.affectedCustomers].sort()) === JSON.stringify([...right.affectedCustomers].sort());
}

/**
 * Atomically updates the existing primary/secondary registry aliases and writes an audit
 * record per actual field change. Alias changes are additionally bound to a
 * fresh impact acknowledgement so an operator cannot save after the row changed
 * underneath the preview.
 */
export async function patchRegistryRow(
  id: number,
  patch: RegistryPatch,
  audit: RegistryPatchAudit,
): Promise<PersonRegistryRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: currentRows } = await client.query<PersonRegistryRow>(
      "SELECT * FROM person_registry WHERE id = $1 FOR UPDATE",
      [id],
    );
    const current = currentRows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return null;
    }

    const fields = patchFields(current, patch);
    if (fields.length === 0) {
      await client.query("COMMIT");
      return current;
    }

    const aliasesChanged = fields.some((field) =>
      field.column === "alias_primary"
       || field.column === "alias_secondary",
    );
    if (aliasesChanged) {
      if (!audit.acknowledgedImpact?.proposalHash) throw new RegistryImpactRequiredError();
      const liveImpact = await calculateAliasImpact(client, current, patch);
      const acknowledged: RegistryAliasImpact = {
        ...liveImpact,
        sourceUpdatedAt: current.updated_at.toISOString(),
        proposalHash: aliasProposalHash(current, patch),
      };
      if (!sameImpact(acknowledged, audit.acknowledgedImpact)) {
        throw new RegistryImpactChangedError();
      }
    }

    const setClauses = fields.map((field, index) => `${field.column} = $${index + 2}`);
    const { rows: updatedRows } = await client.query<PersonRegistryRow>(
      `UPDATE person_registry
       SET ${setClauses.join(", ")}, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, ...fields.map((field) => field.value)],
    );
    const updated = updatedRows[0]!;

    for (const field of fields) {
      await client.query(
        `INSERT INTO change_log
           (entity_type, entity_id, field, old_value, new_value, changed_by, reason)
         VALUES ('person_registry', $1, $2, $3, $4, $5, $6)`,
        [
          String(id),
          field.column,
          typeof field.previous === "string" || field.previous === null
            ? field.previous
            : JSON.stringify(field.previous ?? []),
          typeof field.value === "string" || field.value === null
            ? field.value
            : JSON.stringify(field.value),
          audit.changedBy,
          audit.reason,
        ],
      );
    }

    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function previewAliasImpact(
  id: number,
  patch: RegistryPatch,
): Promise<RegistryAliasImpact | null> {
  const { rows: [current] } = await pool.query<PersonRegistryRow>(
    "SELECT * FROM person_registry WHERE id = $1",
    [id],
  );
  if (!current) return null;
  return {
    ...await calculateAliasImpact(pool, current, patch),
    sourceUpdatedAt: current.updated_at.toISOString(),
    proposalHash: aliasProposalHash(current, patch),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface HrRow {
  name: string;
  employeeCode: string;
  reportingManager: string;
  status: string;
  designation: string;
}

interface SeedRow {
  normKey: string;
  canonicalName: string;
  aliasPrimary: string[];
  aliasSecondary: string | null;
  aliasSheet: string | null;
  reportingManager: string | null;
  stateHead: string | null;
  isStateHead: boolean;
  isPerson: boolean;
  employeeCode: string | null;
  codePlausible: boolean;
  hrStatus: string | null;
  flagNotes: string | null;
}

function isPlausibleCode(code: string): boolean {
  return /^\d{1,4}$/.test(code.trim());
}

export function makePersonRegistryIdentityKey(
  name: string,
  reportingManager: string | null | undefined,
): string {
  return `${normSecKey(name)}:${normSecKey(reportingManager ?? "")}`;
}

function resolveNormKey(
  name: string,
  hrRow: HrRow | undefined,
): {
  employeeCode: string | null;
  codePlausible: boolean;
  normKey: string;
  flagNotes: string | null;
} {
  if (!hrRow) {
    return {
      employeeCode: null,
      codePlausible: false,
      normKey: makePersonRegistryIdentityKey(name, null),
      flagNotes: null,
    };
  }
  const code = hrRow.employeeCode?.trim() ?? "";
  const plausible = code !== "" && isPlausibleCode(code);
  const normKey = makePersonRegistryIdentityKey(hrRow.name || name, hrRow.reportingManager);
  const flagNotes = code
    ? (!plausible
      ? `Implausible employee code: "${code}" — flagged for HR correction`
      : null)
    : null;
  return {
    employeeCode: code || null,
    codePlausible: plausible,
    normKey,
    flagNotes,
  };
}

/** Walk the reporting-manager chain to find the top-level state head. */
function resolveStateHead(
  manager: string,
  stateHeadCanonicals: Set<string>,
  headAlias: Record<string, string>,
): string | null {
  if (!manager || manager.trim() === "") return null;

  // Direct match: is the reporting manager a state head canonical?
  if (stateHeadCanonicals.has(manager)) return manager;

  // Check via head alias (the reporting manager column may use a display name
  // that's the canonical, or may be an alias like "Pawan Sharma").
  const aliased = headAlias[manager.toUpperCase().trim()];
  if (aliased && stateHeadCanonicals.has(aliased)) return aliased;

  // Normalize and check.
  const normMgr = normSecKey(manager);
  for (const sh of stateHeadCanonicals) {
    if (normSecKey(sh) === normMgr) return sh;
  }

  // Manager is an intermediate level — return the manager name as-is so it
  // can be resolved later when the full hierarchy is loaded.
  return null;
}

function parseHrCsv(filePath: string): HrRow[] {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Parse CSV header (line 0) to find column indices.
  const header = parseCsvLine(lines[0]);
  const col = (name: string) =>
    header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  const nameIdx = col("Name");
  const codeIdx = col("Employee Code");
  const managerIdx = col("Reporting Manager");
  const statusIdx = col("Status");
  const designationIdx = col("Designation");

  const results: HrRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = parseCsvLine(line);

    const name = cells[nameIdx]?.trim() ?? "";
    if (!name) continue;

    results.push({
      name,
      employeeCode: cells[codeIdx]?.trim() ?? "",
      reportingManager: cells[managerIdx]?.trim() ?? "",
      status: cells[statusIdx]?.trim() ?? "",
      designation: cells[designationIdx]?.trim() ?? "",
    });
  }
  return results;
}

/** Minimal CSV parser: handles quoted fields with commas inside. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
