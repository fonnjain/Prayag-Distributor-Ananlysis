/**
 * Read-only comparison of the current State Head transaction pack against the
 * application's derived person_state_coverage and sale_line attribution.
 */
import { pool } from "@workspace/db";
import { headAliasLookup, loadPersonRegistry } from "./lib/personRegistry.js";
import { getGoogleAccessToken, readTabRowsChunked } from "./lib/registers/sheetsApi.js";
import { fiscalMonthIndex, normParty } from "./lib/mgmt/names.js";
import { mgmtSources } from "./lib/mgmt/roster.js";
import { normaliseStateCanon } from "./lib/stateCanon.js";

type Cell = string | number | boolean | null;
type DriveFile = { id: string; name: string };
type Pair = { rows: number; net: number };
type PartyAttribution = {
  party: string;
  cities: Set<string>;
  heads: Map<string, Pair>;
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
const STATE = 10;
const HEAD = 11;
const PARTY = 2;
const CITY = 9;
const AMOUNT = 7;
const DATE = [1, 4];
const FY_LABEL = [13, 14];
const INSTITUTIONAL = new Set(["PROJECT", "OTHER"]);
// Current-pack spellings that are geographic sub-territories, not distinct
// states. This is deliberately local to the read-only comparison; it does not
// alter State Head coverage or sale_line data.
const PACK_STATE_VARIANTS: Record<string, string> = {
  "MAHARASTRA L": "MAHARASHTRA",
  "MAHARASTRA R": "MAHARASHTRA",
  "MAHARASTRA S": "MAHARASHTRA",
  TAMILNADU: "TAMIL NADU",
};

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

function isoDate(date: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(date) * 86_400_000)
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

async function main(): Promise<void> {
  await loadPersonRegistry();
  const files = await listFiles(mgmtSources().state_head_registers.folderId);
  const packPairs = new Map<string, Pair>();
  const packParties = new Map<string, Map<string, PartyAttribution>>();
  const fileTotals = new Map<string, Pair>();
  const selectionAudit = {
    fyLabel: { rows: 0, net: 0 },
    rawDate: { rows: 0, net: 0 },
    both: { rows: 0, net: 0 },
    labelOnly: { rows: 0, net: 0 },
    dateOnly: { rows: 0, net: 0 },
  };
  let futureRows = 0;
  let futureNet = 0;
  const futureRowDetails: Array<{
    file: string;
    invoice: string;
    party: string;
    rawHead: string;
    fyLabel: string;
    transactionDate: string;
    net: number;
  }> = [];
  const nowSerial = Math.floor((Date.now() - Date.UTC(1899, 11, 30)) / 86_400_000);

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      const rowsForFy: Array<{ row: Cell[]; net: number; date: number | null }> = [];
      await readTabRowsChunked(file.id, "Sheet1", (chunk) => {
        for (const candidate of chunk) {
          if (!candidate) continue;
          const row = candidate as Cell[];
          const net = amount(row[AMOUNT]);
          const date = serial(row);
          const labelSelected = fyLabel(row) === FY;
          const dateSelected =
            date != null && fiscalMonthIndex(Math.round(date), FY) != null;
          if (net != null && labelSelected) {
            selectionAudit.fyLabel.rows++;
            selectionAudit.fyLabel.net += net;
          }
          if (net != null && dateSelected) {
            selectionAudit.rawDate.rows++;
            selectionAudit.rawDate.net += net;
          }
          if (net != null && labelSelected && dateSelected) {
            selectionAudit.both.rows++;
            selectionAudit.both.net += net;
          } else if (net != null && labelSelected) {
            selectionAudit.labelOnly.rows++;
            selectionAudit.labelOnly.net += net;
          } else if (net != null && dateSelected) {
            selectionAudit.dateOnly.rows++;
            selectionAudit.dateOnly.net += net;
          }
          if (net == null || !labelSelected) continue;
          rowsForFy.push({ row, net, date });
        }
      });

      const dominantHeads = new Map<string, number>();
      for (const { row } of rowsForFy) {
        const raw = String(row[HEAD] ?? "").trim();
        if (raw) dominantHeads.set(raw, (dominantHeads.get(raw) ?? 0) + 1);
      }
      const dominantRaw = [...dominantHeads.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      for (const { row, net, date } of rowsForFy) {
        const head = canonicalHead(String(row[HEAD] ?? "").trim() || dominantRaw);
        const state = canonicalState(row[STATE]);
        const pairKey = `${head}\u0000${state}`;
        addPair(packPairs, pairKey, net);
        addPair(fileTotals, file.name, net);
        if (date != null && date > nowSerial) {
          futureRows++;
          futureNet += net;
          futureRowDetails.push({
            file: file.name,
            invoice: String(row[0] ?? "").trim(),
            party: String(row[PARTY] ?? "").trim(),
            rawHead: String(row[HEAD] ?? "").trim(),
            fyLabel: FY,
            transactionDate: isoDate(date),
            net,
          });
        }
        if (!MULTI_HEAD_STATES.has(state)) continue;
        const party = String(row[PARTY] ?? "").trim();
        const partyKey = normParty(party);
        if (!partyKey) continue;
        const byParty = packParties.get(state) ?? new Map<string, PartyAttribution>();
        const partyEntry = byParty.get(partyKey) ?? {
          party,
          cities: new Set<string>(),
          heads: new Map<string, Pair>(),
        };
        const city = String(row[CITY] ?? "").trim();
        if (city) partyEntry.cities.add(city);
        addPair(partyEntry.heads, head, net);
        byParty.set(partyKey, partyEntry);
        packParties.set(state, byParty);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));

  const [coverageResult, registerResult, institutionalResult] = await Promise.all([
    pool.query<{ head: string; state: string; coverage_rows: string; customer_count: string; net: string }>(`
      SELECT h.name AS head, c.state_canon AS state, COUNT(*)::text AS coverage_rows,
             COALESCE(SUM(c.evidence_customer_count), 0)::text AS customer_count,
             COALESCE(SUM(c.evidence_net_amount), 0)::text AS net
      FROM person_state_coverage c
      JOIN person h ON h.person_id = c.state_head_person_id
      WHERE c.fiscal_year = $1 AND c.source = 'derived_register' AND c.voided_at IS NULL
      GROUP BY h.name, c.state_canon
      ORDER BY h.name, c.state_canon
    `, [FY]),
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
        AND (head_canon ILIKE '%non-territory%' OR head_canon ILIKE '%project%' OR head_canon ILIKE '%other%')
      GROUP BY head_canon
      ORDER BY head_canon NULLS FIRST
    `, [FY]),
  ]);

  const coveragePairs = new Map<string, { coverageRows: number; customers: number; net: number }>();
  for (const row of coverageResult.rows) {
    coveragePairs.set(`${canonicalHead(row.head)}\u0000${canonicalState(row.state)}`, {
      coverageRows: Number(row.coverage_rows),
      customers: Number(row.customer_count),
      net: Number(row.net),
    });
  }
  const pairKeys = new Set([...packPairs.keys(), ...coveragePairs.keys()]);
  const pairComparison = [...pairKeys].map((key) => {
    const [head, state] = key.split("\u0000");
    const pack = packPairs.get(key);
    const coverage = coveragePairs.get(key);
    return {
      head,
      state,
      packRows: pack?.rows ?? 0,
      packNet: pack?.net ?? 0,
      coverageRows: coverage?.coverageRows ?? 0,
      coverageCustomers: coverage?.customers ?? 0,
      coverageNet: coverage?.net ?? 0,
      present: pack && coverage ? "both" : pack ? "pack-only" : "coverage-only",
    };
  }).sort((a, b) => a.state.localeCompare(b.state) || a.head.localeCompare(b.head));

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

  const multiHeadComparison = [...MULTI_HEAD_STATES].sort().map((state) => {
    const pack = packParties.get(state) ?? new Map<string, PartyAttribution>();
    const register = registerParties.get(state) ?? new Map<string, Map<string, number>>();
    const partyKeys = new Set([...pack.keys(), ...register.keys()]);
    const disagreements = [...partyKeys].flatMap((partyKey) => {
      const packParty = pack.get(partyKey);
      const registerHeads = register.get(partyKey);
      const packHeads = packParty ? [...packParty.heads.keys()].sort() : [];
      const dbHeads = registerHeads ? [...registerHeads.keys()].sort() : [];
      if (packHeads.join("\u0000") === dbHeads.join("\u0000")) return [];
      return [{
        party: packParty?.party ?? partyKey,
        cities: [...(packParty?.cities ?? [])].sort(),
        packHeads,
        registerHeads: dbHeads,
        packNet: [...(packParty?.heads.values() ?? [])].reduce((sum, item) => sum + item.net, 0),
        registerNet: [...(registerHeads?.values() ?? [])].reduce((sum, item) => sum + item, 0),
      }];
    }).sort((a, b) => b.packNet - a.packNet);
    return {
      state,
      packPartyCount: pack.size,
      registerPartyCount: register.size,
      agreementCount: partyKeys.size - disagreements.length,
      disagreementCount: disagreements.length,
      disagreements,
    };
  });

  const institutions = [...packPairs.entries()]
    .filter(([key]) => INSTITUTIONAL.has(key.split("\u0000")[0]))
    .map(([key, value]) => {
      const [head, state] = key.split("\u0000");
      return { head, state, rows: value.rows, net: value.net };
    })
    .sort((a, b) => a.head.localeCompare(b.head) || a.state.localeCompare(b.state));
  const departed = ["Babu", "Suresh Nair"].map((head) => {
    const matches = [...packPairs.entries()]
      .filter(([key]) => key.split("\u0000")[0] === head)
      .map(([key, value]) => ({ state: key.split("\u0000")[1], ...value }));
    return {
      head,
      rows: matches.reduce((sum, value) => sum + value.rows, 0),
      net: matches.reduce((sum, value) => sum + value.net, 0),
      byState: matches,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    fy: FY,
    packFiles: files.length,
    selectionAudit,
    futureRows: { rows: futureRows, net: futureNet, details: futureRowDetails },
    pairComparison,
    multiHeadComparison,
    institutionalPack: institutions,
    registerInstitutionalBucket: institutionalResult.rows.map((row) => ({
      head: row.head ?? "__UNASSIGNED__",
      rows: Number(row.rows),
      net: Number(row.net),
    })),
    departed,
    fileTotals: [...fileTotals.entries()]
      .map(([file, value]) => ({ file, ...value }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  };
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });