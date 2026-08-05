// Reads per-member Distributor Visit Report files from a shared Drive folder
// to build a distributor-name → team-member mapping for primary-sales attribution.
//
// Each member's Google Spreadsheet in the folder has a "Distributor Visit Report"
// tab. The first few rows carry the Team Member Name (and optionally Reporting
// Manager / State Head). Below that is a table with at least a Name column and a
// Type column distinguishing "Distributor" from "Direct Dealer".
//
// We process files in batches of BATCH_SIZE concurrent requests to stay inside
// the Sheets API read-quota (300 RPM). The map is cached for TTL_MS. Because
// reading ~180 files takes ~30–60 seconds, the first call kicks off a background
// build and returns null immediately; callers should handle null gracefully.
//
// loadDistributorTmMap() returns the cached result (blocking if already warm).
// getDistributorTmMapIfReady() is non-blocking: returns the cache or null.

import {
  getGoogleAccessToken,
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normParty, normName, normSecKey } from "./names.js";
import { logger } from "../logger.js";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const MEMBER_FILES_FOLDER_ID = "1-guQptN9S4NrW024jGizKo0V4nFDtHMv";
const TTL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 10;

export type DistributorType = "Distributor" | "Direct Dealer";

export type DistributorEntry = {
  memberNormKey: string;
  memberName: string;
  type: DistributorType;
};

export type DistributorTmMap = {
  /** normalised distributor party key → first matched entry */
  byPartyKey: Map<string, DistributorEntry>;
  /** member normKey → number of distinct Distributors mapped to that member */
  distributorCountByMember: Map<string, number>;
  /** member normKey → number of distinct Direct Dealers mapped to that member */
  directDealerCountByMember: Map<string, number>;
  memberCount: number;
  totalDistributors: number;
  totalDirectDealers: number;
  /** Non-null when the build failed entirely */
  error: string | null;
};

let _cache: { ts: number; map: DistributorTmMap } | null = null;
let _building: Promise<DistributorTmMap> | null = null;

export function invalidateDistributorTmMapCache(): void {
  _cache = null;
}

/** Returns the cached map without blocking. Starts a background build if needed. */
export function getDistributorTmMapIfReady(): DistributorTmMap | null {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.map;
  if (!_building) {
    _building = buildMapUncached()
      .then((map) => {
        _cache = { ts: Date.now(), map };
        _building = null;
        return map;
      })
      .catch((err) => {
        logger.warn({ err }, "distributorTmMap: background build failed");
        _building = null;
        const empty: DistributorTmMap = {
          byPartyKey: new Map(),
          distributorCountByMember: new Map(),
          directDealerCountByMember: new Map(),
          memberCount: 0,
          totalDistributors: 0,
          totalDirectDealers: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        return empty;
      });
  }
  return null;
}

/** Blocking version: waits for a warm cache or a fresh build. */
export async function loadDistributorTmMap(): Promise<DistributorTmMap> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.map;
  if (_building) return _building;
  _building = buildMapUncached()
    .then((map) => {
      _cache = { ts: Date.now(), map };
      _building = null;
      return map;
    })
    .catch((err) => {
      _building = null;
      throw err;
    });
  return _building;
}

// ─── Drive folder listing ────────────────────────────────────────────────────

type DriveFile = { id: string; name: string };

async function driveGet(path: string): Promise<unknown> {
  const token = await getGoogleAccessToken();
  const res = await fetch(`${DRIVE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive API (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function listFolderSpreadsheets(folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const q = encodeURIComponent(
      `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    );
    const qs = `q=${q}&fields=nextPageToken,files(id,name)&pageSize=200${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
    }`;
    const data = (await driveGet(`/files?${qs}`)) as {
      nextPageToken?: string;
      files?: DriveFile[];
    };
    files.push(...(data.files ?? []));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return files;
}

// ─── Tab parsing ─────────────────────────────────────────────────────────────

function strVal(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function findCol(headers: SheetCellValue[], re: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (re.test(strVal(headers[i]))) return i;
  }
  return -1;
}

function classifyType(raw: string): DistributorType {
  const s = raw.toLowerCase().trim();
  if (/direct|^dd$|^d\.d\.?$/.test(s)) return "Direct Dealer";
  return "Distributor";
}

type ParsedFile = {
  memberName: string;
  entries: Array<{ partyKey: string; rawName: string; type: DistributorType }>;
};

