import ExcelJS from "exceljs";

export type ExportValue = number | null;

export type PeopleActiveFilter = "active" | "inactive" | "all";

/** The People page uses words; the API list historically uses booleans. */
export function normalisePeopleActiveFilter(value: unknown): PeopleActiveFilter {
  const raw = String(value ?? "all").trim().toLowerCase();
  if (raw === "inactive" || raw === "false") return "inactive";
  if (raw === "all") return "all";
  return "active";
}

export function peopleActiveWhereClause(value: unknown): string {
  const filter = normalisePeopleActiveFilter(value);
  if (filter === "active") return "p.is_active = true AND p.is_holding = false";
  if (filter === "inactive") return "p.is_active = false";
  return "";
}

export type PeopleExportRow = {
  employeeCode: string | null;
  name: string;
  role: string | null;
  stateHead: string | null;
  hq: string | null;
  state: string | null;
  workingState: string | null;
  hrStatus: string | null;
  rosterStatus: string | null;
  dateOfJoining: Date | null;
  email: string | null;
  mobile: string | null;
  conflictFlags: string;
};

export type CoverageExportRow = {
  stateHead: string;
  member: string;
  retailers: ExportValue;
  retailersSource: string;
  visited: ExportValue;
  visitedSource: string;
  notVisited: ExportValue;
  notVisitedSource: string;
  partiesGivingBusiness: ExportValue;
  partiesGivingBusinessSource: string;
  businessAmount: ExportValue;
  businessAmountSource: string;
  businessPerRetailer?: ExportValue;
  businessPerRetailerSource?: string;
  /** Head rows can contain a known subset; this prevents that sum being called complete. */
  states?: Partial<Record<"retailers" | "visited" | "notVisited" | "partiesGivingBusiness" | "businessAmount" | "businessPerRetailer", CoverageValueState>>;
};

export type CoverageValueState = "VALUE" | "ZERO" | "UNKNOWN" | "INCOMPLETE";

export type OperationalCoverageKpis = {
  stateHead: string;
  name: string;
  totalRetailers: number | null;
  visitedRetailers: number | null;
  nonVisitedRetailers: number | null;
  newPartyOrderBooking: number | null;
  businessPerRetailer: number | null;
  hrSfa?: {
    businessReceivedVisits: number | null;
    identityAmbiguous?: boolean;
  } | null;
};

/** Map the exact fields displayed by Sales Deep Dive and join the separate
 * authoritative HR/SFA business-party count when identity is unambiguous. */
export function mapOperationalCoverageKpis(kpi: OperationalCoverageKpis): CoverageExportRow {
  const notVisited = kpi.nonVisitedRetailers != null
    ? kpi.nonVisitedRetailers
    : kpi.totalRetailers != null && kpi.visitedRetailers != null &&
      kpi.totalRetailers >= kpi.visitedRetailers
      ? kpi.totalRetailers - kpi.visitedRetailers
      : null;
  const hrSfaBusiness = kpi.hrSfa?.identityAmbiguous
    ? null
    : kpi.hrSfa?.businessReceivedVisits ?? null;
  const hrSfaBusinessSource = !kpi.hrSfa
    ? "HR/SFA Dashboard — no normalized member match"
    : kpi.hrSfa.identityAmbiguous
      ? "HR/SFA Dashboard — normalized identity ambiguous; value withheld"
      : "HR/SFA Dashboard — businessReceivedVisits (business received parties)";
  return {
    stateHead: kpi.stateHead,
    member: kpi.name,
    retailers: kpi.totalRetailers,
    retailersSource: "STATE HEAD DASHBOARD — Data tab totalRetailers",
    visited: kpi.visitedRetailers,
    visitedSource: "STATE HEAD DASHBOARD — Data tab visitedRetailers",
    notVisited,
    notVisitedSource: kpi.nonVisitedRetailers != null
      ? "STATE HEAD DASHBOARD — Data tab nonVisitedRetailers"
      : "Derived only when totalRetailers and visitedRetailers are known and consistent",
    partiesGivingBusiness: hrSfaBusiness,
    partiesGivingBusinessSource: hrSfaBusinessSource,
    businessAmount: kpi.newPartyOrderBooking,
    businessAmountSource: "STATE HEAD DASHBOARD — Data tab newPartyOrderBooking",
    businessPerRetailer: kpi.businessPerRetailer,
    businessPerRetailerSource: "STATE HEAD DASHBOARD — Data tab businessPerRetailer",
  };
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE8EDF5" },
};
const UNKNOWN_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F3F5" } } as ExcelJS.Fill;
const INR_FORMAT = '₹#,##0;[Red]-₹#,##0';

function styleHeader(ws: ExcelJS.Worksheet): void {
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: "A1", to: `${ws.getColumn(ws.columnCount).letter}1` };
}

