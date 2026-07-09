// Party -> Team Member bridge for the Sale side of the management report.
//
// The State-Head registers are tagged to State Head + Customer(party), not to
// a team member, so per-member Sale columns need a bridge. Priority order
// (per spec):
//   1. A consolidated "Party TM Map" sheet (cols Party/Customer | Team
//      Member | State Head). Searched in Drive on every (cached) load so it
//      wires itself up automatically the day the client creates it.
//   2. Derived from the per-member "Copy of <Name>" working files — verified
//      NOT viable: their Sale Report tabs list RETAILERS (RET# ids at the
//      retail grain), not the register's distributor parties, so any mapping
//      built from them would join the wrong grain.
//   3. No bridge: Sale fills at State-Head grain only, per-member Sale stays
//      blank, and the Missing Data tab says exactly why. Never guess an
//      allocation.
import { logger } from "../logger.js";
import {
  readAllTabRows,
  listSheetTabs,
  getGoogleAccessToken,
} from "../registers/sheetsApi.js";
import { normName } from "./names.js";
import { mgmtSources } from "./roster.js";

export type BridgeEntry = {
  memberName: string;
  memberKey: string;
  stateHead: string;
};

export type PartyBridge = {
  status: "ok" | "missing" | "error";
  detail: string;
  fileId?: string;
  // Register party (trimmed, uppercased) -> owning team member.
  entries: Map<string, BridgeEntry>;
  loadedAt: number;
};

const TTL_MS = 15 * 60_000;
let cache: PartyBridge | null = null;
let inFlight: Promise<PartyBridge> | null = null;

function norm(v: unknown): string {
  return String(v ?? "").trim();
}

async function findBridgeSheet(): Promise<{ id: string; name: string } | null> {
  const sheetName = mgmtSources().party_tm_map.sheetName;
  const token = await getGoogleAccessToken();
  const q = encodeURIComponent(
    `name contains '${sheetName}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive search failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    files?: Array<{ id: string; name: string }>;
  };
  return data.files?.[0] ?? null;
}

// Header detection by content: a row carrying a party column, a team-member
// column and (optionally) a state-head column, in any order/casing.
function detectBridgeColumns(
  row: unknown[],
): { party: number; member: number; head: number } | null {
  let party = -1;
  let member = -1;
  let head = -1;
  row.forEach((c, i) => {
    const label = String(c ?? "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (party < 0 && (label === "party" || label === "customer" || label === "partycustomer")) {
      party = i;
    }
    if (member < 0 && (label === "teammember" || label === "teammembername" || label === "member")) {
      member = i;
    }
    if (head < 0 && (label === "statehead" || label === "reportinghead")) head = i;
  });
  return party >= 0 && member >= 0 ? { party, member, head } : null;
}

async function loadUncached(): Promise<PartyBridge> {
  const sheetName = mgmtSources().party_tm_map.sheetName;
  let hit: { id: string; name: string } | null;
  try {
    hit = await findBridgeSheet();
  } catch (err) {
    const detail = `Could not search Drive for the "${sheetName}" bridge sheet: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err }, "party-tm bridge search failed");
    return { status: "error", detail, entries: new Map(), loadedAt: Date.now() };
  }
  if (!hit) {
    return {
      status: "missing",
      detail:
        `No consolidated "${sheetName}" sheet exists in Drive yet, and the per-member working ` +
        `files ("Copy of <Name>") list retailers (RET# ids), not the register's distributor ` +
        `parties, so no Party -> Team Member bridge can be derived. Until the sheet is created ` +
        `(columns: Party/Customer | Team Member | State Head), dispatched Sale is reported at ` +
        `State-Head grain only and per-member Sale stays blank.`,
      entries: new Map(),
      loadedAt: Date.now(),
    };
  }
  try {
    const tabs = await listSheetTabs(hit.id);
    const entries = new Map<string, BridgeEntry>();
    let cols: { party: number; member: number; head: number } | null = null;
    for (const tab of tabs) {
      const rows = await readAllTabRows(hit.id, tab.title);
      cols = null;
      for (const r of rows) {
        if (!r) continue;
        if (!cols) {
          cols = detectBridgeColumns(r);
          continue;
        }
        const party = norm(r[cols.party]).toUpperCase();
        const memberName = norm(r[cols.member]);
        if (!party || !memberName) continue;
        entries.set(party, {
          memberName,
          memberKey: normName(memberName),
          stateHead: cols.head >= 0 ? norm(r[cols.head]) : "",
        });
      }
      if (entries.size > 0) break;
    }
    if (entries.size === 0) {
      return {
        status: "error",
        detail:
          `The "${hit.name}" sheet (${hit.id}) was found but no header row with ` +
          `Party/Customer and Team Member columns was detected, so the bridge stays unused.`,
        fileId: hit.id,
        entries,
        loadedAt: Date.now(),
      };
    }
    logger.info(
      { fileId: hit.id, fileName: hit.name, parties: entries.size },
      "party-tm bridge sheet loaded",
    );
    return {
      status: "ok",
      detail: `"${hit.name}" bridge sheet loaded: ${entries.size} parties mapped.`,
      fileId: hit.id,
      entries,
      loadedAt: Date.now(),
    };
  } catch (err) {
    const detail = `Reading the "${hit.name}" bridge sheet (${hit.id}) failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err, fileId: hit.id }, "party-tm bridge read failed");
    return {
      status: "error",
      detail,
      fileId: hit.id,
      entries: new Map(),
      loadedAt: Date.now(),
    };
  }
}

export async function loadPartyBridge(): Promise<PartyBridge> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = loadUncached()
    .then((r) => {
      cache = r;
      return r;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidatePartyBridgeCache(): void {
  cache = null;
}
