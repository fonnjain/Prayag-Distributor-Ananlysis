import { pool } from "@workspace/db";

export type RegistryMappingStatus =
  | "automatic_candidate"
  | "employee_code_conflict"
  | "manager_conflict"
  | "ambiguous_name"
  | "insufficient_manager_evidence"
  | "no_name_candidate";

export type EmployeeCodeEvidence =
  | "absent"
  | "matches_candidate"
  | "shared_with_candidate"
  | "matches_other_person"
  | "shared_without_candidate"
  | "no_people_code_match"
  | "conflicts_with_candidate";

export interface RegistryMappingSource {
  id: number;
  personId: number | null;
  normKey: string;
  canonicalName: string;
  employeeCode: string | null;
  codePlausible: boolean;
  reportingManager: string | null;
  stateHead: string | null;
  isStateHead: boolean;
  hrStatus: string | null;
  flagNotes: string | null;
}

export interface OperationalPerson {
  personId: number;
  name: string;
  employeeCode: string | null;
  isActive: boolean;
  isStateHead: boolean;
  reportsToPersonId: number | null;
  reportsToName: string | null;
  stateHeadPersonId: number | null;
  stateHeadName: string | null;
}

export interface MappingCandidate {
  personId: number;
  name: string;
  employeeCode: string | null;
  isActive: boolean;
  reportsToPersonId: number | null;
  reportsToName: string | null;
  stateHeadPersonId: number | null;
  stateHeadName: string | null;
}

export interface RegistryMappingReportRow {
  registryId: number;
  canonicalName: string;
  normKey: string;
  registryEmployeeCode: string | null;
  codePlausible: boolean;
  reportingManager: string | null;
  registryStateHead: string | null;
  isStateHead: boolean;
  hrStatus: string | null;
  flagNotes: string | null;
  status: RegistryMappingStatus;
  reviewRoute: string;
  candidatePeople: MappingCandidate[];
  employeeCodeEvidence: EmployeeCodeEvidence;
  managerComparison: {
    registryManager: string | null;
    operationalManager: string | null;
    agrees: boolean | null;
  };
}

export interface RegistryManagerConflict extends RegistryMappingReportRow {
  mappingScope: "linked" | "unmapped";
}

export interface PersonRegistryMappingReport {
  generatedAt: string;
  summary: {
    registryPersonRows: number;
    linkedRows: number;
    unmappedRows: number;
    automaticCandidates: number;
    reviewQueue: number;
    managerConflicts: number;
    unmappedManagerConflicts: number;
    byStatus: Record<RegistryMappingStatus, number>;
  };
  /** Every currently-unmapped person_registry record, without applying a link. */
  rows: RegistryMappingReportRow[];
  /** Manager disagreements are deliberately separate from the general review queue. */
  managerConflicts: RegistryManagerConflict[];
  /** Review queue counts grouped by the registry's stated State Head where available. */
  routeCounts: Array<{ stateHead: string; count: number }>;
}

export type ReadonlyQueryable = {
  query: <T>(sql: string) => Promise<{ rows: T[] }>;
};

const UNASSIGNED_ROUTE = "Unassigned";

