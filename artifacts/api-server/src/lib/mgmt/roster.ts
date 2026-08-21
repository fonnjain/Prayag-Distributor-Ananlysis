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
import { writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readAllTabRows, listSheetTabs, getGoogleAccessToken } from "../registers/sheetsApi.js";
import { normName, normSecKey } from "./names.js";
import { objectStorageClient } from "../objectStorage.js";

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
  state_head_registers: {
    folderId: string;
    folders_by_year?: Record<string, string>;
  };
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

// ── Object Storage (GCS) persistence for hr_roster.csv ───────────────────────
// The local config/hr_roster.csv file is packaged with the server at build time
// but uploaded copies overwrite it in the running container.  In production,
// container replacement (redeploy or instance restart) reverts to the packaged
// file.  We mirror every upload to GCS and restore from GCS at cold-start so
// the most recently uploaded file always wins regardless of deploys.
//
// Errors in GCS operations are logged as warnings and never thrown — the local
// file remains the fast path; GCS is the durable backup.

function parseGcsPath(path: string): { bucketName: string; objectName: string } {
  const p = path.startsWith("/") ? path : `/${path}`;
  const parts = p.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function gcsRosterCsvPath(): string | null {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) return null;
  return `${dir.replace(/\/$/, "")}/config/hr_roster.csv`;
}

/**
 * Tracks whether a GCS restore has been attempted this process lifetime.
 * Set by restoreRosterCsvFromGcs() regardless of success or failure, so we
 * only hit GCS once per process on the lazy-restore code path.
 */
let _rosterGcsRestoreAttempted = false;

/**
 * Persists the CSV text to GCS so it survives deployment restarts.
 * Non-blocking — callers should not await this unless they need the error.
 */
