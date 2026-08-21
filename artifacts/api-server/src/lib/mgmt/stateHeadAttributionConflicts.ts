/**
 * Read-only evidence for State Head workbook attribution conflicts.
 *
 * This does not alter workbook data, register attribution, aliases, people, or
 * coverage. The FY label selects the workbook population; raw transaction dates
 * are retained as quality evidence only.
 */
import { pool } from "@workspace/db";
import { headAliasLookup, loadPersonRegistry } from "../personRegistry.js";
import { getGoogleAccessToken, readTabRowsChunked } from "../registers/sheetsApi.js";
import { fiscalMonthIndex, normParty } from "./names.js";
import { mgmtSources } from "./roster.js";
import { normaliseStateCanon } from "../stateCanon.js";

type Cell = string | number | boolean | null;
type DriveFile = { id: string; name: string };
type Pair = { rows: number; net: number };

type PackLine = {
  file: string;
  rowNumber: number;
  invoice: string;
  party: string;
  city: string;
  rawHead: string;
  head: string;
  state: string;
  fy: string;
  transactionDate: string | null;
  dateSerial: number | null;
  net: number;
};

type PartyAttribution = {
  party: string;
  cities: Set<string>;
  heads: Map<string, Pair>;
};

type EvidenceLine = Pick<PackLine, "file" | "rowNumber" | "head" | "invoice" | "transactionDate" | "net">;

type CrossHeadComparison = {
  leftHead: string;
  rightHead: string;
  leftRows: number;
  rightRows: number;
  leftNet: number;
  rightNet: number;
  sameInvoiceAmountRows: number;
  sameInvoiceAmountNet: number;
  sameInvoiceDateAmountRows: number;
  dateMismatchedRows: number;
  unmatchedLeft: EvidenceLine[];
  unmatchedRight: EvidenceLine[];
  matchedRows: Array<{ left: EvidenceLine; right: EvidenceLine; datesMatch: boolean }>;
  classification: "full cross-head financial duplicate" | "partial cross-head financial duplicate" | "no same-invoice amount match";
};

export type StateHeadAttributionConflictReport = {
  generatedAt: string;
  readOnly: true;
  fy: string;
  basis: {
    selection: "FY label";
    detail: string;
    rawDates: string;
  };
  selectionAudit: {
    fyLabelRows: number;
    fyLabelNet: number;
    rawDateRows: number;
    rawDateNet: number;
    bothRows: number;
    labelOnlyRows: number;
    dateOnlyRows: number;
  };
  validationStates: Array<{
    state: string;
    packCustomers: number;
    registerCustomers: number;
    agreementCount: number;
    disagreementCount: number;
    status: "matched" | "conflicts";
  }>;
  conflicts: Array<{
    state: string;
    customer: string;
    cities: string[];
    workbookHeads: Array<Pair & { head: string }>;
    derivedRegisterHeads: Array<{ head: string; net: number }>;
    workbookRows: number;
    workbookNet: number;
    registerNet: number;
    departedWorkbookHeads: string[];
    packToRegisterRatio: number | null;
    crossHeadComparisons: CrossHeadComparison[];
  }>;
  departedReview: Array<{
    head: string;
    workbookRows: number;
    workbookNet: number;
    linkedConflictCount: number;
    linkedCustomers: Array<{ customer: string; state: string; workbookNet: number }>;
    decisionPrompt: string;
  }>;
  duplicateSourceLines: Array<{
    invoice: string;
    party: string;
    workbookHead: string;
    transactionDate: string | null;
    net: number;
    occurrences: number;
    files: string[];
    sourceLines: string[];
    futureDated: boolean;
    finding: string;
  }>;
  futureRows: Array<{
    file: string;
    sourceLine: string;
    invoice: string;
    party: string;
    workbookHead: string;
    transactionDate: string;
    net: number;
    duplicateOccurrences: number;
    finding: string;
  }>;
  institutionalConflict: Array<{
    bucket: "PROJECT / OTHER";
    workbookRows: number;
    workbookNet: number;
    registerRows: number;
    registerNet: number;
    netGap: number;
    comparisonNote: string;
    workbookBreakdown: Array<Pair & { head: string }>;
    registerBreakdown: Array<Pair & { head: string }>;
    exception: string;
  }>;
  coverageScope: {
    scope: string;
    packPairCount: number;
    coveragePairCount: number;
    packOnlyPairCount: number;
    packOnlyNet: number;
    topPackOnlyPairs: Array<{ head: string; state: string; rows: number; net: number }>;
  };
};

