import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

export type RelationshipDecision = "linked" | "unresolved";

export interface RelationshipImpact {
  selectedPersonDirectReports: number;
  selectedPersonCustomers: number;
  historicalFactsChanged: {
    saleLine: 0;
    secondarySkuLine: 0;
    marginFact: 0;
  };
  hierarchy: {
    valid: boolean;
    selfLinkPersonIds: number[];
    cyclePersonIds: number[];
  };
  sourceUpdatedAt: string;
  proposalHash: string;
}

export interface RelationshipResolutionPreview {
  registry: {
    id: number;
    canonicalName: string;
    reportingManager: string | null;
    employeeCode: string | null;
    currentPersonId: number | null;
    currentPersonName: string | null;
  };
  decision: RelationshipDecision;
  person: {
    personId: number;
    name: string;
    employeeCode: string | null;
    reportsToPersonId: number | null;
    reportsToName: string | null;
  } | null;
  currentResolution: {
    decision: RelationshipDecision;
    personId: number | null;
    effectiveDate: string;
    reason: string;
    changedBy: string;
    createdAt: string;
  } | null;
  effectiveDate: string;
  impact: RelationshipImpact;
}

interface RegistryRow {
  id: number;
  canonical_name: string;
  reporting_manager: string | null;
  employee_code: string | null;
  person_id: number | null;
  updated_at: Date;
  current_person_name: string | null;
}

interface PersonRow {
  person_id: number;
  name: string;
  employee_code: string | null;
  reports_to_person_id: number | null;
  reports_to_name: string | null;
  updated_at: Date;
  direct_reports: string;
  customers: string;
}

interface CurrentResolutionRow {
  decision: RelationshipDecision;
  person_id: number | null;
  effective_date: string;
  reason: string;
  changed_by: string;
  created_at: Date;
}

export class RelationshipPreviewRequiredError extends Error {}
export class RelationshipPreviewChangedError extends Error {}
export class RelationshipHierarchyInvalidError extends Error {
  constructor(readonly hierarchy: RelationshipImpact["hierarchy"]) {
    super("Operational hierarchy contains a self-link or reporting cycle");
  }
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function currentCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertEffectiveDateIsCurrentOrLaterInHistory(
  effectiveDate: string,
  currentResolution: CurrentResolutionRow | null,
): void {
  if (effectiveDate > currentCalendarDate()) {
    throw new Error("effectiveDate cannot be in the future");
  }
  if (currentResolution && effectiveDate < currentResolution.effective_date) {
    throw new Error(
      `effectiveDate cannot precede the current decision (${currentResolution.effective_date}); record a new decision on or after that date`,
    );
  }
}

function hashProposal(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function loadRegistry(
  queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: RegistryRow[] }> },
  registryId: number,
  forUpdate = false,
): Promise<RegistryRow | null> {
  const { rows } = await queryable.query(
    `SELECT pr.id, pr.canonical_name, pr.reporting_manager, pr.employee_code,
            pr.person_id, pr.updated_at, current_person.name AS current_person_name
       FROM person_registry pr
       LEFT JOIN person current_person ON current_person.person_id = pr.person_id
      WHERE pr.id = $1 AND pr.is_person = TRUE
      ${forUpdate ? "FOR UPDATE OF pr" : ""}`,
    [registryId],
  );
  return rows[0] ?? null;
}

async function loadPerson(
  queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: PersonRow[] }> },
  personId: number,
  forUpdate = false,
): Promise<PersonRow | null> {
  const { rows } = await queryable.query(
    `SELECT p.person_id, p.name, p.employee_code, p.reports_to_person_id,
            manager.name AS reports_to_name, p.updated_at,
            (SELECT COUNT(*) FROM person child
              WHERE child.reports_to_person_id = p.person_id) AS direct_reports,
            (SELECT COUNT(DISTINCT customer_id) FROM customer_assignment
              WHERE effective_to IS NULL AND voided_at IS NULL
                AND (person_id = p.person_id OR state_head_person_id = p.person_id)) AS customers
       FROM person p
       LEFT JOIN person manager ON manager.person_id = p.reports_to_person_id
      WHERE p.person_id = $1
        AND p.is_active = TRUE
        AND COALESCE(p.is_holding, FALSE) = FALSE
        AND COALESCE(p.is_system_coverage, FALSE) = FALSE
      ${forUpdate ? "FOR UPDATE OF p" : ""}`,
    [personId],
  );
  return rows[0] ?? null;
}