export async function saveRosterCsvToGcs(csvText: string): Promise<void> {
  const gcsPath = gcsRosterCsvPath();
  if (!gcsPath) return;
  try {
    const { bucketName, objectName } = parseGcsPath(gcsPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    await file.save(Buffer.from(csvText, "utf8"), {
      contentType: "text/csv",
      resumable: false,
    });
    logger.info("hr_roster.csv: persisted to object storage");
  } catch (err) {
    logger.warn({ err }, "hr_roster.csv: could not save to object storage");
  }
}

/**
 * Restores hr_roster.csv from GCS to the local path if GCS has a copy,
 * overwriting any existing packaged fallback so GCS is always authoritative.
 * Sets _rosterGcsRestoreAttempted regardless of outcome so the lazy path
 * in loadRosterUncached does not repeat the GCS round-trip.
 * Returns the local path written, or null when GCS has no copy or fails.
 */
export async function restoreRosterCsvFromGcs(): Promise<string | null> {
  _rosterGcsRestoreAttempted = true;
  const gcsPath = gcsRosterCsvPath();
  if (!gcsPath) return null;
  try {
    const { bucketName, objectName } = parseGcsPath(gcsPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [content] = await file.download();
    const csvText = content.toString("utf8");
    // Use a durable writable path — the CWD-relative uploads-adjacent config dir
    // survives across redeployments within the same container.  Write to the first
    // candidate regardless of existence so GCS always wins over the packaged file.
    const localPath = hrRosterCsvWritePath();
    // Atomic write: temp file + rename so readers never see a partial file.
    const tmpPath = `${localPath}.tmp`;
    const dir = dirname(localPath);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, csvText, "utf8");
    await rename(tmpPath, localPath);
    logger.info({ localPath }, "hr_roster.csv: restored from object storage");
    return localPath;
  } catch (err) {
    logger.warn({ err }, "hr_roster.csv: could not restore from object storage");
    return null;
  }
}

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

/**
 * Full RFC-4180 state-machine parser: parses the ENTIRE CSV text into rows,
 * correctly handling quoted fields, escaped quotes ("") and newlines embedded
 * inside quoted fields (the Sales_User_List Assigned Segment / Address columns
 * contain quoted commas and multi-line values). Splitting on newlines would
 * mis-count rows (863 fragments vs 609 real rows) — so we never do that.
 */
function parseCsvDocument(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      field += ch; continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Employee-code plausibility: valid = purely numeric AND ≤ 4 digits.
 * Anything else (long numerics, round-number placeholders like 5900000000000,
 * strings with "+" characters, or 10-digit mobile numbers) is a data-entry
 * error surfaced on the Organization page for HR to correct at source. This
 * never auto-fixes and never merges rows.
 */
function isPlausibleEmpCode(raw: string | null | undefined): boolean {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  if (!/^[0-9]+$/.test(s)) return false;
  return s.length <= 4;
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
 * Returns the canonical WRITE target for hr_roster.csv.
 *
 * Uses the same runtime-writable uploads directory as dashboardXlsx.ts and
 * orders.ts so the path is guaranteed to exist in both dev and production
 * regardless of the esbuild output layout.  Uploads and GCS restores write
 * here; the directory is created on demand before each write.
 */
export function hrRosterCsvWritePath(): string {
  const uploadDir = resolve(process.env.ORDER_UPLOAD_DIR ?? join(process.cwd(), "uploads"));
  return join(uploadDir, "hr_roster.csv");
}

/**
 * Resolves the path to hr_roster.csv for reading.
 *
 * Checks the canonical write path first (picks up runtime uploads / GCS
 * restores), then falls back to the packaged baseline candidates so the
 * first cold boot before any upload still has data.
 *
 * esbuild bundles everything to dist/index.mjs so import.meta.url points
 * to dist/, one level above config/.
 */
export function hrRosterCsvPath(): string {
  const writePath = hrRosterCsvWritePath();
  if (existsSync(writePath)) return writePath;
  const __dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dir, "../config/hr_roster.csv"),
    join(process.cwd(), "config/hr_roster.csv"),
    join(process.cwd(), "artifacts/api-server/config/hr_roster.csv"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * Reads User_List.csv and returns a normSecKey → enrichment map.
 * Returns null when the file is absent or malformed.
 * When the same name appears multiple times (e.g. re-hired), the most recent
 * Active row wins; if all are Deactive the first is kept.
 */
type CsvHrResult = {
  /**
   * Name-only enrichment map (normSecKey(name) → enrichment). Kept for
   * compatibility, but ONLY safe to use when the name is unambiguous — i.e.
   * exactly one CSV row carries that normKey. See `ambiguousNameKeys`.
   */
  enrichment: Map<string, CsvHrEnrichment>;
  /**
   * Compound-identity enrichment map keyed by
   * normSecKey(name) + ":" + normSecKey(reporting manager). This is the
   * PRIMARY resolution path: it never attaches a different person's data to a
   * same-name colleague under a different manager.
   */
  byIdentity: Map<string, CsvHrEnrichment>;
  /**
   * normSecKey(name) values that appear on MORE THAN ONE distinct CSV row
   * (duplicate names under different managers, e.g. Ranjeet Kumar, Pawan
   * Kumar, both Ashutosh Kumar rows). For these, the name-only map is unsafe:
   * enrichment must come from a compound-key match or attach nothing.
   */
  ambiguousNameKeys: Set<string>;
  /** normSecKey → raw display name from CSV (used for closest-candidate labels). */
  rawNames: Map<string, string>;
  /** Roster-health facts for the Organization page (see RosterHealth). */
  health: RosterHealth;
};

/** A single roster row keyed by the compound identity normSecKey(Name):normSecKey(Manager). */
export type RosterCsvRow = {
  name: string;
  reportingManager: string;
  /** normSecKey(Name) + ":" + normSecKey(Reporting Manager) — the primary key. */
  identityKey: string;
  status: string;
  active: boolean;
  empCode: string | null;
  empCodePlausible: boolean;
  designation: string | null;
  headquarter: string;
  workingState: string;
  assignedSegment: string;
  orderType: string;
  ctc: number | null;
  state: string;
  city: string;
};

/**
 * Aggregated roster-health facts computed from hr_roster.csv (Sales_User_List).
 * Surfaced on the Organization page as a read-only "roster health panel".
 * All flags are advisory — nothing here auto-fixes or merges rows.
 */
export type RosterHealth = {
  rowsParsed: number;
  activeCount: number;
  deactiveCount: number;
  /** Coverage % across the ACTIVE members. */
  coverage: {
    designation: number;
    reportingManager: number;
    ctc: number;
    headquarter: number;
    workingState: number;
    assignedSegment: number;
  };
  /** Order Type breakdown across ACTIVE members. */
  orderType: Record<string, number>;
  /** Active members whose employee code fails the plausibility test (name-only). */
  badEmpCodeNames: string[];
  /** Active people sharing one placeholder employee code (kept, not merged). */
  sharedEmpCode: {
    empCode: string;
    people: Array<{ name: string; city: string; reportingManager: string }>;
  } | null;
  /** Name-reversed possible duplicate to flag for human review (never auto-merged). */
  possibleDuplicate: {
    empCode: string;
    rows: Array<{ name: string; city: string; status: string }>;
  } | null;
  /** Distinct Reporting Manager names that resolve to NO other row in the file. */
  unresolvedManagers: string[];
  /**
   * Count of CSV names that are ambiguous — the same normalized name appears
   * on more than one distinct row (duplicate names under different managers).
   * A dashboard member with such a name only gets enrichment via a compound
   * name+manager match; otherwise it attaches NOTHING rather than risk a wrong
   * person's data.
   */
  ambiguousNameCount: number;
  /** The ambiguous duplicate-name groups, for display (advisory only). */
  ambiguousNames: Array<{ name: string; count: number }>;
};

/**
 * Reads User_List.csv and returns an enrichment map + a raw-name map.
 * Returns null when the file is absent or malformed.
 * When the same name appears multiple times (e.g. re-hired), the most recent
 * Active row wins; if all are Deactive the first is kept.
 */
function loadCsvHrEnrichment(): CsvHrResult | null {
  try {
    const csvPath = hrRosterCsvPath();
    const content = readFileSync(csvPath, "utf8");
    // Real RFC-4180 parse of the WHOLE document — never split on newlines, or
    // the quoted multi-line Assigned Segment / Address fields fragment the rows.
    const rows = parseCsvDocument(content);
    if (rows.length < 2) return null;

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const col = (needle: string) =>
      headers.findIndex((h) => h === needle.toLowerCase());

    const cName  = col("name");
    const cMgr   = col("reporting manager");
    const cEmp   = col("employee code");
    const cDesig = col("designation");
    const cDoj   = col("date of joining");
    const cDol   = col("date of leaving");
    const cStatus = col("status");
    const cCtc   = col("ctc");
    const cHq    = col("headquarter");
    const cWState = col("working state");
    const cSeg   = col("assigned segment");
    const cOrder = col("order type");
    const cState = col("state");
    const cCity  = col("city");
    // "Last Updated By" / "Last Updated On" are OPTIONAL — absent in
    // Sales_User_List.csv (33 cols) but present in the older export (35 cols).
    // We never require them.

    if (cName < 0 || cStatus < 0) {
      logger.warn("hr_roster.csv: missing required columns (name/status)");
      return null;
    }

    // Name-keyed enrichment map (kept for enrichment compatibility with the
    // dashboard-driven member list — callers look up by normSecKey(name)).
    const map = new Map<string, CsvHrEnrichment>();
    const rawNames = new Map<string, string>();
    // Compound-keyed enrichment: normSecKey(Name):normSecKey(Reporting Manager).
    // This is the PRIMARY resolution path so same-name / different-manager
    // people (e.g. both "Ashutosh Kumar" records) never receive each other's
    // employee code / designation / CTC / status.
    const byIdentity = new Map<string, CsvHrEnrichment>();
    // Track how many DISTINCT CSV rows carry each name key so we can detect
    // ambiguous names (duplicate names under different managers).
    const nameKeyRowCount = new Map<string, number>();
    // Compound-keyed rows: needed only for roster-health aggregation.
    const identityRows = new Map<string, RosterCsvRow>();
    const csvRows: RosterCsvRow[] = [];

    const dataRows = rows.slice(1).filter((f) => (f[cName]?.trim() ?? "") !== "");
    for (const f of dataRows) {
      const name = f[cName]?.trim() ?? "";
      if (!name) continue;
      const mgr = cMgr >= 0 ? (f[cMgr]?.trim() ?? "") : "";
      const nsk = normSecKey(name);
      const identityKey = nsk + ":" + normSecKey(mgr);
      const statusRaw = (f[cStatus] ?? "").trim();
      const isActive = statusRaw.toLowerCase() === "active";
      const activeLeft = isActive ? "Active" : "LEFT";
      const empCode = cEmp >= 0 ? (f[cEmp]?.trim() || null) : null;
      const ctcRaw = cCtc >= 0 ? parseFloat((f[cCtc] ?? "").replace(/[,\s]/g, "")) : NaN;
      const monthlyCtc = Number.isFinite(ctcRaw) && ctcRaw > 0 ? ctcRaw : null;

      const entry: CsvHrEnrichment = {
        empCode,
        designation:    cDesig >= 0 ? (f[cDesig]?.trim() || null) : null,
        monthlyCtc,
        dojSerial:      cDoj   >= 0 ? parseCsvDate(f[cDoj] ?? "") : null,
        leftDateSerial: cDol   >= 0 ? parseCsvDate(f[cDol] ?? "") : null,
        activeLeft,
      };
      // Name-keyed map: prefer Active rows over Deactive on same-name collisions.
      const existing = map.get(nsk);
      if (!existing || (existing.activeLeft !== "Active" && activeLeft === "Active")) {
        map.set(nsk, entry);
        rawNames.set(nsk, name);
      }
      nameKeyRowCount.set(nsk, (nameKeyRowCount.get(nsk) ?? 0) + 1);
      // Compound-key enrichment keeps BOTH same-name people distinct. First
      // row for an identity key wins (duplicate identity keys are rare and
      // indicate a genuine re-entry, not two people).
      if (!byIdentity.has(identityKey)) byIdentity.set(identityKey, entry);

      const rowRec: RosterCsvRow = {
        name,
        reportingManager: mgr,
        identityKey,
        status: statusRaw,
        active: isActive,
        empCode,
        empCodePlausible: isPlausibleEmpCode(empCode),
        designation:    cDesig >= 0 ? (f[cDesig]?.trim() || null) : null,
        headquarter:    cHq    >= 0 ? (f[cHq]?.trim() ?? "") : "",
        workingState:   cWState>= 0 ? (f[cWState]?.trim() ?? "") : "",
        assignedSegment:cSeg   >= 0 ? (f[cSeg]?.trim() ?? "") : "",
        orderType:      cOrder >= 0 ? (f[cOrder]?.trim() ?? "") : "",
        ctc:            monthlyCtc,
        state:          cState >= 0 ? (f[cState]?.trim() ?? "") : "",
        city:           cCity  >= 0 ? (f[cCity]?.trim() ?? "") : "",
      };
      csvRows.push(rowRec);
      if (!identityRows.has(identityKey)) identityRows.set(identityKey, rowRec);
    }

    // Names carried by more than one distinct CSV row are ambiguous: the
    // name-only map cannot safely resolve them.
    const ambiguousNameKeys = new Set<string>();
    for (const [nsk, count] of nameKeyRowCount) {
      if (count > 1) ambiguousNameKeys.add(nsk);
    }

    const health = computeRosterHealth(csvRows, ambiguousNameKeys);

    logger.info(
      {
        entries: map.size,
        rows: csvRows.length,
        identities: byIdentity.size,
        ambiguousNames: ambiguousNameKeys.size,
        active: health.activeCount,
        deactive: health.deactiveCount,
        badEmpCodes: health.badEmpCodeNames.length,
      },
      "hr_roster.csv loaded (Sales_User_List — HR SFA system; compound identity key)",
    );
    return map.size > 0
      ? { enrichment: map, byIdentity, ambiguousNameKeys, rawNames, health }
      : null;
  } catch (err) {
    logger.warn({ err }, "hr_roster.csv unreadable; emp code / designation unavailable");
    return null;
  }
}

/**
 * Computes the roster-health facts from the parsed CSV rows.
 * Advisory only — nothing here mutates the roster or merges rows.
 */
function computeRosterHealth(
  rows: RosterCsvRow[],
  ambiguousNameKeys: Set<string>,
): RosterHealth {
  const active = rows.filter((r) => r.active);
  const deactive = rows.filter((r) => r.status.toLowerCase() === "deactive");
  const pct = (n: number) =>
    active.length ? Number(((n / active.length) * 100).toFixed(1)) : 0;

  const coverage = {
    designation: pct(active.filter((r) => r.designation).length),
    reportingManager: pct(active.filter((r) => r.reportingManager).length),
    ctc: pct(active.filter((r) => r.ctc != null).length),
    headquarter: pct(active.filter((r) => r.headquarter).length),
    workingState: pct(active.filter((r) => r.workingState).length),
    assignedSegment: pct(active.filter((r) => r.assignedSegment).length),
  };

  const orderType: Record<string, number> = {};
  for (const r of active) {
    const k = r.orderType || "(blank)";
    orderType[k] = (orderType[k] ?? 0) + 1;
  }

  const badEmpCodeNames = active
    .filter((r) => !r.empCodePlausible)
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));

  // Shared placeholder emp code held by ≥2 DIFFERENT active people.
  let sharedEmpCode: RosterHealth["sharedEmpCode"] = null;
  const byCode = new Map<string, RosterCsvRow[]>();
  for (const r of active) {
    if (!r.empCode) continue;
    const list = byCode.get(r.empCode) ?? [];
    list.push(r);
    byCode.set(r.empCode, list);
  }
  for (const [code, list] of byCode) {
    const distinctPeople = new Set(list.map((r) => normSecKey(r.name)));
    if (distinctPeople.size >= 2) {
      sharedEmpCode = {
        empCode: code,
        people: list.map((r) => ({
          name: r.name,
          city: r.city,
          reportingManager: r.reportingManager,
        })),
      };
      break;
    }
  }

  // Name-reversed possible duplicate: same emp code, two rows whose sorted
  // name tokens are identical (e.g. "Balamurugan .V" vs "V. Balamurugan").
  let possibleDuplicate: RosterHealth["possibleDuplicate"] = null;
  const byCodeAll = new Map<string, RosterCsvRow[]>();
  for (const r of rows) {
    if (!r.empCode) continue;
    const list = byCodeAll.get(r.empCode) ?? [];
    list.push(r);
    byCodeAll.set(r.empCode, list);
  }
  const tokenSig = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean).sort().join("");
  for (const [code, list] of byCodeAll) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (
          normSecKey(list[i].name) !== normSecKey(list[j].name) &&
          tokenSig(list[i].name) === tokenSig(list[j].name)
        ) {
          possibleDuplicate = {
            empCode: code,
            rows: [list[i], list[j]].map((r) => ({
              name: r.name,
              city: r.city,
              status: r.status,
            })),
          };
        }
      }
    }
    if (possibleDuplicate) break;
  }

  // Reporting Managers that resolve to no other Name row in the same file.
  const nameKeys = new Set(rows.map((r) => normSecKey(r.name)));
  const unresolvedSet = new Map<string, string>();
  for (const r of rows) {
    if (!r.reportingManager) continue;
    const mk = normSecKey(r.reportingManager);
    if (nameKeys.has(mk)) continue;
    if (!unresolvedSet.has(mk)) unresolvedSet.set(mk, r.reportingManager);
  }
  const unresolvedManagers = [...unresolvedSet.values()].sort((a, b) => a.localeCompare(b));

  // Ambiguous duplicate names (same normalized name on ≥2 distinct rows).
  const ambiguousNames: Array<{ name: string; count: number }> = [];
  for (const nsk of ambiguousNameKeys) {
    const dupes = rows.filter((r) => normSecKey(r.name) === nsk);
    if (dupes.length) ambiguousNames.push({ name: dupes[0].name, count: dupes.length });
  }
  ambiguousNames.sort((a, b) => a.name.localeCompare(b.name));

  return {
    rowsParsed: rows.length,
    activeCount: active.length,
    deactiveCount: deactive.length,
    coverage,
    orderType,
    badEmpCodeNames,
    sharedEmpCode,
    possibleDuplicate,
    unresolvedManagers,
    ambiguousNameCount: ambiguousNameKeys.size,
    ambiguousNames,
  };
}

