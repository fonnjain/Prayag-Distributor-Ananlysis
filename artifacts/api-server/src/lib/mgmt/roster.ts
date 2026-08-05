// Roster spine for the management report: one row per team member, rolled up
// to a State Head.
//
// Intended source: the "Team Member Details" HR workbook (config
// mgmt_sources.hr_roster). That Drive file is not currently shared with the
// connected account, so the loader falls back to the identity columns of the
// live STATE HEAD DASHBOARD workbook (Data tab + SECONDARY tab fixed columns).
// Only identity/roster fields are read from the fallback; scorecard metrics
// are always computed from raw sources or left blank.
import mgmtSourcesJson from "../../../config/mgmt_sources.json";
import { logger } from "../logger.js";
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
};

export type Roster = {
  members: RosterMember[];
  source: "hr_roster" | "state_head_dashboard";
  loadedAt: number;
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
      });
    });
    return members.length > 0 ? members : null;
  } catch (err) {
    logger.warn({ err }, "hr_roster workbook unavailable; using fallback");
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
  const hr = await tryHrRoster();
  if (hr) {
    rosterCache = { members: hr, source: "hr_roster", loadedAt: Date.now() };
    return rosterCache;
  }
  const members = await loadFallbackRoster();
  rosterCache = {
    members,
    source: "state_head_dashboard",
    loadedAt: Date.now(),
  };
  return rosterCache;
}

export function invalidateRosterCache(): void {
  rosterCache = null;
}
