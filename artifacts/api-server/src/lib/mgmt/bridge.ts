// Party -> Team Member bridge for the Sale side of the management report.
//
// The State-Head registers are tagged to State Head + Customer(party), not to
// a team member, so per-member Sale columns need a bridge. Priority order:
//   1. A consolidated "Party TM Map" sheet. Searched in Drive on every
//      (cached) load so it wires itself up automatically (read-only).
//   2. Auto-built in memory from the "STATE HEAD (Team Member Report)" folder
//      tree: every per-member file that carries a "Distributor Visit Report" /
//      "Retailer Report" tab contributes party rows (DIST#/RET# ids). The
//      result is held in memory only — it is NOT written back to Sheets
//      because Google Sheets access is strictly read-only.
//   3. While the build runs (or if it fails), Sale fills at State-Head grain
//      only, per-member Sale stays blank, and the Missing Data tab says
//      exactly why. Never guess an allocation.
//
// Join grain: the register's Customer column holds DISTRIBUTOR-grain names,
// so only DISTRIBUTOR bridge rows join to sales. Retailer rows are kept in
// the sheet for census/validation and to derive distributor->member links
// from the "Assigned Distributor" column ("via retailer assignment" rows,
// non-authoritative: a real Distributor Visit row always wins conflicts).
import { logger } from "../logger.js";
import {
  readAllTabRows,
  listSheetTabs,
  getGoogleAccessToken,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normName, normParty } from "./names.js";
import { mgmtSources } from "./roster.js";

export type BridgeEntry = {
  partyType: "DISTRIBUTOR" | "RETAILER";
  partyId: string;
  partyName: string;
  memberName: string;
  memberKey: string;
  stateHead: string;
  channelType: string;
  assignedDistributor: string;
  sourceFile: string;
  // True for rows read from a real Distributor Visit / Retailer Report tab;
  // false for distributor rows inferred from a retailer's Assigned
  // Distributor column.
  authoritative: boolean;
};

export type BridgeConflict = {
  party: string;
  partyId: string;
  members: string[];
  kept: string;
};

export type PartyBridge = {
  status: "ok" | "missing" | "error" | "building";
  detail: string;
  fileId?: string;
  // normParty(party name) -> owning entry. DISTRIBUTOR rows only — the
  // register's Customer column is distributor-grain.
  entries: Map<string, BridgeEntry>;
  // Party ID (e.g. "DIST#12") -> entry, DISTRIBUTOR rows only.
  byId: Map<string, BridgeEntry>;
  rows: BridgeEntry[];
  conflicts: BridgeConflict[];
  loadedAt: number;
};

const TTL_MS = 15 * 60_000;
// After a failed auto-build, wait this long before trying again on a plain
// load (an explicit rebuild request always retries immediately).
const BUILD_RETRY_MS = 30 * 60_000;

let cache: PartyBridge | null = null;
let inFlight: Promise<PartyBridge> | null = null;

function norm(v: unknown): string {
  return String(v ?? "").trim();
}