const FY = "2026-27";
const MULTI_HEAD_STATES = new Set([
  "MAHARASHTRA",
  "ANDHRA PRADESH",
  "HIMACHAL PRADESH",
  "PUNJAB",
  "TELANGANA",
  "TAMIL NADU",
]);
const DEPARTED_HEADS = new Set(["Babu", "Suresh Nair"]);
const INSTITUTIONAL = new Set(["PROJECT", "OTHER"]);
const STATE = 10;
const HEAD = 11;
const PARTY = 2;
const CITY = 9;
const AMOUNT = 7;
const DATE = [1, 4];
const FY_LABEL = [13, 14];
const CACHE_TTL_MS = 5 * 60_000;

const PACK_STATE_VARIANTS: Record<string, string> = {
  "MAHARASTRA L": "MAHARASHTRA",
  "MAHARASTRA R": "MAHARASHTRA",
  "MAHARASTRA S": "MAHARASHTRA",
  TAMILNADU: "TAMIL NADU",
};

let cache: { report: StateHeadAttributionConflictReport; until: number } | null = null;
let inFlight: Promise<StateHeadAttributionConflictReport> | null = null;

function amount(value: Cell | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serial(row: Cell[]): number | null {
  for (const index of DATE) {
    const value = row[index];
    if (typeof value === "number" && value > 20_000 && value < 80_000) return value;
  }
  return null;
}

function fyLabel(row: Cell[]): string | null {
  for (const index of FY_LABEL) {
    const match = /(\d{4})\s*-\s*(\d{2})\s*$/.exec(String(row[index] ?? "").trim());
    if (!match || Number(match[1]) + 1 !== 2000 + Number(match[2])) continue;
    return `${match[1]}-${match[2]}`;
  }
  return null;
}

function isoDate(value: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function canonicalHead(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "__BLANK__";
  return headAliasLookup.get(value.toUpperCase()) ?? `__UNRESOLVED__:${value}`;
}

function canonicalState(raw: unknown): string {
  const value = String(raw ?? "").trim().toUpperCase();
  const canonical = PACK_STATE_VARIANTS[value] ?? normaliseStateCanon(value) ?? value;
  return canonical || "__BLANK__";
}

function addPair(map: Map<string, Pair>, key: string, net: number): void {
  const current = map.get(key) ?? { rows: 0, net: 0 };
  current.rows++;
  current.net += net;
  map.set(key, current);
}

function duplicateIdentity(line: PackLine): string {
  return [
    line.invoice.toUpperCase(),
    normParty(line.party),
    line.rawHead.toUpperCase(),
    line.transactionDate ?? "UNDATED",
    line.net.toFixed(2),
  ].join("\u0000");
}

function crossHeadFinancialIdentity(line: PackLine): string {
  return [
    line.invoice.toUpperCase(),
    normParty(line.party),
    line.net.toFixed(2),
  ].join("\u0000");
}

function toEvidenceLine(line: PackLine): EvidenceLine {
  return {
    file: line.file,
    rowNumber: line.rowNumber,
    head: line.head,
    invoice: line.invoice,
    transactionDate: line.transactionDate,
    net: line.net,
  };
}

function compareCrossHeadRows(lines: PackLine[]): CrossHeadComparison[] {
  const byHead = new Map<string, PackLine[]>();
  for (const line of lines) {
    const group = byHead.get(line.head) ?? [];
    group.push(line);
    byHead.set(line.head, group);
  }
  const heads = [...byHead.keys()].sort((a, b) => a.localeCompare(b));
  const comparisons: CrossHeadComparison[] = [];

  for (let leftIndex = 0; leftIndex < heads.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < heads.length; rightIndex++) {
      const leftLines = byHead.get(heads[leftIndex]) ?? [];
      const rightLines = byHead.get(heads[rightIndex]) ?? [];
      const rightByIdentity = new Map<string, PackLine[]>();
      for (const line of rightLines) {
        const key = crossHeadFinancialIdentity(line);
        const group = rightByIdentity.get(key) ?? [];
        group.push(line);
        rightByIdentity.set(key, group);
      }

      const matchedRows: Array<{ left: EvidenceLine; right: EvidenceLine; datesMatch: boolean }> = [];
      const unmatchedLeft: EvidenceLine[] = [];
      for (const left of leftLines) {
        const candidates = rightByIdentity.get(crossHeadFinancialIdentity(left));
        const right = candidates?.shift();
        if (right) {
          matchedRows.push({
            left: toEvidenceLine(left),
            right: toEvidenceLine(right),
            datesMatch: left.transactionDate === right.transactionDate,
          });
        }
        else unmatchedLeft.push(toEvidenceLine(left));
      }
      const unmatchedRight = [...rightByIdentity.values()]
        .flat()
        .map(toEvidenceLine);
      const sameInvoiceAmountNet = matchedRows.reduce((sum, match) => sum + match.left.net, 0);
      const sameInvoiceAmountRows = matchedRows.length;
      const sameInvoiceDateAmountRows = matchedRows.filter((match) => match.datesMatch).length;

      comparisons.push({
        leftHead: heads[leftIndex],
        rightHead: heads[rightIndex],
        leftRows: leftLines.length,
        rightRows: rightLines.length,
        leftNet: leftLines.reduce((sum, line) => sum + line.net, 0),
        rightNet: rightLines.reduce((sum, line) => sum + line.net, 0),
        sameInvoiceAmountRows,
        sameInvoiceAmountNet,
        sameInvoiceDateAmountRows,
        dateMismatchedRows: sameInvoiceAmountRows - sameInvoiceDateAmountRows,
        unmatchedLeft,
        unmatchedRight,
        matchedRows,
        classification:
          sameInvoiceAmountRows === 0
            ? "no same-invoice amount match"
            : unmatchedLeft.length === 0 && unmatchedRight.length === 0
              ? "full cross-head financial duplicate"
              : "partial cross-head financial duplicate",
      });
    }
  }
  return comparisons;
}

async function listFiles(folderId: string): Promise<DriveFile[]> {
  const token = await getGoogleAccessToken();
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
  );
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Drive listing failed (${response.status}).`);
  const body = (await response.json()) as { files?: DriveFile[] };
  return (body.files ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadStateHeadAttributionConflicts(): Promise<StateHeadAttributionConflictReport> {
  if (cache && Date.now() < cache.until) return cache.report;
  if (inFlight) return inFlight;
  inFlight = buildReport()
    .then((report) => {
      cache = { report, until: Date.now() + CACHE_TTL_MS };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidateStateHeadAttributionConflictsCache(): void {
  cache = null;
}

async function buildReport(): Promise<StateHeadAttributionConflictReport> {
  await loadPersonRegistry();
  const files = await listFiles(mgmtSources().state_head_registers.folderId);
  const packPairs = new Map<string, Pair>();
  const packParties = new Map<string, Map<string, PartyAttribution>>();
  const lines: PackLine[] = [];
  const selectionAudit = {
    fyLabelRows: 0,
    fyLabelNet: 0,
    rawDateRows: 0,
    rawDateNet: 0,
    bothRows: 0,
    labelOnlyRows: 0,
    dateOnlyRows: 0,
  };
  const nowSerial = Math.floor((Date.now() - Date.UTC(1899, 11, 30)) / 86_400_000);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      const rowsForFy: Array<{ row: Cell[]; net: number; date: number | null; rowNumber: number }> = [];
      await readTabRowsChunked(file.id, "Sheet1", (chunk, startRowNumber) => {
        for (const [chunkIndex, candidate] of chunk.entries()) {
          const rowNumber = startRowNumber + chunkIndex;
          if (!candidate) continue;
          const row = candidate as Cell[];
          const net = amount(row[AMOUNT]);
          const date = serial(row);
          const labelSelected = fyLabel(row) === FY;
          const dateSelected = date != null && fiscalMonthIndex(Math.round(date), FY) != null;
          if (net != null && labelSelected) {
            selectionAudit.fyLabelRows++;
            selectionAudit.fyLabelNet += net;
          }
          if (net != null && dateSelected) {
            selectionAudit.rawDateRows++;
            selectionAudit.rawDateNet += net;
          }
          if (net != null && labelSelected && dateSelected) selectionAudit.bothRows++;
          else if (net != null && labelSelected) selectionAudit.labelOnlyRows++;
          else if (net != null && dateSelected) selectionAudit.dateOnlyRows++;
          if (net != null && labelSelected) rowsForFy.push({ row, net, date, rowNumber });
        }
      });

      const dominantHeads = new Map<string, number>();
      for (const { row } of rowsForFy) {
        const raw = String(row[HEAD] ?? "").trim();
        if (raw) dominantHeads.set(raw, (dominantHeads.get(raw) ?? 0) + 1);
      }
      const dominantRaw = [...dominantHeads.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

      for (const { row, net, date, rowNumber: sourceRow } of rowsForFy) {
        const rawHead = String(row[HEAD] ?? "").trim() || dominantRaw;
        const head = canonicalHead(rawHead);
        const state = canonicalState(row[STATE]);
        const party = String(row[PARTY] ?? "").trim();
        const city = String(row[CITY] ?? "").trim();
        const line: PackLine = {
          file: file.name,
          rowNumber: sourceRow,
          invoice: String(row[0] ?? "").trim(),
          party,
          city,
          rawHead,
          head,
          state,
          fy: FY,
          transactionDate: date == null ? null : isoDate(date),
          dateSerial: date,
          net,
        };
        lines.push(line);
        addPair(packPairs, `${head}\u0000${state}`, net);
        if (!MULTI_HEAD_STATES.has(state)) continue;
        const partyKey = normParty(party);
        if (!partyKey) continue;
        const byParty = packParties.get(state) ?? new Map<string, PartyAttribution>();
        const partyEntry = byParty.get(partyKey) ?? {
          party,
          cities: new Set<string>(),
          heads: new Map<string, Pair>(),
        };
        if (city) partyEntry.cities.add(city);
        addPair(partyEntry.heads, head, net);
        byParty.set(partyKey, partyEntry);
        packParties.set(state, byParty);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));

  const [registerResult, institutionalResult, coverageResult] = await Promise.all([
    pool.query<{ state: string; customer: string; head: string | null; net: string }>(`
      SELECT state_canon AS state, customer, head_canon AS head, SUM(amount)::text AS net
      FROM sale_line_current
      WHERE version_status = 'current' AND fy = $1
      GROUP BY state_canon, customer, head_canon
    `, [FY]),
    pool.query<{ head: string | null; rows: string; net: string }>(`
      SELECT head_canon AS head, COUNT(*)::text AS rows, SUM(amount)::text AS net
      FROM sale_line_current
      WHERE version_status = 'current' AND fy = $1
        AND (
          head_canon ILIKE '%non-territory%'
          OR head_canon ILIKE '%project%'
          OR head_canon ILIKE '%other%'
          OR head_canon ILIKE '%hitesh%'
        )
      GROUP BY head_canon
      ORDER BY head_canon NULLS FIRST
    `, [FY]),
    pool.query<{ head: string; state: string; rows: string; net: string }>(`
      SELECT p.name AS head,
             c.state_canon AS state,
             COUNT(*)::text AS rows,
             COALESCE(SUM(c.evidence_net_amount), 0)::text AS net
      FROM person_state_coverage c
      JOIN person p ON p.person_id = c.state_head_person_id
      WHERE c.fiscal_year = $1
        AND c.source = 'derived_register'
        AND c.voided_at IS NULL
      GROUP BY p.name, c.state_canon
    `, [FY]),
  ]);

  const registerParties = new Map<string, Map<string, Map<string, number>>>();
  for (const row of registerResult.rows) {
    const state = canonicalState(row.state);
    if (!MULTI_HEAD_STATES.has(state)) continue;
    const partyKey = normParty(row.customer);
    if (!partyKey) continue;
    const byParty = registerParties.get(state) ?? new Map<string, Map<string, number>>();
    const heads = byParty.get(partyKey) ?? new Map<string, number>();
    const head = row.head ? canonicalHead(row.head) : "__UNASSIGNED__";
    heads.set(head, (heads.get(head) ?? 0) + Number(row.net));
    byParty.set(partyKey, heads);
    registerParties.set(state, byParty);
  }

  const validationStates: StateHeadAttributionConflictReport["validationStates"] = [];
  const conflicts: StateHeadAttributionConflictReport["conflicts"] = [];
  for (const state of [...MULTI_HEAD_STATES].sort()) {
    const pack = packParties.get(state) ?? new Map<string, PartyAttribution>();
    const register = registerParties.get(state) ?? new Map<string, Map<string, number>>();
    const partyKeys = new Set([...pack.keys(), ...register.keys()]);
    let disagreementCount = 0;
    for (const partyKey of partyKeys) {
      const packParty = pack.get(partyKey);
      const registerHeads = register.get(partyKey);
      const workbookHeads = [...(packParty?.heads ?? new Map<string, Pair>()).entries()]
        .map(([head, pair]) => ({ head, ...pair }))
        .sort((a, b) => a.head.localeCompare(b.head));
      const derivedRegisterHeads = [...(registerHeads ?? new Map<string, number>()).entries()]
        .map(([head, net]) => ({ head, net }))
        .sort((a, b) => a.head.localeCompare(b.head));
      if (
        workbookHeads.map((item) => item.head).join("\u0000") ===
        derivedRegisterHeads.map((item) => item.head).join("\u0000")
      ) continue;
      disagreementCount++;
      const customerLines = lines.filter(
        (line) => line.state === state && normParty(line.party) === partyKey,
      );
      const workbookNet = workbookHeads.reduce((sum, item) => sum + item.net, 0);
      const registerNet = derivedRegisterHeads.reduce((sum, item) => sum + item.net, 0);
      conflicts.push({
        state,
        customer: packParty?.party ?? partyKey,
        cities: [...(packParty?.cities ?? [])].sort(),
        workbookHeads,
        derivedRegisterHeads,
        workbookRows: workbookHeads.reduce((sum, item) => sum + item.rows, 0),
        workbookNet,
        registerNet,
        departedWorkbookHeads: workbookHeads
          .map((item) => item.head)
          .filter((head) => DEPARTED_HEADS.has(head)),
        packToRegisterRatio: registerNet > 0 ? workbookNet / registerNet : null,
        crossHeadComparisons: compareCrossHeadRows(customerLines),
      });
    }
    validationStates.push({
      state,
      packCustomers: pack.size,
      registerCustomers: register.size,
      agreementCount: partyKeys.size - disagreementCount,
      disagreementCount,
      status: disagreementCount === 0 ? "matched" : "conflicts",
    });
  }
  conflicts.sort((a, b) => b.workbookNet - a.workbookNet || a.customer.localeCompare(b.customer));

  const duplicateGroups = new Map<string, PackLine[]>();
  for (const line of lines) {
    if (!line.invoice) continue;
    const key = duplicateIdentity(line);
    const group = duplicateGroups.get(key) ?? [];
    group.push(line);
    duplicateGroups.set(key, group);
  }
  const duplicateGroupForLine = new Map<PackLine, PackLine[]>();
  const duplicateSourceLines = [...duplicateGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      for (const line of group) duplicateGroupForLine.set(line, group);
      const first = group[0];
      const futureDated = group.some((line) => line.dateSerial != null && line.dateSerial > nowSerial);
      return {
        invoice: first.invoice,
        party: first.party,
        workbookHead: first.head,
        transactionDate: first.transactionDate,
        net: first.net,
        occurrences: group.length,
        files: [...new Set(group.map((line) => line.file))].sort(),
        sourceLines: group.map((line) => `${line.file}:${line.rowNumber}`).sort(),
        futureDated,
        finding: futureDated
          ? "Identical future-dated source line repeated; treat as one source-duplication finding, not separate transactions."
          : "Identical source line repeated in the workbook pack; review source duplication before relying on row counts.",
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences || b.net - a.net);

  const futureRows = lines
    .filter((line) => line.dateSerial != null && line.dateSerial > nowSerial)
    .map((line) => ({
      file: line.file,
      sourceLine: `${line.file}:${line.rowNumber}`,
      invoice: line.invoice,
      party: line.party,
      workbookHead: line.head,
      transactionDate: line.transactionDate ?? "",
      net: line.net,
      duplicateOccurrences: duplicateGroupForLine.get(line)?.length ?? 1,
      finding: (duplicateGroupForLine.get(line)?.length ?? 1) > 1
        ? "This future-dated line belongs to an identical duplicate group."
        : "Future-dated source line retained as audit evidence; FY label still selects the workbook population.",
    }))
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.sourceLine.localeCompare(b.sourceLine));

  const departedReview = [...DEPARTED_HEADS].map((head) => {
    const workbookLines = lines.filter((line) => line.head === head);
    const linkedCustomers = conflicts
      .filter((conflict) => conflict.departedWorkbookHeads.includes(head))
      .map((conflict) => ({
        customer: conflict.customer,
        state: conflict.state,
        workbookNet: conflict.workbookHeads
          .filter((item) => item.head === head)
          .reduce((sum, item) => sum + item.net, 0),
      }))
      .sort((a, b) => b.workbookNet - a.workbookNet);
    return {
      head,
      workbookRows: workbookLines.length,
      workbookNet: workbookLines.reduce((sum, line) => sum + line.net, 0),
      linkedConflictCount: linkedCustomers.length,
      linkedCustomers,
      decisionPrompt:
        "Is business still being booked under Babu and Suresh Nair, both departed, or is the pack carrying stale attribution?",
    };
  });

  const workbookInstitutional = new Map<string, Pair>();
  for (const line of lines) {
    if (!INSTITUTIONAL.has(line.state)) continue;
    addPair(workbookInstitutional, `${line.state} / ${line.head}`, line.net);
  }
  const workbookBreakdown = [...workbookInstitutional.entries()]
    .map(([head, pair]) => ({ head, ...pair }))
    .sort((a, b) => a.head.localeCompare(b.head));
  const registerBreakdown = institutionalResult.rows.map((row) => ({
    head: row.head ?? "__UNASSIGNED__",
    rows: Number(row.rows),
    net: Number(row.net),
  }));
  const workbookRows = workbookBreakdown.reduce((sum, item) => sum + item.rows, 0);
  const workbookNet = workbookBreakdown.reduce((sum, item) => sum + item.net, 0);
  const registerRows = registerBreakdown.reduce((sum, item) => sum + item.rows, 0);
  const registerNet = registerBreakdown.reduce((sum, item) => sum + item.net, 0);
  const coveragePairs = new Set(
    coverageResult.rows.map((row) => `${canonicalHead(row.head)}\u0000${canonicalState(row.state)}`),
  );
  const packOnlyPairs = [...packPairs.entries()]
    .filter(([key]) => !coveragePairs.has(key))
    .map(([key, pair]) => {
      const [head, state] = key.split("\u0000");
      return { head, state, ...pair };
    })
    .sort((a, b) => b.net - a.net || a.state.localeCompare(b.state));

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    fy: FY,
    basis: {
      selection: "FY label",
      detail: "Workbook rows are selected when their FY label is 2026-27.",
      rawDates: "Raw transaction dates are audit evidence for mismatches, future dates, and undated rows; they do not exclude FY-labelled rows.",
    },
    selectionAudit,
    validationStates,
    conflicts,
    departedReview,
    duplicateSourceLines,
    futureRows,
    institutionalConflict: [{
      bucket: "PROJECT / OTHER",
      workbookRows,
      workbookNet,
      registerRows,
      registerNet,
      netGap: registerNet - workbookNet,
      comparisonNote:
        "The register side is deliberately broader: it contains non-territory, project, government, and related unowned labels. Its gap is a review signal, not a direct one-to-one reconciliation.",
      workbookBreakdown,
      registerBreakdown,
      exception: "OTHER / HITESH remains visible as an exception and is not assigned automatically.",
    }],
    coverageScope: {
      scope:
        "person_state_coverage is intentionally derived only for declared multi-head areas (AP, Himachal Pradesh, Maharashtra, Punjab, Tamil Nadu, and Telangana). “Pack only” means this coverage view does not model that head/state pair; it is not evidence of a missing customer assignment.",
      packPairCount: packPairs.size,
      coveragePairCount: coveragePairs.size,
      packOnlyPairCount: packOnlyPairs.length,
      packOnlyNet: packOnlyPairs.reduce((sum, pair) => sum + pair.net, 0),
      topPackOnlyPairs: packOnlyPairs.slice(0, 8),
    },
  };
}