// Roster spine for the management report: one row per team member, rolled up
// to a State Head.
//
// Source priority:
//   1. hr_roster.csv  — User_List.csv from the HR SFA system (35 columns:
//      emp code, designation, DOJ, CTC, active/deactive status, lat/lng …).
//      Copied to config/hr_roster.csv at each HR data refresh.
//   2. Team Member Details.xlsx  — older Drive workbook (7 columns, identity
//      only). Used only when the CSV is absent.
//   3. STATE HEAD DASHBOARD Data tab  — live Sheets fallback when both HR
//      files are unavailable.
import mgmtSourcesJson from "../../../config/mgmt_sources.json";
import { logger } from "../logger.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readAllTabRows, listSheetTabs, getGoogleAccessToken } from "../registers/sheetsApi.js";
import { normName, normSecKey } from "./names.js";

export type RosterMember = {
  stateHead: string;
  state: string;
  name: string;
  normKey: string;
  workingState: string;
  headquarter: string;
  dojSerial: number | null;
  contactNumber: string;
  weekOff: string;
  marketHours: string;
  monthlyCtc: number | null;
  leftDateSerial: number | null;
  activeLeft: string;
  channel: string;
  /** Employee code from User_List.csv; null when roster comes from an older source. */
  empCode: string | null;
  /** Designation from User_List.csv; null when roster comes from an older source. */
  designation: string | null;
};

/** A dashboard member that had no matching row in User_List.csv. */
export type UnmatchedCsvMember = {
  /** Display name from the STATE HEAD DASHBOARD. */
  name: string;
  /** normSecKey used for the CSV lookup that found no match. */
  normKey: string;
  /** State head this member reports to. */
  stateHead: string;
  /** State from the dashboard. */
  state: string;
  /** Best-match name from the CSV by edit distance (on normSecKey). */
  closestCsvName: string | null;
  /** normSecKey of the closest CSV candidate. */
  closestCsvKey: string | null;
  /** Edit distance between normKey and closestCsvKey (null when CSV is empty). */
  editDistance: number | null;
};

export type Roster = {
  members: RosterMember[];
  /** hr_roster_csv = User_List.csv (HR SFA, 35 cols, authoritative)
   *  hr_roster     = Team Member Details.xlsx (Drive, 7 cols, identity only)
   *  state_head_dashboard = live STATE HEAD DASHBOARD Data tab (last resort) */
  source: "hr_roster_csv" | "hr_roster" | "state_head_dashboard";
  loadedAt: number;
  /**
   * Dashboard members that had no matching row in User_List.csv, each with
   * the closest CSV candidate by edit distance. Only populated when source is
   * "hr_roster_csv" (i.e. the CSV was actually loaded and applied).
   */
  unmatchedFromCsv: UnmatchedCsvMember[];
};

type MgmtSources = {
  hr_roster: { fileId: string; name: string };
  roster_fallback: {
    sheetId: string;
    dataTab: string;
    secondaryTabPrefix: string;
  };
  secondary_order_booking: {
    folderId: string;
    tab: string;
    files_by_year: Record<string, string>;
  };
  state_head_registers: { folderId: string };
  party_tm_map: { sheetName: string; memberReportFolderId: string };
  target_master: { sheetId: string; name: string; tab: string };
  group_index: { sheetId: string; tab: string };
  party_os_payment?: { files_by_year: Record<string, string> };
};

// Statically imported so esbuild bundles it — a cwd-relative read breaks in
// production, where the server does not run from the artifact directory.
export function mgmtSources(): MgmtSources {
  return mgmtSourcesJson as MgmtSources;
}