function normLabel(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Looks up a register party in the bridge: by explicit party id when the raw
// string carries one, else by normalized name (city parentheticals stripped).
export function lookupParty(
  bridge: PartyBridge,
  rawParty: unknown,
): BridgeEntry | null {
  const raw = norm(rawParty);
  if (!raw) return null;
  const idMatch = raw.match(/\b(DIST#\d+)\b/i);
  if (idMatch) {
    const hit = bridge.byId.get(idMatch[1].toUpperCase());
    if (hit) return hit;
  }
  const key = normParty(raw);
  if (!key) return null;
  return bridge.entries.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Drive helpers (search + recursive folder walk)
// ---------------------------------------------------------------------------

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const RETRYABLE = new Set([429, 500, 502, 503]);

async function driveGet(url: string): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const token = await getGoogleAccessToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    lastError = new Error(
      `Drive API request failed (${res.status}): ${body.slice(0, 200)}`,
    );
    if (!RETRYABLE.has(res.status) || attempt === 4) throw lastError;
    await new Promise((r) => setTimeout(r, attempt * 15_000));
  }
  throw lastError ?? new Error("Drive API request failed");
}

async function findBridgeSheet(): Promise<{ id: string; name: string } | null> {
  const sheetName = mgmtSources().party_tm_map.sheetName;
  const q = encodeURIComponent(
    `name contains '${sheetName}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
  );
  const data = (await driveGet(
    `${DRIVE_FILES}?q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`,
  )) as {
    files?: Array<{ id: string; name: string; modifiedTime?: string }>;
  };
  const files = data.files ?? [];
  if (files.length === 0) return null;
  // Prefer an exact-title match, then the most recently modified, so a
  // similarly named copy never shadows the real bridge sheet.
  files.sort((a, b) => {
    const aExact = a.name.trim() === sheetName ? 0 : 1;
    const bExact = b.name.trim() === sheetName ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "");
  });
  return files[0];
}

type WalkedFile = {
  id: string;
  name: string;
  modifiedTime: string;
  // Folder path segments below the root, e.g. ["State Heads", "Anant Singh"].
  path: string[];
};

async function walkFolderTree(rootId: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const queue: Array<{ id: string; path: string[] }> = [{ id: rootId, path: [] }];
  while (queue.length > 0) {
    const folder = queue.shift();
    if (!folder) break;
    let pageToken: string | undefined;
    do {
      const q = encodeURIComponent(`'${folder.id}' in parents and trashed=false`);
      const pt = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const data = (await driveGet(
        `${DRIVE_FILES}?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)&pageSize=1000${pt}`,
      )) as {
        nextPageToken?: string;
        files?: Array<{
          id: string;
          name: string;
          mimeType: string;
          modifiedTime?: string;
        }>;
      };
      for (const f of data.files ?? []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          queue.push({ id: f.id, path: [...folder.path, f.name] });
        } else if (f.mimeType === "application/vnd.google-apps.spreadsheet") {
          files.push({
            id: f.id,
            name: f.name,
            modifiedTime: f.modifiedTime ?? "",
            path: folder.path,
          });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Auto-build from the per-member report files
// ---------------------------------------------------------------------------

export type BridgeBuildState = {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  lastAttemptAt: number | null;
  phase: string;
  filesSeen: number;
  filesWithTabs: number;
  error: string | null;
  summary: string | null;
};

const buildState: BridgeBuildState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastAttemptAt: null,
  phase: "idle",
  filesSeen: 0,
  filesWithTabs: 0,
  error: null,
  summary: null,
};

export function getBridgeBuildState(): BridgeBuildState {
  return { ...buildState };
}

// Meta band at the top of each member report tab: row 1 carries "Team Member
// Name" -> <name>, row 2 carries "Reporting Manager" -> <head> (often blank).
function metaValue(rows: SheetCellValue[][], label: string): string {
  for (const r of rows.slice(0, 4)) {
    if (!r) continue;
    for (let i = 0; i < r.length; i++) {
      if (normLabel(r[i]) === label) {
        for (let j = i + 1; j < r.length; j++) {
          const v = norm(r[j]);
          if (v) return v;
        }
        return "";
      }
    }
  }
  return "";
}

type TabCols = { id: number; name: number; type: number; assigned: number };

function detectTabHeader(
  rows: SheetCellValue[][],
): { cols: TabCols; headerIdx: number } | null {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i];
    if (!r) continue;
    let id = -1;
    let name = -1;
    let type = -1;
    let assigned = -1;
    r.forEach((c, j) => {
      const l = normLabel(c);
      if (id < 0 && (l === "id" || l === "distributorid" || l === "retailerid")) {
        id = j;
      }
      if (
        name < 0 &&
        (l === "name" || l === "distributorname" || l === "retailername" || l === "partyname")
      ) {
        name = j;
      }
      if (type < 0 && l === "type") type = j;
      if (assigned < 0 && l.startsWith("assigneddistributor")) assigned = j;
    });
    if (id >= 0 && name >= 0) {
      return { cols: { id, name, type, assigned }, headerIdx: i };
    }
  }
  return null;
}

function fileMemberFallback(fileName: string): string {
  return fileName
    .replace(/^\s*copy\s+of\s*/i, "")
    .replace(/\.xlsx?$/i, "")
    .trim();
}

function headFolderOf(path: string[]): string {
  const i = path.findIndex((p) => normLabel(p) === "stateheads");
  if (i >= 0 && i + 1 < path.length) return path[i + 1];
  return "";
}

function parseMemberTab(
  rows: SheetCellValue[][],
  kind: "dist" | "ret",
  file: WalkedFile,
): BridgeEntry[] {
  const detected = detectTabHeader(rows);
  if (!detected) return [];
  const { cols, headerIdx } = detected;
  const memberName =
    metaValue(rows, "teammembername") || fileMemberFallback(file.name);
  const stateHead = metaValue(rows, "reportingmanager") || headFolderOf(file.path);
  if (!memberName) return [];
  const memberKey = normName(memberName);
  const out: BridgeEntry[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    if (!r) continue;
    const pid = norm(r[cols.id]);
    const pname = norm(r[cols.name]);
    if (!pid || !pname) continue;
    const pidUpper = pid.toUpperCase();
    if (pidUpper === "TOTAL" || pidUpper === "--") continue;
    if (kind === "dist") {
      out.push({
        partyType: "DISTRIBUTOR",
        partyId: pidUpper,
        partyName: pname,
        memberName,
        memberKey,
        stateHead,
        channelType: cols.type >= 0 ? norm(r[cols.type]) || "Distributor" : "Distributor",
        assignedDistributor: "",
        sourceFile: file.name,
        authoritative: true,
      });
    } else {
      const assigned = cols.assigned >= 0 ? norm(r[cols.assigned]) : "";
      out.push({
        partyType: "RETAILER",
        partyId: pidUpper,
        partyName: pname,
        memberName,
        memberKey,
        stateHead,
        channelType: "Retailer",
        assignedDistributor: assigned,
        sourceFile: file.name,
        authoritative: true,
      });
      // Derive distributor->member links from the retailer's assigned
      // distributor(s). Non-authoritative: real Distributor Visit rows win.
      for (const dn of assigned.split(",")) {
        const distName = dn.trim();
        if (!distName || !normParty(distName)) continue;
        out.push({
          partyType: "DISTRIBUTOR",
          partyId: "",
          partyName: distName,
          memberName,
          memberKey,
          stateHead,
          channelType: "Distributor (via retailer assignment)",
          assignedDistributor: "",
          sourceFile: file.name,
          authoritative: false,
        });
      }
    }
  }
  return out;
}

const DIST_TAB_PREFIX = "distributorvisitreport";
const RET_TAB_PREFIX = "retailerreport";
// Sort so that first-wins indexing keeps: authoritative distributor rows from
// the most recently modified file, then via-retailer rows, then retailers.
function sortForPrecedence(rows: Array<BridgeEntry & { mtime?: string }>): void {
  rows.sort((a, b) => {
    if (a.partyType !== b.partyType) return a.partyType === "DISTRIBUTOR" ? -1 : 1;
    if (a.authoritative !== b.authoritative) return a.authoritative ? -1 : 1;
    return (b.mtime ?? "").localeCompare(a.mtime ?? "");
  });
}

function buildIndexes(rows: BridgeEntry[]): {
  entries: Map<string, BridgeEntry>;
  byId: Map<string, BridgeEntry>;
  conflicts: BridgeConflict[];
} {
  const entries = new Map<string, BridgeEntry>();
  const byId = new Map<string, BridgeEntry>();
  const conflictMap = new Map<string, BridgeConflict>();
  const noteConflict = (kept: BridgeEntry, loser: BridgeEntry, key: string) => {
    // Same member reached via two paths is not a conflict.
    if (kept.memberKey === loser.memberKey) return;
    // A non-authoritative row losing to an authoritative one is expected.
    if (kept.authoritative && !loser.authoritative) return;
    const existing = conflictMap.get(key);
    if (existing) {
      if (!existing.members.includes(loser.memberName)) {
        existing.members.push(loser.memberName);
      }
      return;
    }
    conflictMap.set(key, {
      party: kept.partyName,
      partyId: kept.partyId,
      members: [kept.memberName, loser.memberName],
      kept: kept.memberName,
    });
  };
  for (const row of rows) {
    if (row.partyType !== "DISTRIBUTOR") continue;
    if (row.partyId) {
      const prev = byId.get(row.partyId);
      if (prev) noteConflict(prev, row, `id:${row.partyId}`);
      else byId.set(row.partyId, row);
    }
    const key = normParty(row.partyName);
    if (!key) continue;
    const prev = entries.get(key);
    if (prev) noteConflict(prev, row, `name:${key}`);
    else entries.set(key, row);
  }
  return { entries, byId, conflicts: [...conflictMap.values()] };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    }),
  );
}

async function buildBridgeFromFolder(): Promise<void> {
  const cfg = mgmtSources().party_tm_map;
  buildState.phase = "listing member report folder tree";
  const files = await walkFolderTree(cfg.memberReportFolderId);
  buildState.filesSeen = 0;
  buildState.filesWithTabs = 0;
  buildState.phase = `scanning ${files.length} files for report tabs`;
  const collected: Array<BridgeEntry & { mtime?: string }> = [];
  await runWithConcurrency(files, 4, async (file) => {
    try {
      const tabs = await listSheetTabs(file.id);
      const distTab = tabs.find((t) =>
        normLabel(t.title).startsWith(DIST_TAB_PREFIX),
      );
      const retTab = tabs.find((t) =>
        normLabel(t.title).startsWith(RET_TAB_PREFIX),
      );
      if (distTab) {
        const rows = await readAllTabRows(file.id, distTab.title);
        for (const e of parseMemberTab(rows, "dist", file)) {
          collected.push({ ...e, mtime: file.modifiedTime });
        }
      }
      if (retTab) {
        const rows = await readAllTabRows(file.id, retTab.title);
        for (const e of parseMemberTab(rows, "ret", file)) {
          collected.push({ ...e, mtime: file.modifiedTime });
        }
      }
      if (distTab || retTab) buildState.filesWithTabs += 1;
    } catch (err) {
      logger.warn(
        { err, fileId: file.id, fileName: file.name },
        "party-tm bridge build: file skipped",
      );
    } finally {
      buildState.filesSeen += 1;
      if (buildState.filesSeen % 50 === 0) {
        logger.info(
          {
            filesSeen: buildState.filesSeen,
            filesTotal: files.length,
            filesWithTabs: buildState.filesWithTabs,
            rows: collected.length,
          },
          "party-tm bridge build progress",
        );
      }
    }
  });
  sortForPrecedence(collected);
  // Dedupe identical (type, party, member) rows across files.
  const seen = new Set<string>();
  const rows: BridgeEntry[] = [];
  for (const r of collected) {
    const key = `${r.partyType}|${r.partyId || `N:${normParty(r.partyName)}`}|${r.memberKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { mtime: _mtime, ...entry } = r;
    rows.push(entry);
  }
  if (rows.length === 0) {
    throw new Error(
      `No Distributor Visit / Retailer Report tabs with party rows were found across ${files.length} files in the member report folder.`,
    );
  }
  const { entries, byId, conflicts } = buildIndexes(rows);
  const members = new Set(rows.map((r) => r.memberKey)).size;
  const summary =
    `Auto-built from the member report folder: ${rows.length} party rows ` +
    `(${entries.size} distributor parties, ${members} team members, ` +
    `${conflicts.length} conflicts) from ${buildState.filesWithTabs} of ${files.length} files. ` +
    `Held in memory only (Sheets access is read-only; no cache sheet is written).`;
  buildState.summary = summary;
  cache = {
    status: "ok",
    detail: summary,
    entries,
    byId,
    rows,
    conflicts,
    loadedAt: Date.now(),
  };
  logger.info(
    {
      files: files.length,
      filesWithTabs: buildState.filesWithTabs,
      rows: rows.length,
      distributorParties: entries.size,
      members,
      conflicts: conflicts.length,
    },
    "party-tm bridge auto-build complete",
  );
}

// Starts the background auto-build unless one is already running. Returns
// whether a new build was started.
export function startBridgeBuild(): boolean {
  if (buildState.running) return false;
  buildState.running = true;
  buildState.startedAt = Date.now();
  buildState.lastAttemptAt = Date.now();
  buildState.finishedAt = null;
  buildState.error = null;
  buildState.summary = null;
  buildState.phase = "starting";
  buildState.filesSeen = 0;
  buildState.filesWithTabs = 0;
  void buildBridgeFromFolder()
    .catch((err) => {
      buildState.error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "party-tm bridge auto-build failed");
    })
    .finally(() => {
      buildState.running = false;
      buildState.finishedAt = Date.now();
      buildState.phase = "idle";
    });
  return true;
}

// ---------------------------------------------------------------------------
// Bridge sheet reading
// ---------------------------------------------------------------------------

type SheetCols = {
  party: number;
  member: number;
  head: number;
  type: number;
  id: number;
  channel: number;
  assigned: number;
  source: number;
};

// Header detection by content, supporting both the full schema this module
// writes and a hand-made legacy sheet (Party/Customer | Team Member | State
// Head), in any order/casing.
function detectBridgeColumns(row: SheetCellValue[]): SheetCols | null {
  const cols: SheetCols = {
    party: -1,
    member: -1,
    head: -1,
    type: -1,
    id: -1,
    channel: -1,
    assigned: -1,
    source: -1,
  };
  row.forEach((c, i) => {
    const label = normLabel(c);
    if (
      cols.party < 0 &&
      (label === "party" ||
        label === "customer" ||
        label === "partycustomer" ||
        label === "partyname")
    ) {
      cols.party = i;
    }
    if (
      cols.member < 0 &&
      (label === "teammember" || label === "teammembername" || label === "member")
    ) {
      cols.member = i;
    }
    if (cols.head < 0 && (label === "statehead" || label === "reportinghead")) {
      cols.head = i;
    }
    if (cols.type < 0 && label === "partytype") cols.type = i;
    if (cols.id < 0 && label === "partyid") cols.id = i;
    if (cols.channel < 0 && label === "channeltype") cols.channel = i;
    if (cols.assigned < 0 && label.startsWith("assigneddistributor")) {
      cols.assigned = i;
    }
    if (cols.source < 0 && label === "sourcefile") cols.source = i;
  });
  return cols.party >= 0 && cols.member >= 0 ? cols : null;
}

function parseBridgeSheetRows(rows: SheetCellValue[][]): BridgeEntry[] {
  let cols: SheetCols | null = null;
  const out: BridgeEntry[] = [];
  for (const r of rows) {
    if (!r) continue;
    if (!cols) {
      cols = detectBridgeColumns(r);
      continue;
    }
    const partyName = norm(r[cols.party]);
    const memberName = norm(r[cols.member]);
    if (!partyName || !memberName) continue;
    const typeRaw = cols.type >= 0 ? norm(r[cols.type]).toUpperCase() : "";
    const partyType: BridgeEntry["partyType"] =
      typeRaw === "RETAILER" ? "RETAILER" : "DISTRIBUTOR";
    const channelType = cols.channel >= 0 ? norm(r[cols.channel]) : "";
    out.push({
      partyType,
      partyId: cols.id >= 0 ? norm(r[cols.id]).toUpperCase() : "",
      partyName,
      memberName,
      memberKey: normName(memberName),
      stateHead: cols.head >= 0 ? norm(r[cols.head]) : "",
      channelType,
      assignedDistributor: cols.assigned >= 0 ? norm(r[cols.assigned]) : "",
      sourceFile: cols.source >= 0 ? norm(r[cols.source]) : "",
      authoritative: !channelType.toLowerCase().includes("via retailer"),
    });
  }
  return out;
}

function emptyBridge(
  status: PartyBridge["status"],
  detail: string,
  fileId?: string,
): PartyBridge {
  return {
    status,
    detail,
    fileId,
    entries: new Map(),
    byId: new Map(),
    rows: [],
    conflicts: [],
    loadedAt: Date.now(),
  };
}

function buildingDetail(): string {
  const s = buildState;
  return (
    `The Party TM Map is being auto-built from the member report folder ` +
    `(${s.phase}; ${s.filesSeen} files scanned, ${s.filesWithTabs} with report tabs). ` +
    `Per-member Sale stays blank until it finishes; regenerate the report in a few minutes.`
  );
}

async function loadUncached(): Promise<PartyBridge> {
  const sheetName = mgmtSources().party_tm_map.sheetName;
  let hit: { id: string; name: string } | null;
  try {
    hit = await findBridgeSheet();
  } catch (err) {
    const detail = `Could not search Drive for the "${sheetName}" bridge sheet: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err }, "party-tm bridge search failed");
    return emptyBridge("error", detail);
  }
  if (!hit) {
    if (buildState.running) {
      return emptyBridge("building", buildingDetail());
    }
    const failedRecently =
      buildState.error != null &&
      buildState.lastAttemptAt != null &&
      Date.now() - buildState.lastAttemptAt < BUILD_RETRY_MS;
    if (failedRecently) {
      return emptyBridge(
        "error",
        `No "${sheetName}" sheet exists and the last auto-build attempt failed: ` +
          `${buildState.error} It will be retried automatically, or trigger it now via POST /api/mgmt/bridge/rebuild.`,
      );
    }
    startBridgeBuild();
    logger.info("party-tm bridge sheet missing; auto-build started");
    return emptyBridge("building", buildingDetail());
  }
  try {
    const tabs = await listSheetTabs(hit.id);
    let rows: BridgeEntry[] = [];
    for (const tab of tabs) {
      rows = parseBridgeSheetRows(await readAllTabRows(hit.id, tab.title));
      if (rows.length > 0) break;
    }
    if (rows.length === 0) {
      return emptyBridge(
        "error",
        `The "${hit.name}" sheet (${hit.id}) was found but no header row with ` +
          `Party and Team Member columns was detected, so the bridge stays unused. ` +
          `Rebuild it via POST /api/mgmt/bridge/rebuild.`,
        hit.id,
      );
    }
    const { entries, byId, conflicts } = buildIndexes(rows);
    const members = new Set(rows.map((r) => r.memberKey)).size;
    logger.info(
      {
        fileId: hit.id,
        fileName: hit.name,
        rows: rows.length,
        distributorParties: entries.size,
        members,
        conflicts: conflicts.length,
      },
      "party-tm bridge sheet loaded",
    );
    return {
      status: "ok",
      detail:
        `"${hit.name}" bridge sheet loaded: ${rows.length} party rows, ` +
        `${entries.size} distributor parties across ${members} team members.`,
      fileId: hit.id,
      entries,
      byId,
      rows,
      conflicts,
      loadedAt: Date.now(),
    };
  } catch (err) {
    const detail = `Reading the "${hit.name}" bridge sheet (${hit.id}) failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err, fileId: hit.id }, "party-tm bridge read failed");
    return emptyBridge("error", detail, hit.id);
  }
}

export async function loadPartyBridge(): Promise<PartyBridge> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) {
    if (cache.status !== "building") return cache;
    // A finished build replaces the cache directly, so a cached "building"
    // status either just needs its progress detail refreshed, or (if the
    // build stopped without installing a result, i.e. it failed) a reload.
    if (buildState.running) return { ...cache, detail: buildingDetail() };
    cache = null;
  }
  if (inFlight) return inFlight;
  inFlight = loadUncached()
    .then((r) => {
      // Never clobber a fresher result installed by a finished build.
      if (!cache || cache.loadedAt <= r.loadedAt) cache = r;
      return cache;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidatePartyBridgeCache(): void {
  cache = null;
}