/**
 * Reads hr_roster.csv (Sales_User_List) and returns the roster-health facts
 * for the Organization page. Returns null when the CSV is absent/unreadable.
 * This is the single authoritative reader — it reuses loadCsvHrEnrichment so
 * there is exactly one loader and one file.
 */
export function loadRosterHealth(): RosterHealth | null {
  const res = loadCsvHrEnrichment();
  return res?.health ?? null;
}

/** Result of resolving a roster member against the CSV enrichment maps. */
export type EnrichmentResolution = {
  enrichment: CsvHrEnrichment | null;
  /** "compound" = name+manager match, "name" = unambiguous name-only match,
   *  "ambiguous-blocked" = name is ambiguous and no manager match (attach nothing),
   *  "none" = no match at all. */
  via: "compound" | "name" | "ambiguous-blocked" | "none";
};

/**
 * Resolves CSV enrichment for one roster member using the compound identity
 * key normSecKey(name):normSecKey(reporting manager) FIRST, then falling back
 * to the name-only map ONLY when the name is unambiguous. When the name is
 * ambiguous (duplicate names under different managers) and no compound match
 * exists, returns null enrichment ("ambiguous-blocked") so a different
 * person's data is never grafted on.
 *
 * Exported for unit testing and reused by the roster loader below.
 */