const ROSTER_TTL_MS = 15 * 60_000;
let rosterCache: Roster | null = null;

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Attempts the real HR roster workbook (a non-native xlsx in Drive). Returns
// null when the file is unreachable so the caller can fall back.
async function tryHrRoster(): Promise<RosterMember[] | null> {
  const { fileId } = mgmtSources().hr_roster;
  try {
    const token = await getGoogleAccessToken();
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!metaRes.ok) return null;
    const bufRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!bufRes.ok) return null;
    const arrayBuf = await bufRes.arrayBuffer();
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      Buffer.from(arrayBuf) as unknown as Parameters<typeof wb.xlsx.load>[0],
    );
    const ws = wb.worksheets[0];
    if (!ws) return null;
    // Locate the header row by content ("Name" + "Reporting Manager").
    let headerRow = 0;
    const colOf: Record<string, number> = {};
    ws.eachRow((row, rowNumber) => {
      if (headerRow) return;
      const labels: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        labels[col] = str(cell.value).toLowerCase();
      });
      if (
        labels.some((l) => l === "name") &&
        labels.some((l) => l && l.startsWith("reporting"))
      ) {
        headerRow = rowNumber;
        labels.forEach((l, col) => {
          if (l) colOf[l] = col;
        });
      }
    });
    if (!headerRow) return null;
    const pick = (prefix: string): number => {
      const key = Object.keys(colOf).find((k) => k.startsWith(prefix));
      return key ? colOf[key] : 0;
    };
    const cName = pick("name");
    const cState = pick("state");
    const cManager = pick("reporting");
    const cHq = pick("headquarter");
    const cMobile = pick("mobile");
    if (!cName || !cManager) return null;
    const members: RosterMember[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const name = str(row.getCell(cName).value);
      if (!name) return;
      members.push({
        stateHead: cManager ? str(row.getCell(cManager).value) : "",
        state: cState ? str(row.getCell(cState).value) : "",
        name,
        normKey: normSecKey(name),
        workingState: cState ? str(row.getCell(cState).value) : "",
        headquarter: cHq ? str(row.getCell(cHq).value) : "",
        dojSerial: null,
        contactNumber: cMobile ? str(row.getCell(cMobile).value) : "",
        weekOff: "",
        marketHours: "",
        monthlyCtc: null,
        leftDateSerial: null,
        activeLeft: "",
        channel: "",
        empCode: null,       // 7-col Drive xlsx has no emp code
        designation: null,   // 7-col Drive xlsx has no designation
      });
    });
    return members.length > 0 ? members : null;
  } catch (err) {
    logger.warn({ err }, "hr_roster workbook unavailable; using fallback");
    return null;
  }
}

// ── Edit-distance helper for closest-CSV-candidate matching ───────────────────

/** Levenshtein distance between two strings (operates on their characters). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  // Use two rolling rows to keep memory O(min(m,n)).
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev] = [[...curr]];
  }
  return prev[n];
}

// ── CSV enrichment (User_List.csv, HR SFA system) ─────────────────────────────
//
// User_List.csv (config/hr_roster.csv) is the HR SFA system export — 35 columns
// including Employee Code, Designation, Date of Joining, CTC, Status (Active /
// Deactive), lat/lng, Assigned Segment, etc.
//
// ARCHITECTURE: the CSV is NOT used as the member list because it contains the
// full historical churn log (440+ rows across all FYs). The member list always
// comes from the live STATE HEAD DASHBOARD Data tab (~182 current members).
// The CSV is indexed by normSecKey and used to ENRICH each dashboard member
// with emp code, designation, CTC, DOJ, and status.
//
// Source label: "hr_roster_csv"

const MONTHS_CSV: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** Parse "DD-Month-YYYY" → Excel serial (days since 1899-12-31). */
function parseCsvDate(s: string): number | null {
  if (!s) return null;
  const parts = s.trim().split("-");
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = MONTHS_CSV[parts[1].toLowerCase()];
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || month === undefined || isNaN(year)) return null;
  const date = new Date(Date.UTC(year, month, day));
  return Math.floor(date.getTime() / 86_400_000) + 25_569;
}

/** Minimal RFC-4180-correct CSV line parser (handles quoted fields + escaped quotes). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '"' && line[end + 1] === '"') { end += 2; }
        else if (line[end] === '"') { break; }
        else { end++; }
      }
      fields.push(line.slice(i + 1, end).replace(/""/g, '"'));
      i = end + 2; // skip closing quote + comma
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

type CsvHrEnrichment = {
  empCode: string | null;
  designation: string | null;
  monthlyCtc: number | null;
  dojSerial: number | null;
  leftDateSerial: number | null;
  /** "Active" | "LEFT" derived from Status column. */
  activeLeft: string;
};

/**
 * Reads User_List.csv and returns a normSecKey → enrichment map.
 * Returns null when the file is absent or malformed.
 * When the same name appears multiple times (e.g. re-hired), the most recent
 * Active row wins; if all are Deactive the first is kept.
 */
type CsvHrResult = {
  enrichment: Map<string, CsvHrEnrichment>;
  /** normSecKey → raw display name from CSV (used for closest-candidate labels). */
  rawNames: Map<string, string>;
};

/**
 * Reads User_List.csv and returns an enrichment map + a raw-name map.
 * Returns null when the file is absent or malformed.
 * When the same name appears multiple times (e.g. re-hired), the most recent
 * Active row wins; if all are Deactive the first is kept.
 */