function norm(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normaliseEmployeeCode(value: string | null | undefined): string | null {
  const code = String(value ?? "").trim();
  return code || null;
}

function candidateFromPerson(person: OperationalPerson): MappingCandidate {
  return {
    personId: person.personId,
    name: person.name,
    employeeCode: person.employeeCode,
    isActive: person.isActive,
    reportsToPersonId: person.reportsToPersonId,
    reportsToName: person.reportsToName,
    stateHeadPersonId: person.stateHeadPersonId,
    stateHeadName: person.stateHeadName,
  };
}

function countByStatus(rows: RegistryMappingReportRow[]): Record<RegistryMappingStatus, number> {
  return {
    automatic_candidate: rows.filter((row) => row.status === "automatic_candidate").length,
    employee_code_conflict: rows.filter((row) => row.status === "employee_code_conflict").length,
    manager_conflict: rows.filter((row) => row.status === "manager_conflict").length,
    ambiguous_name: rows.filter((row) => row.status === "ambiguous_name").length,
    insufficient_manager_evidence: rows.filter((row) => row.status === "insufficient_manager_evidence").length,
    no_name_candidate: rows.filter((row) => row.status === "no_name_candidate").length,
  };
}

/**
 * Classifies possible registry-to-People relationships without changing either
 * table. Employee codes can corroborate a unique name-and-manager match but
 * never establish identity by themselves.
 */
export function buildPersonRegistryMappingReport(
  registryRows: RegistryMappingSource[],
  people: OperationalPerson[],
  generatedAt = new Date(),
): PersonRegistryMappingReport {
  const peopleByName = new Map<string, OperationalPerson[]>();
  const peopleByCode = new Map<string, OperationalPerson[]>();

  for (const person of people) {
    const nameKey = norm(person.name);
    if (nameKey) {
      const sameName = peopleByName.get(nameKey) ?? [];
      sameName.push(person);
      peopleByName.set(nameKey, sameName);
    }

    const code = normaliseEmployeeCode(person.employeeCode);
    if (code) {
      const sameCode = peopleByCode.get(code) ?? [];
      sameCode.push(person);
      peopleByCode.set(code, sameCode);
    }
  }

  const classify = (source: RegistryMappingSource): RegistryMappingReportRow => {
    const candidates = peopleByName.get(norm(source.canonicalName)) ?? [];
    const candidatePeople = candidates.map(candidateFromPerson);
    const sourceCode = normaliseEmployeeCode(source.employeeCode);
    const codePeople = sourceCode ? peopleByCode.get(sourceCode) ?? [] : [];
    const uniqueCandidate = candidates.length === 1 ? candidates[0] : null;
    const candidateCode = normaliseEmployeeCode(uniqueCandidate?.employeeCode);
    const codeConflicts = Boolean(sourceCode && candidateCode && sourceCode !== candidateCode);
    const codeIncludesCandidate = Boolean(
      uniqueCandidate && codePeople.some((person) => person.personId === uniqueCandidate.personId),
    );

    let employeeCodeEvidence: EmployeeCodeEvidence = "absent";
    if (sourceCode && uniqueCandidate && codeConflicts) {
      employeeCodeEvidence = "conflicts_with_candidate";
    } else if (sourceCode && uniqueCandidate && codeIncludesCandidate) {
      employeeCodeEvidence = codePeople.length === 1 ? "matches_candidate" : "shared_with_candidate";
    } else if (sourceCode && uniqueCandidate && codePeople.length === 1) {
      employeeCodeEvidence = "matches_other_person";
    } else if (sourceCode && codePeople.length > 1) {
      employeeCodeEvidence = "shared_without_candidate";
    } else if (sourceCode) {
      employeeCodeEvidence = codePeople.length === 0
        ? "no_people_code_match"
        : "matches_other_person";
    }

    const registryManagerKey = norm(source.reportingManager);
    const operationalManagerKey = norm(uniqueCandidate?.reportsToName);
    const managerEvidenceAvailable = Boolean(registryManagerKey && operationalManagerKey);
    const managerAgrees = managerEvidenceAvailable
      ? registryManagerKey === operationalManagerKey
      : null;

    let status: RegistryMappingStatus;
    if (candidates.length === 0) {
      status = "no_name_candidate";
    } else if (candidates.length > 1) {
      status = "ambiguous_name";
    } else if (codeConflicts) {
      // A nonblank disagreement is a review condition even when name and
      // manager agree. Migration 070 applies the same fail-closed policy.
      status = "employee_code_conflict";
    } else if (managerAgrees === false) {
      status = "manager_conflict";
    } else if (managerAgrees !== true) {
      status = "insufficient_manager_evidence";
    } else {
      status = "automatic_candidate";
    }

    const reviewRoute =
      source.stateHead?.trim() ||
      uniqueCandidate?.stateHeadName?.trim() ||
      UNASSIGNED_ROUTE;

    return {
      registryId: source.id,
      canonicalName: source.canonicalName,
      normKey: source.normKey,
      registryEmployeeCode: source.employeeCode,
      codePlausible: source.codePlausible,
      reportingManager: source.reportingManager,
      registryStateHead: source.stateHead,
      isStateHead: source.isStateHead,
      hrStatus: source.hrStatus,
      flagNotes: source.flagNotes,
      status,
      reviewRoute,
      candidatePeople,
      employeeCodeEvidence,
      managerComparison: {
        registryManager: source.reportingManager,
        operationalManager: uniqueCandidate?.reportsToName ?? null,
        agrees: managerAgrees,
      },
    };
  };

  const allRows = registryRows.map(classify);
  const sourceById = new Map(registryRows.map((row) => [row.id, row]));
  const rows = allRows.filter((row) => sourceById.get(row.registryId)?.personId == null);
  const managerConflicts = allRows
    .filter((row) => row.managerComparison.agrees === false)
    .map((row): RegistryManagerConflict => ({
      ...row,
      mappingScope: sourceById.get(row.registryId)?.personId == null
        ? "unmapped"
        : "linked",
    }));
  const reviewRows = rows.filter((row) => row.status !== "automatic_candidate");
  const routes = new Map<string, number>();
  for (const row of reviewRows) {
    routes.set(row.reviewRoute, (routes.get(row.reviewRoute) ?? 0) + 1);
  }

  return {
    generatedAt: generatedAt.toISOString(),
    summary: {
      registryPersonRows: registryRows.length,
      linkedRows: registryRows.length - rows.length,
      unmappedRows: rows.length,
      automaticCandidates: rows.filter((row) => row.status === "automatic_candidate").length,
      reviewQueue: reviewRows.length,
      managerConflicts: managerConflicts.length,
      unmappedManagerConflicts: reviewRows.filter(
        (row) => row.managerComparison.agrees === false,
      ).length,
      byStatus: countByStatus(rows),
    },
    rows,
    managerConflicts,
    routeCounts: [...routes.entries()]
      .map(([stateHead, count]) => ({ stateHead, count }))
      .sort((left, right) => right.count - left.count || left.stateHead.localeCompare(right.stateHead)),
  };
}

/**
 * Read-only report loader. Its SQL is deliberately limited to two SELECTs:
 * registry provenance and the operational People hierarchy.
 */
export async function getPersonRegistryMappingReport(
  db: ReadonlyQueryable = pool,
): Promise<PersonRegistryMappingReport> {
  const [registryResult, peopleResult] = await Promise.all([
    db.query<RegistryMappingSource>(`
      SELECT pr.id,
             pr.person_id AS "personId",
             pr.norm_key AS "normKey",
             pr.canonical_name AS "canonicalName",
             pr.employee_code AS "employeeCode",
             pr.code_plausible AS "codePlausible",
             pr.reporting_manager AS "reportingManager",
             pr.state_head AS "stateHead",
             pr.is_state_head AS "isStateHead",
             pr.hr_status AS "hrStatus",
             pr.flag_notes AS "flagNotes"
      FROM person_registry pr
      WHERE pr.is_person = TRUE
      ORDER BY pr.state_head NULLS LAST, pr.canonical_name, pr.id
    `),
    db.query<OperationalPerson>(`
      SELECT p.person_id AS "personId",
             p.name,
             p.employee_code AS "employeeCode",
             p.is_active AS "isActive",
             p.is_state_head AS "isStateHead",
             p.reports_to_person_id AS "reportsToPersonId",
             manager.name AS "reportsToName",
             p.state_head_person_id AS "stateHeadPersonId",
             state_head.name AS "stateHeadName"
      FROM person p
      LEFT JOIN person manager ON manager.person_id = p.reports_to_person_id
      LEFT JOIN person state_head ON state_head.person_id = p.state_head_person_id
      WHERE COALESCE(p.is_holding, FALSE) = FALSE
        AND COALESCE(p.is_system_coverage, FALSE) = FALSE
      ORDER BY p.person_id
    `),
  ]);

  return buildPersonRegistryMappingReport(registryResult.rows, peopleResult.rows);
}