function addRows(
  ws: ExcelJS.Worksheet,
  columns: Array<{ header: string; key: string; width: number }>,
  rows: Array<Record<string, unknown>>,
): void {
  ws.columns = columns;
  styleHeader(ws);
  for (const row of rows) {
    const values = columns.map((c) => row[c.key] ?? null);
    ws.addRow(values);
  }
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      if (cell.value === null || cell.value === "") cell.fill = UNKNOWN_FILL;
    });
  });
}

function valueMarker(value: number | null): "VALUE" | "UNKNOWN" | "ZERO" {
  if (value == null) return "UNKNOWN";
  return value === 0 ? "ZERO" : "VALUE";
}

function addInfo(
  wb: ExcelJS.Workbook,
  rows: Array<[string, string]>,
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet("Info");
  ws.columns = [{ width: 30 }, { width: 110 }];
  for (const [key, value] of rows) {
    const row = ws.addRow([key, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return ws;
}

export function buildPeopleWorkbook(input: {
  rows: PeopleExportRow[];
  filters: Record<string, string>;
  source: string;
  generatedAt?: Date;
}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  const people = wb.addWorksheet("People");
  const columns = [
    { header: "Employee Code", key: "employeeCode", width: 16 },
    { header: "Name", key: "name", width: 28 },
    { header: "Role", key: "role", width: 24 },
    { header: "State Head", key: "stateHead", width: 26 },
    { header: "HQ", key: "hq", width: 20 },
    { header: "State", key: "state", width: 20 },
    { header: "Working State", key: "workingState", width: 20 },
    { header: "HR Status", key: "hrStatus", width: 16 },
    { header: "Roster Status", key: "rosterStatus", width: 16 },
    { header: "Date of Joining", key: "dateOfJoining", width: 18 },
    { header: "Email", key: "email", width: 30 },
    { header: "Mobile", key: "mobile", width: 18 },
    { header: "Known Conflict Flags", key: "conflictFlags", width: 70 },
  ];
  addRows(people, columns, input.rows as unknown as Array<Record<string, unknown>>);
  people.getColumn("dateOfJoining").numFmt = "dd-mmm-yyyy";

  const conflicts = wb.addWorksheet("Conflict flags");
  addRows(conflicts, [
    { header: "Register", key: "register", width: 12 },
    { header: "Conflict / population", key: "population", width: 42 },
    { header: "Coverage", key: "coverage", width: 15 },
    { header: "Detail", key: "detail", width: 100 },
  ], [
    { register: "P14", population: "Roster members with no HR record", coverage: "7", detail: "Current roster members are present in the roster/dashboard but have no matching HR record." },
    { register: "P40", population: "Historic names not in roster", coverage: "58", detail: "Historical/off-roll names remain a separate population and are not silently added to the current roster." },
    { register: "P11", population: "Sunil Mohanty", coverage: "No record", detail: "No HR or registry record; retained as an explicit review flag." },
    { register: "P12", population: "Pawan Sharma", coverage: "Conflict", detail: "HR status is Deactive while the roster identifies an active head." },
  ]);

  addInfo(wb, [
    ["Export", "Organisation → People"],
    ["Filters applied", Object.entries(input.filters).map(([k, v]) => `${k}: ${v || "All"}`).join(" · ") || "None"],
    ["People exported", String(input.rows.length)],
    ["Sources", input.source],
    ["Column sources", "Identity/status/hierarchy: person master; role: designation master; HQ/state/working state/DOJ/mobile: HR roster/dashboard roster; email: no connected source held (blank where unavailable)."],
    ["Coverage", "One row per person returned by the active People filters; no page cap is applied to the export."],
    ["Conflict flags", "P14 = 7 current roster members without HR records; P40 = 58 historic names not in roster; P11 = Sunil Mohanty has no record anywhere; P12 = Pawan Sharma HR Deactive vs active head."],
    ["Date coverage", "Date of Joining is written as a true Excel date. Blank means the source did not hold a joining date."],
    ["Provisional months", "Not applicable — People is a current identity/employment snapshot."],
    ["Data-read timestamp", (input.generatedAt ?? new Date()).toISOString()],
  ]);
  return wb;
}

function markerRows(rows: CoverageExportRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    ...row,
    retailersMarker: row.states?.retailers ?? valueMarker(row.retailers),
    visitedMarker: row.states?.visited ?? valueMarker(row.visited),
    notVisitedMarker: row.states?.notVisited ?? valueMarker(row.notVisited),
    partiesGivingBusinessMarker: row.states?.partiesGivingBusiness ?? valueMarker(row.partiesGivingBusiness),
    businessAmountMarker: row.states?.businessAmount ?? valueMarker(row.businessAmount),
    businessPerRetailerMarker: row.states?.businessPerRetailer ?? valueMarker(row.businessPerRetailer ?? null),
  }));
}