function loadCsvHrEnrichment(): CsvHrResult | null {
  try {
    // esbuild bundles everything to dist/index.mjs so import.meta.url points
    // to dist/, one level above config/.  Try candidates in priority order.
    const __dir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(__dir, "../config/hr_roster.csv"),
      join(process.cwd(), "config/hr_roster.csv"),
      join(process.cwd(), "artifacts/api-server/config/hr_roster.csv"),
    ];
    const csvPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
    const content = readFileSync(csvPath, "utf8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return null;

    const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (needle: string) =>
      headers.findIndex((h) => h === needle.toLowerCase());

    const cName  = col("name");
    const cEmp   = col("employee code");
    const cDesig = col("designation");
    const cDoj   = col("date of joining");
    const cDol   = col("date of leaving");
    const cStatus = col("status");
    const cCtc   = col("ctc");

    if (cName < 0 || cStatus < 0) {
      logger.warn("hr_roster.csv: missing required columns (name/status)");
      return null;
    }

    const map = new Map<string, CsvHrEnrichment>();
    const rawNames = new Map<string, string>();
    for (let i = 1; i < lines.length; i++) {
      const f = parseCsvLine(lines[i]);
      const name = f[cName]?.trim() ?? "";
      if (!name) continue;
      const nsk = normSecKey(name);
      const statusRaw = (f[cStatus] ?? "").trim().toLowerCase();
      const activeLeft = statusRaw === "active" ? "Active" : "LEFT";
      const ctcRaw = cCtc >= 0 ? parseFloat(f[cCtc] ?? "") : NaN;
      const entry: CsvHrEnrichment = {
        empCode:        cEmp   >= 0 ? (f[cEmp]?.trim()   || null) : null,
        designation:    cDesig >= 0 ? (f[cDesig]?.trim() || null) : null,
        monthlyCtc:     Number.isFinite(ctcRaw) ? ctcRaw : null,
        dojSerial:      cDoj   >= 0 ? parseCsvDate(f[cDoj] ?? "") : null,
        leftDateSerial: cDol   >= 0 ? parseCsvDate(f[cDol] ?? "") : null,
        activeLeft,
      };
      // Prefer Active rows over Deactive when the same name appears multiple times.
      const existing = map.get(nsk);
      if (!existing || (existing.activeLeft !== "Active" && activeLeft === "Active")) {
        map.set(nsk, entry);
        rawNames.set(nsk, name);
      }
    }

    logger.info(
      { entries: map.size },
      "hr_roster.csv enrichment loaded (User_List.csv — HR SFA system)",
    );
    return map.size > 0 ? { enrichment: map, rawNames } : null;
  } catch (err) {
    logger.warn({ err }, "hr_roster.csv unreadable; emp code / designation unavailable");
    return null;
  }
}