export function resolveMemberEnrichment(
  nameKey: string,
  managerRaw: string,
  csv: Pick<CsvHrResult, "enrichment" | "byIdentity" | "ambiguousNameKeys">,
): EnrichmentResolution {
  const compoundKey = nameKey + ":" + normSecKey(managerRaw);
  const compound = csv.byIdentity.get(compoundKey);
  if (compound) return { enrichment: compound, via: "compound" };
  if (csv.ambiguousNameKeys.has(nameKey)) {
    return { enrichment: null, via: "ambiguous-blocked" };
  }
  const byName = csv.enrichment.get(nameKey);
  if (byName) return { enrichment: byName, via: "name" };
  return { enrichment: null, via: "none" };
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
  // Always try to restore from GCS if it hasn't been attempted yet this process
  // lifetime. This ensures a GCS-uploaded roster supersedes the packaged fallback
  // even when the packaged file exists on disk (e.g. after a redeploy).
  // The startup path in index.ts also calls restoreRosterCsvFromGcs() so this
  // is normally a no-op (the flag is already set); it acts as a belt-and-suspenders
  // catch for the rare case where the startup restore ran before GCS was reachable.
  if (!_rosterGcsRestoreAttempted) {
    await restoreRosterCsvFromGcs().catch((err) =>
      logger.warn({ err }, "GCS roster restore failed; continuing without CSV"),
    );
  }
  const csvResult = loadCsvHrEnrichment();
  if (csvResult) {
    const { enrichment: csvMap, byIdentity, ambiguousNameKeys, rawNames: csvRawNames } = csvResult;
    let matched = 0;
    let matchedByCompound = 0;
    // Members whose name is ambiguous in the CSV and whose reporting manager
    // did not yield a compound match — attach NOTHING to avoid grafting a
    // different person's employee code / designation / CTC / status.
    let ambiguousUnresolved = 0;
    const ambiguousUnresolvedNames: string[] = [];
    const unmatchedFromCsv: UnmatchedCsvMember[] = [];
    const csvKeys = [...csvMap.keys()]; // normSecKey strings for edit-distance scan
    const csvMaps = { enrichment: csvMap, byIdentity, ambiguousNameKeys };
    for (const m of members) {
      // PRIMARY: compound identity normSecKey(name):normSecKey(reporting
      // manager). The dashboard member's reporting manager is its State Head
      // column. Name-only fallback applies ONLY for unambiguous names.
      const resolution = resolveMemberEnrichment(m.normKey, m.stateHead, csvMaps);
      const hr = resolution.enrichment;
      const viaCompound = resolution.via === "compound";
      if (resolution.via === "ambiguous-blocked") {
        ambiguousUnresolved++;
        ambiguousUnresolvedNames.push(m.name);
      }

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
      if (viaCompound) matchedByCompound++;
      m.empCode      = hr.empCode;
      m.designation  = hr.designation;
      m.monthlyCtc   = hr.monthlyCtc ?? m.monthlyCtc;
      // Use CSV DOJ when the dashboard DOJ is absent.
      if (!m.dojSerial && hr.dojSerial) m.dojSerial = hr.dojSerial;
      // CSV left-date and status are more precise than the dashboard column.
      if (hr.leftDateSerial) m.leftDateSerial = hr.leftDateSerial;
    }
    logger.info(
      { total: members.length, matched, matchedByCompound,
        ambiguousUnresolved, ambiguousUnresolvedNames,
        unmatched: unmatchedFromCsv.length,
        unmatchedNames: unmatchedFromCsv.map((u) => u.name) },
      "roster: CSV HR enrichment applied (Sales_User_List; compound name+manager key)",
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
