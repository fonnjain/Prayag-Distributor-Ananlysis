import { describe, expect, it } from "vitest";
import {
  buildPersonRegistryMappingReport,
  getPersonRegistryMappingReport,
  type OperationalPerson,
  type RegistryMappingSource,
} from "./personRegistryMappingReport.js";

const people: OperationalPerson[] = [
  {
    personId: 1,
    name: "Amit Kumar",
    employeeCode: "101",
    isActive: true,
    isStateHead: false,
    reportsToPersonId: 9,
    reportsToName: "Sandeep Dadheech",
    stateHeadPersonId: 9,
    stateHeadName: "Sandeep Dadheech",
  },
  {
    personId: 2,
    name: "Ravi Kumar",
    employeeCode: "202",
    isActive: true,
    isStateHead: false,
    reportsToPersonId: 9,
    reportsToName: "Sandeep Dadheech",
    stateHeadPersonId: 9,
    stateHeadName: "Sandeep Dadheech",
  },
  {
    personId: 3,
    name: "Ravi Kumar",
    employeeCode: "203",
    isActive: true,
    isStateHead: false,
    reportsToPersonId: 10,
    reportsToName: "Pawan Kumar Sharma",
    stateHeadPersonId: 10,
    stateHeadName: "Pawan Kumar Sharma",
  },
];

function source(overrides: Partial<RegistryMappingSource> = {}): RegistryMappingSource {
  return {
    id: 100,
    personId: null,
    normKey: "amitkumarsandeepdadheech",
    canonicalName: "Amit Kumar",
    employeeCode: "101",
    codePlausible: true,
    reportingManager: "Sandeep Dadheech",
    stateHead: "Sandeep Dadheech",
    isStateHead: false,
    hrStatus: "Active",
    flagNotes: null,
    ...overrides,
  };
}

describe("person registry mapping report", () => {
  it("labels a unique name and operational-manager agreement as an automatic candidate without linking it", () => {
    const report = buildPersonRegistryMappingReport([source()], people, new Date("2026-08-21T00:00:00Z"));

    expect(report.summary).toMatchObject({
      unmappedRows: 1,
      automaticCandidates: 1,
      reviewQueue: 0,
    });
    expect(report.rows[0]).toMatchObject({
      registryId: 100,
      status: "automatic_candidate",
      employeeCodeEvidence: "matches_candidate",
      reviewRoute: "Sandeep Dadheech",
      managerComparison: { agrees: true },
    });
  });

  it("keeps employee-code-only matches in review", () => {
    const report = buildPersonRegistryMappingReport(
      [source({ canonicalName: "Unknown Name", reportingManager: null, employeeCode: "101" })],
      people,
    );

    expect(report.rows[0]).toMatchObject({
      status: "no_name_candidate",
      employeeCodeEvidence: "matches_other_person",
    });
    expect(report.summary.reviewQueue).toBe(1);
  });

  it("separates HR manager conflicts and routes them by the stated State Head", () => {
    const report = buildPersonRegistryMappingReport(
      [source({ reportingManager: "Pawan Kumar Sharma" })],
      people,
    );

    expect(report.rows[0].status).toBe("manager_conflict");
    expect(report.managerConflicts).toHaveLength(1);
    expect(report.managerConflicts[0]).toMatchObject({
      mappingScope: "unmapped",
      managerComparison: { operationalManager: "Sandeep Dadheech", agrees: false },
    });
    expect(report.routeCounts).toEqual([{ stateHead: "Sandeep Dadheech", count: 1 }]);
  });

  it("compares a linked renamed registry row with its saved People record, not an absent name candidate", () => {
    const report = buildPersonRegistryMappingReport(
      [source({
        personId: 1,
        canonicalName: "Amit Kumar (Former Territory)",
        reportingManager: "Pawan Kumar Sharma",
      })],
      people,
    );

    expect(report.managerConflicts[0]).toMatchObject({
      status: "no_name_candidate",
      candidatePeople: [],
      mappingScope: "linked",
      managerComparison: {
        registryManager: "Pawan Kumar Sharma",
        operationalManager: "Sandeep Dadheech",
        agrees: false,
      },
    });
    expect(report.managerConflicts).toHaveLength(1);
  });

  it("compares an ambiguously named linked row with its saved People record", () => {
    const report = buildPersonRegistryMappingReport(
      [source({
        personId: 1,
        canonicalName: "Ravi Kumar",
        reportingManager: "Pawan Kumar Sharma",
      })],
      people,
    );

    expect(report.managerConflicts[0]).toMatchObject({
      status: "ambiguous_name",
      candidatePeople: [{ personId: 2 }, { personId: 3 }],
      mappingScope: "linked",
      managerComparison: {
        operationalManager: "Sandeep Dadheech",
        agrees: false,
      },
    });
    expect(report.managerConflicts).toHaveLength(1);
  });

  it("fails closed when normalized names map to multiple people", () => {
    const report = buildPersonRegistryMappingReport(
      [source({ canonicalName: "Ravi Kumar", employeeCode: "202" })],
      people,
    );

    expect(report.rows[0]).toMatchObject({
      status: "ambiguous_name",
      candidatePeople: [{ personId: 2 }, { personId: 3 }],
    });
    expect(report.summary.automaticCandidates).toBe(0);
  });

  it("keeps a nonblank employee-code discrepancy in the review queue even when name and manager agree", () => {
    const report = buildPersonRegistryMappingReport(
      [source({ employeeCode: "999" })],
      people,
    );

    expect(report.rows[0]).toMatchObject({
      status: "employee_code_conflict",
      employeeCodeEvidence: "conflicts_with_candidate",
    });
    expect(report.summary).toMatchObject({ automaticCandidates: 0, reviewQueue: 1 });
    expect(report.routeCounts).toEqual([{ stateHead: "Sandeep Dadheech", count: 1 }]);
  });

  it("labels an unknown nonblank employee code as having no People-code match", () => {
    const report = buildPersonRegistryMappingReport(
      [source({ canonicalName: "Unknown Name", reportingManager: null, employeeCode: "999" })],
      people,
    );

    expect(report.rows[0]).toMatchObject({
      status: "no_name_candidate",
      employeeCodeEvidence: "no_people_code_match",
    });
  });

  it("keeps an explicitly unresolved human decision visible without inventing a People link", () => {
    const report = buildPersonRegistryMappingReport(
      [source({
        resolutionDecision: "unresolved",
        resolutionEffectiveDate: "2026-08-21",
        resolutionReason: "HR did not provide enough evidence",
        resolutionChangedBy: "Verified Admin",
        resolutionCreatedAt: "2026-08-21T10:00:00.000Z",
      })],
      people,
    );

    expect(report.rows[0].resolution).toEqual({
      decision: "unresolved",
      effectiveDate: "2026-08-21",
      reason: "HR did not provide enough evidence",
      changedBy: "Verified Admin",
      createdAt: "2026-08-21T10:00:00.000Z",
    });
    expect(report.rows[0].candidatePeople).toHaveLength(1);
  });

  it("only issues SELECT statements through the report loader", async () => {
    const queries: string[] = [];
    const report = await getPersonRegistryMappingReport({
      query: async <T,>(sql: string) => {
        queries.push(sql);
        const rows = sql.includes("FROM person_registry") ? [source()] : people;
        return { rows: rows as T[] };
      },
    });

    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => sql.trim().toUpperCase().startsWith("SELECT"))).toBe(true);
    expect(report.summary.automaticCandidates).toBe(1);
  });
});