async function loadCurrentResolution(
  queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: CurrentResolutionRow[] }> },
  registryId: number,
  forUpdate = false,
): Promise<CurrentResolutionRow | null> {
  const { rows } = await queryable.query(
    `SELECT decision, person_id, effective_date::text, reason, changed_by, created_at
       FROM person_registry_relationship_resolution
      WHERE registry_id = $1 AND superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [registryId],
  );
  return rows[0] ?? null;
}

export async function validateOperationalHierarchy(
  queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ person_id: number }> }> },
): Promise<RelationshipImpact["hierarchy"]> {
  const [selfLinks, cycles] = await Promise.all([
    queryable.query(
      `SELECT person_id FROM person
        WHERE reports_to_person_id = person_id
        ORDER BY person_id`,
    ),
    queryable.query(
      `WITH RECURSIVE chain AS (
         SELECT p.person_id AS start_id, p.person_id AS current_id,
                p.reports_to_person_id, ARRAY[p.person_id]::int[] AS path,
                FALSE AS has_cycle
           FROM person p
         UNION ALL
         SELECT chain.start_id, manager.person_id, manager.reports_to_person_id,
                chain.path || manager.person_id,
                manager.person_id = ANY(chain.path)
           FROM chain
           JOIN person manager ON manager.person_id = chain.reports_to_person_id
          WHERE NOT chain.has_cycle
       )
       SELECT DISTINCT start_id AS person_id
         FROM chain
        WHERE has_cycle
        ORDER BY start_id`,
    ),
  ]);
  const selfLinkPersonIds = selfLinks.rows.map((row) => Number(row.person_id));
  const cyclePersonIds = cycles.rows.map((row) => Number(row.person_id));
  return {
    valid: selfLinkPersonIds.length === 0 && cyclePersonIds.length === 0,
    selfLinkPersonIds,
    cyclePersonIds,
  };
}

function buildPreview(
  registry: RegistryRow,
  person: PersonRow | null,
  currentResolution: CurrentResolutionRow | null,
  decision: RelationshipDecision,
  effectiveDate: string,
  hierarchy: RelationshipImpact["hierarchy"],
): RelationshipResolutionPreview {
  const sourceUpdatedAt = registry.updated_at.toISOString();
  const proposalHash = hashProposal({
    registryId: registry.id,
    sourceUpdatedAt,
    currentPersonId: registry.person_id,
    currentResolutionCreatedAt: currentResolution?.created_at.toISOString() ?? null,
    selectedPersonId: person?.person_id ?? null,
    selectedPersonUpdatedAt: person?.updated_at.toISOString() ?? null,
    selectedPersonDirectReports: Number(person?.direct_reports ?? 0),
    selectedPersonCustomers: Number(person?.customers ?? 0),
    decision,
    effectiveDate,
    hierarchy,
  });
  return {
    registry: {
      id: registry.id,
      canonicalName: registry.canonical_name,
      reportingManager: registry.reporting_manager,
      employeeCode: registry.employee_code,
      currentPersonId: registry.person_id,
      currentPersonName: registry.current_person_name,
    },
    decision,
    person: person
      ? {
          personId: person.person_id,
          name: person.name,
          employeeCode: person.employee_code,
          reportsToPersonId: person.reports_to_person_id,
          reportsToName: person.reports_to_name,
        }
      : null,
    currentResolution: currentResolution
      ? {
          decision: currentResolution.decision,
          personId: currentResolution.person_id,
          effectiveDate: currentResolution.effective_date,
          reason: currentResolution.reason,
          changedBy: currentResolution.changed_by,
          createdAt: currentResolution.created_at.toISOString(),
        }
      : null,
    effectiveDate,
    impact: {
      selectedPersonDirectReports: Number(person?.direct_reports ?? 0),
      selectedPersonCustomers: Number(person?.customers ?? 0),
      // This relationship points the registry at the existing People record.
      // It intentionally never updates fact tables or the People manager chain.
      historicalFactsChanged: { saleLine: 0, secondarySkuLine: 0, marginFact: 0 },
      hierarchy,
      sourceUpdatedAt,
      proposalHash,
    },
  };
}

export async function previewRegistryRelationshipResolution(
  registryId: number,
  input: { personId: number | null; effectiveDate: string },
): Promise<RelationshipResolutionPreview | null> {
  if (!isDate(input.effectiveDate)) throw new Error("effectiveDate must be an ISO calendar date");
  const decision: RelationshipDecision = input.personId === null ? "unresolved" : "linked";
  const [registry, person, currentResolution, hierarchy] = await Promise.all([
    loadRegistry(pool, registryId),
    input.personId === null ? Promise.resolve(null) : loadPerson(pool, input.personId),
    loadCurrentResolution(pool, registryId),
    validateOperationalHierarchy(pool),
  ]);
  if (!registry) return null;
  assertEffectiveDateIsCurrentOrLaterInHistory(input.effectiveDate, currentResolution);
  if (input.personId !== null && !person) throw new Error("Selected People record is not active and assignable");
  return buildPreview(registry, person, currentResolution, decision, input.effectiveDate, hierarchy);
}

export async function resolveRegistryRelationship(
  registryId: number,
  input: {
    personId: number | null;
    effectiveDate: string;
    reason: string;
    changedBy: string;
    acknowledgedProposalHash: string;
  },
): Promise<RelationshipResolutionPreview | null> {
  if (!isDate(input.effectiveDate)) throw new Error("effectiveDate must be an ISO calendar date");
  const reason = input.reason.trim();
  if (!reason) throw new Error("reason is required");
  if (!input.acknowledgedProposalHash) throw new RelationshipPreviewRequiredError("Impact preview acknowledgement is required");
  const decision: RelationshipDecision = input.personId === null ? "unresolved" : "linked";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A SHARE lock makes the graph validation and the eventual link atomic
    // against concurrent People hierarchy edits.
    await client.query("LOCK TABLE person IN SHARE MODE");
    const registry = await loadRegistry(client, registryId, true);
    if (!registry) {
      await client.query("ROLLBACK");
      return null;
    }
    const person = input.personId === null ? null : await loadPerson(client, input.personId, true);
    if (input.personId !== null && !person) throw new Error("Selected People record is not active and assignable");
    const currentResolution = await loadCurrentResolution(client, registryId, true);
    const hierarchy = await validateOperationalHierarchy(client);
    if (!hierarchy.valid) throw new RelationshipHierarchyInvalidError(hierarchy);
    assertEffectiveDateIsCurrentOrLaterInHistory(input.effectiveDate, currentResolution);

    const preview = buildPreview(registry, person, currentResolution, decision, input.effectiveDate, hierarchy);
    if (preview.impact.proposalHash !== input.acknowledgedProposalHash) {
      throw new RelationshipPreviewChangedError("Impact preview changed; review it again before saving");
    }

    await client.query(
      `UPDATE person_registry_relationship_resolution
          SET superseded_at = now()
        WHERE registry_id = $1 AND superseded_at IS NULL`,
      [registryId],
    );
    const evidence = {
      registry: preview.registry,
      selectedPerson: preview.person,
      impact: {
        selectedPersonDirectReports: preview.impact.selectedPersonDirectReports,
        selectedPersonCustomers: preview.impact.selectedPersonCustomers,
        historicalFactsChanged: preview.impact.historicalFactsChanged,
        hierarchy: preview.impact.hierarchy,
      },
    };
    await client.query(
      `INSERT INTO person_registry_relationship_resolution
         (registry_id, person_id, decision, effective_date, reason, changed_by, proposal_hash, evidence)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::jsonb)`,
      [
        registryId,
        input.personId,
        decision,
        input.effectiveDate,
        reason,
        input.changedBy,
        input.acknowledgedProposalHash,
        JSON.stringify(evidence),
      ],
    );
    await client.query(
      `UPDATE person_registry SET person_id = $2, updated_at = now() WHERE id = $1`,
      [registryId, input.personId],
    );
    await client.query(
      `INSERT INTO change_log
         (entity_type, entity_id, field, old_value, new_value, changed_by, reason)
       VALUES ('person_registry', $1, 'person_id', $2, $3, $4, $5)`,
      [
        String(registryId),
        registry.person_id === null ? null : String(registry.person_id),
        input.personId === null
          ? JSON.stringify({ decision, effectiveDate: input.effectiveDate })
          : JSON.stringify({ personId: input.personId, decision, effectiveDate: input.effectiveDate }),
        input.changedBy,
        reason,
      ],
    );
    await client.query("COMMIT");
    return preview;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}