async function parseMemberFile(
  fileId: string,
  fileName: string,
): Promise<ParsedFile | null> {
  let tabs: { title: string }[];
  try {
    tabs = await listSheetTabs(fileId);
  } catch {
    return null;
  }

  const tab = tabs.find(
    (t) => /distributor.*visit/i.test(t.title) || /visit.*report/i.test(t.title),
  );
  if (!tab) return null;

  let memberName = "";
  const entries: ParsedFile["entries"] = [];

  try {
    let nameColIdx = -1;
    let typeColIdx = -1;
    let headerFound = false;

    await readTabRowsChunked(fileId, tab.title, (rows, startRow) => {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const globalRow = startRow + ri;

        // Header area scan (rows 1–15): extract member name
        if (globalRow <= 15 && !headerFound) {
          for (let ci = 0; ci < row.length; ci++) {
            const cell = strVal(row[ci]);
            // "Team Member Name" label — value is in the next cell
            if (/team\s*member\s*name/i.test(cell)) {
              const next = strVal(row[ci + 1]);
              if (next && !/name/i.test(next)) memberName = next;
            }
            // "Name: Raj Kumar" inline format
            if (/^name\s*:/i.test(cell)) {
              memberName = cell.replace(/^name\s*:\s*/i, "").trim();
            }
          }
        }

        // Detect the data header row (within first 25 rows)
        if (!headerFound && globalRow <= 25) {
          const nIdx = findCol(row, /^(distributor|party|firm|dealer)?\s*name$/i);
          const tIdx = findCol(row, /^type$/i);
          if (nIdx >= 0 && tIdx >= 0) {
            nameColIdx = nIdx;
            typeColIdx = tIdx;
            headerFound = true;
            continue;
          }
        }

        if (!headerFound) continue;

        const rawName = strVal(row[nameColIdx]);
        if (!rawName) continue;
        const partyKey = normParty(rawName);
        if (!partyKey) continue;
        const rawType = strVal(row[typeColIdx]);
        entries.push({ partyKey, rawName, type: classifyType(rawType || "Distributor") });
      }
    });
  } catch {
    return null;
  }

  // Fallback member name from file name (trim common suffixes)
  if (!memberName) {
    memberName = fileName
      .replace(/[-–—].*$/u, "")
      .replace(/\.(xlsx?|gsheet)$/i, "")
      .trim();
  }

  if (!entries.length) return null;
  return { memberName, entries };
}

// ─── Map build ───────────────────────────────────────────────────────────────

async function buildMapUncached(): Promise<DistributorTmMap> {
  const makeEmpty = (error: string): DistributorTmMap => ({
    byPartyKey: new Map(),
    distributorCountByMember: new Map(),
    directDealerCountByMember: new Map(),
    memberCount: 0,
    totalDistributors: 0,
    totalDirectDealers: 0,
    error,
  });

  let files: DriveFile[];
  try {
    files = await listFolderSpreadsheets(MEMBER_FILES_FOLDER_ID);
    logger.info({ count: files.length }, "distributorTmMap: listed member files from Drive");
  } catch (err) {
    logger.warn({ err }, "distributorTmMap: failed to list Drive folder");
    return makeEmpty(err instanceof Error ? err.message : String(err));
  }

  if (files.length === 0) {
    return makeEmpty("No spreadsheet files found in the member-files Drive folder");
  }

  const byPartyKey = new Map<string, DistributorEntry>();
  const distCountByMember = new Map<string, number>();
  const ddCountByMember = new Map<string, number>();
  let memberCount = 0;
  let conflicts = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((f) => parseMemberFile(f.id, f.name)),
    );
    for (const res of results) {
      if (res.status !== "fulfilled" || !res.value) continue;
      const { memberName, entries } = res.value;
      const memberNormKey = normSecKey(memberName);
      if (!memberNormKey) continue;
      memberCount++;
      let dCount = 0;
      let ddCount = 0;
      for (const e of entries) {
        if (byPartyKey.has(e.partyKey)) {
          conflicts++;
        } else {
          byPartyKey.set(e.partyKey, { memberNormKey, memberName, type: e.type });
        }
        if (e.type === "Distributor") dCount++;
        else ddCount++;
      }
      distCountByMember.set(memberNormKey, (distCountByMember.get(memberNormKey) ?? 0) + dCount);
      ddCountByMember.set(memberNormKey, (ddCountByMember.get(memberNormKey) ?? 0) + ddCount);
    }
  }

  const totalDistributors = [...distCountByMember.values()].reduce((s, v) => s + v, 0);
  const totalDirectDealers = [...ddCountByMember.values()].reduce((s, v) => s + v, 0);
  logger.info(
    { memberCount, totalDistributors, totalDirectDealers, uniqueParties: byPartyKey.size, conflicts },
    "distributorTmMap: build complete",
  );

  return {
    byPartyKey,
    distributorCountByMember: distCountByMember,
    directDealerCountByMember: ddCountByMember,
    memberCount,
    totalDistributors,
    totalDirectDealers,
    error: null,
  };
}