// Fallback: identity columns of the live STATE HEAD DASHBOARD workbook.
// Data tab (header row 3): 1 State Head, 2 State, 3 Name, 4 Working State,
// 5 Headquarter, 6 D.O.J, 52 Left Date, 53 Active/Left, 59 Secondary/Primary.
// SECONDARY tab (rows 7+): 2 State Head, 3 Team Member, 4 H.Q, 5 Contact
// Number, 6 DOJ, 7 Week Off, 8 Market Hours.
async function loadFallbackRoster(): Promise<RosterMember[]> {
  const fb = mgmtSources().roster_fallback;
  const rows = await readAllTabRows(fb.sheetId, fb.dataTab);
  // xlsx exports truncate tab titles; live tabs keep full names. Match by
  // prefix, never equality.
  const tabs = await listSheetTabs(fb.sheetId);
  const secondaryTab = tabs.find((t) =>
    t.title.trim().startsWith(fb.secondaryTabPrefix),
  );
  const extras = new Map<
    string,
    { contact: string; weekOff: string; marketHours: string; doj: number | null }
  >();
  if (secondaryTab) {
    const secRows = await readAllTabRows(fb.sheetId, secondaryTab.title);
    for (let i = 6; i < secRows.length; i++) {
      const r = secRows[i] ?? [];
      const name = str(r[2]);
      if (!name) continue;
      extras.set(normName(name), {
        contact: str(r[4]),
        weekOff: str(r[6]),
        marketHours: str(r[7]),
        doj: num(r[5]),
      });
    }
  }
  const members: RosterMember[] = [];
  const seen = new Set<string>();
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const name = str(r[2]);
    const stateHead = str(r[0]);
    if (!name || !stateHead) continue;
    const key = normName(name);           // normName for extras join (secondary tab)
    const nsk = normSecKey(name);         // normSecKey: keeps parentheticals → roster normKey
    // Dedup on (normName, stateHead) compound key so two members who share a
    // base name under *different* state heads both survive.  Using normName
    // alone caused "Ashutosh Kumar (Rudrapur)" to be silently dropped because
    // normName strips the parenthetical and produces the same key as plain
    // "Ashutosh Kumar" (Dhanbad, Sandeep Dadheech's team).
    const dedupKey = `${key}:${normName(stateHead)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const extra = extras.get(key);
    members.push({
      stateHead,
      state: str(r[1]),
      name,
      normKey: nsk,
      workingState: str(r[3]),
      headquarter: str(r[4]),
      dojSerial: num(r[5]) ?? extra?.doj ?? null,
      contactNumber: extra?.contact ?? "",
      weekOff: extra?.weekOff ?? "",
      marketHours: extra?.marketHours ?? "",
      monthlyCtc: null,
      leftDateSerial: num(r[51]),
      activeLeft: str(r[52]),
      channel: str(r[58]),
      empCode: null,       // Data tab has no emp code column
      designation: null,   // designation comes from hrSfa map, not roster
    });
  }
  return members;
}

// Concurrent requests while the roster is uncached share one Sheets read.
let rosterInFlight: Promise<Roster> | null = null;

export async function loadRoster(): Promise<Roster> {
  if (rosterCache && Date.now() - rosterCache.loadedAt < ROSTER_TTL_MS) {
    return rosterCache;
  }
  if (rosterInFlight) return rosterInFlight;
  rosterInFlight = loadRosterUncached().finally(() => {
    rosterInFlight = null;
  });
  return rosterInFlight;
}

async function loadRosterUncached(): Promise<Roster> {
  // Member list always comes from the STATE HEAD DASHBOARD Data tab (~182 current
  // members). This is the source of truth for WHO appears in the dashboard; it
  // is maintained by the business and already excludes members from earlier FYs
  // who are no longer relevant.
  //
  // Source priority for identity / HR metadata ON those members:
  //   hr_roster_csv  — User_List.csv (HR SFA system, 35 cols); applied as an
  //                    enrichment map (normSecKey → emp code / designation / CTC).
  //                    The CSV itself is NOT used as the member list because it
  //                    contains the full historical churn log (440+ rows).
  //   hr_roster      — Team Member Details.xlsx (Drive, 7 cols, identity only).
  //   state_head_dashboard — no supplemental HR file; pure fallback.

  // 1. Build the member list from the State Head Dashboard.
  const members = await loadFallbackRoster();

  // 2. Try to enrich each member with CSV HR data (emp code, designation, CTC).
  const csvResult = loadCsvHrEnrichment();
  if (csvResult) {
    const { enrichment: csvMap, rawNames: csvRawNames } = csvResult;
    let matched = 0;
    const unmatchedFromCsv: UnmatchedCsvMember[] = [];
    const csvKeys = [...csvMap.keys()]; // normSecKey strings for edit-distance scan
    for (const m of members) {
      const hr = csvMap.get(m.normKey);
      if (!hr) {
        // Find closest CSV candidate by edit distance on normSecKey.
        let bestKey: string | null = null;
        let bestDist: number | null = null;
        for (const csvKey of csvKeys) {
          const d = editDistance(m.normKey, csvKey);
          if (bestDist === null || d < bestDist) {
            bestDist = d;
            bestKey = csvKey;
          }
        }
        unmatchedFromCsv.push({
          name: m.name,
          normKey: m.normKey,
          stateHead: m.stateHead,
          state: m.state,
          closestCsvName: bestKey ? (csvRawNames.get(bestKey) ?? null) : null,
          closestCsvKey: bestKey,
          editDistance: bestDist,
        });
        continue;
      }
      matched++;
      m.empCode      = hr.empCode;
      m.designation  = hr.designation;
      m.monthlyCtc   = hr.monthlyCtc ?? m.monthlyCtc;
      // Use CSV DOJ when the dashboard DOJ is absent.
      if (!m.dojSerial && hr.dojSerial) m.dojSerial = hr.dojSerial;
      // CSV left-date and status are more precise than the dashboard column.
      if (hr.leftDateSerial) m.leftDateSerial = hr.leftDateSerial;
    }
    logger.info(
      { total: members.length, matched, unmatched: unmatchedFromCsv.length,
        unmatchedNames: unmatchedFromCsv.map((u) => u.name) },
      "roster: CSV HR enrichment applied (User_List.csv)",
    );
    rosterCache = { members, source: "hr_roster_csv", loadedAt: Date.now(), unmatchedFromCsv };
    return rosterCache;
  }

  // 3. Try to enrich from the Drive HR xlsx (7-col identity workbook).
  const hrXlsx = await tryHrRoster();
  if (hrXlsx) {
    // The Drive xlsx has no emp code / designation but may have contact numbers.
    const xlsxByKey = new Map(hrXlsx.map((m) => [m.normKey, m]));
    for (const m of members) {
      const x = xlsxByKey.get(m.normKey);
      if (x?.contactNumber) m.contactNumber = x.contactNumber;
    }
    rosterCache = { members, source: "hr_roster", loadedAt: Date.now(), unmatchedFromCsv: [] };
    return rosterCache;
  }

  // 4. No supplemental HR file — use the dashboard data as-is.
  rosterCache = { members, source: "state_head_dashboard", loadedAt: Date.now(), unmatchedFromCsv: [] };
  return rosterCache;
}

export function invalidateRosterCache(): void {
  rosterCache = null;
}