const coverageColumns = [
  { header: "State Head", key: "stateHead", width: 28 },
  { header: "Member", key: "member", width: 28 },
  { header: "Retailers", key: "retailers", width: 13 },
  { header: "Retailers state", key: "retailersMarker", width: 16 },
  { header: "Retailers source", key: "retailersSource", width: 52 },
  { header: "Visited", key: "visited", width: 13 },
  { header: "Visited state", key: "visitedMarker", width: 16 },
  { header: "Visited source", key: "visitedSource", width: 52 },
  { header: "Not Visited", key: "notVisited", width: 15 },
  { header: "Not Visited state", key: "notVisitedMarker", width: 19 },
  { header: "Not Visited source", key: "notVisitedSource", width: 58 },
  { header: "Parties Giving Business", key: "partiesGivingBusiness", width: 24 },
  { header: "Business parties state", key: "partiesGivingBusinessMarker", width: 22 },
  { header: "Business parties source", key: "partiesGivingBusinessSource", width: 52 },
  { header: "Business amount", key: "businessAmount", width: 17 },
  { header: "Business amount state", key: "businessAmountMarker", width: 22 },
  { header: "Business amount source", key: "businessAmountSource", width: 52 },
  { header: "Business / retailer", key: "businessPerRetailer", width: 19 },
  { header: "Business / retailer state", key: "businessPerRetailerMarker", width: 23 },
  { header: "Business / retailer source", key: "businessPerRetailerSource", width: 52 },
];

function styleCoverageFigures(ws: ExcelJS.Worksheet): void {
  for (const key of ["retailers", "visited", "notVisited", "partiesGivingBusiness"]) {
    ws.getColumn(key).numFmt = "#,##0";
  }
  ws.getColumn("businessAmount").numFmt = INR_FORMAT;
  ws.getColumn("businessPerRetailer").numFmt = INR_FORMAT;
}

export function buildCoverageReviewWorkbook(input: {
  byHead: CoverageExportRow[];
  byMember: CoverageExportRow[];
  filters: Record<string, string>;
  fy: string;
  period: string;
  sources: string;
  dataReadAt: string | null;
  generatedAt?: Date;
}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  const heads = wb.addWorksheet("By Head");
  addRows(heads, coverageColumns, markerRows(input.byHead));
  styleCoverageFigures(heads);
  const members = wb.addWorksheet("By Member");
  addRows(members, coverageColumns, markerRows(input.byMember));
  styleCoverageFigures(members);
  addInfo(wb, [
    ["Export", "Operational Coverage Review"],
    ["FY", input.fy],
    ["Period", input.period],
    ["Filters applied", Object.entries(input.filters).map(([k, v]) => `${k}: ${v || "All"}`).join(" · ") || "None"],
    ["Head rows", String(input.byHead.length)],
    ["Member rows", String(input.byMember.length)],
    ["Sources", input.sources],
    ["Figure semantics", "VALUE = source returned a positive figure; ZERO = source returned a genuine zero; UNKNOWN = source returned no figure; INCOMPLETE = head sum covers only a known subset of members. UNKNOWN visits are deliberately blank and never converted to zero."],
    ["Coverage", "Retailer/visit figures are the exact Sales Deep Dive Data-tab fields. Parties-giving-business is joined from HR/SFA Dashboard business received parties by normalized member identity; absent or ambiguous identities remain unavailable. Head rows disclose incomplete populations rather than presenting known-subset sums as complete."],
    ["Period semantics", "The selected FY/date filter is carried into this export. The coverage tiles themselves are FY-level Data-tab snapshot fields, so a date filter does not silently turn them into monthly figures."],
    ["Provisional months", "Operational visit data is source-reported and may change while the selected period remains open."],
    ["Data-read timestamp", input.dataReadAt ?? (input.generatedAt ?? new Date()).toISOString()],
  ]);
  return wb;
}

/** Machine-readable workbook evidence used by focused export tests and diagnostics. */
export function workbookSheetEvidence(wb: ExcelJS.Workbook): Array<{ name: string; rows: number }> {
  return wb.worksheets.map((sheet) => ({ name: sheet.name, rows: Math.max(0, sheet.rowCount - 1) }));
}

/** Return Info-sheet key/value evidence without depending on cell coordinates. */
export function infoSheetEvidence(wb: ExcelJS.Workbook): Record<string, string> {
  const info = wb.getWorksheet("Info");
  if (!info) return {};
  const evidence: Record<string, string> = {};
  info.eachRow((row) => {
    const key = String(row.getCell(1).value ?? "");
    if (key) evidence[key] = String(row.getCell(2).value ?? "");
  });
  return evidence;
}