/**
 * Shared member-sheet resolver — THE single service that answers, for any
 * member or state-head team: who is on the roster, are they LEFT, and which
 * Google working sheet (if any) is mapped to them.
 *
 * The mapping itself is the statically-bundled config/member_sheet_map.json
 * (normSecKey(member name) → Google file ID). It has NEVER lived in a
 * database — dev and production both ship it inside the esbuild bundle.
 *
 * Every consumer that previously imported the JSON directly, or re-implemented
 * the lookup, must go through this module:
 *   - memberSheet.ts        (sheet loader)
 *   - deepDiveData.ts       (Sales Deep Dive, via memberSheet)
 *   - distributorDeepDive.ts (Distributor Deep Dive, via memberSheet)
 *   - aiPayload.ts          (AI payload / Warning System)
 *   - routes/warnings.ts    (via aiPayload)
 *   - routes/aiArtifacts.ts (report generator)
 *   - comparison/cohort.ts  (comparison API "sheetMapped" cohort)
 *   - graph/graphIndex.ts, graph/resolvers.ts (metrics graph)
 *   - retailerDrift.ts
 */

import memberSheetMapRaw from "../../../config/member_sheet_map.json" assert { type: "json" };
import { loadRoster, type RosterMember } from "./roster.js";

/** normSecKey duplicated here (identical to deepDiveData.normSecKey) to keep
 *  this module dependency-free of the heavy deep-dive loaders. */
export function normMemberKey(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** member normSecKey → Google Sheets file ID (config-bundled, read-only). */
export const MEMBER_FILE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(memberSheetMapRaw as Record<string, string>).filter(
    ([k]) => k !== "_comment",
  ),
);

/** Resolve a member's working-sheet file ID. Accepts a display name or an
 *  already-normalised key. Returns null when no sheet is mapped. */
export function resolveMemberFileId(nameOrKey: string): string | null {
  const direct = MEMBER_FILE_MAP[nameOrKey];
  if (direct) return direct;
  return MEMBER_FILE_MAP[normMemberKey(nameOrKey)] ?? null;
}

export type ResolvedMember = {
  name: string;
  normKey: string;
  stateHead: string;
  state: string;
  isLeft: boolean;
  /** Mapped working-sheet file ID, or null when the member has no sheet. */
  fileId: string | null;
};

/** Roster + LEFT status + mapped sheet for one head (or every head). */
export async function resolveTeam(stateHead?: string): Promise<ResolvedMember[]> {
  const roster = await loadRoster();
  const want = stateHead ? stateHead.trim().toLowerCase() : null;
  const out: ResolvedMember[] = [];
  for (const m of roster.members) {
    if (want && m.stateHead.trim().toLowerCase() !== want) continue;
    out.push(toResolved(m));
  }
  return out;
}

function toResolved(m: RosterMember): ResolvedMember {
  const normKey = m.normKey || normMemberKey(m.name);
  return {
    name: m.name,
    normKey,
    stateHead: m.stateHead,
    state: m.state,
    isLeft: (m.activeLeft ?? "").toUpperCase().includes("LEFT"),
    fileId: MEMBER_FILE_MAP[normKey] ?? null,
  };
}

export type HeadCoverage = {
  stateHead: string;
  members: number;
  withSheet: number;
  withoutSheet: string[];
  /** Only populated when includeLeft=true: unmapped names with LEFT status. */
  withoutSheetDetail?: { name: string; state: string; isLeft: boolean }[];
};

/** Per-head members-with-a-mapped-working-sheet counts (acceptance metric).
 *  By default LEFT members are excluded; pass includeLeft to count everyone. */
export async function coverageByHead(includeLeft = false): Promise<HeadCoverage[]> {
  const team = await resolveTeam();
  const byHead = new Map<string, HeadCoverage>();
  for (const m of team) {
    if (m.isLeft && !includeLeft) continue;
    let c = byHead.get(m.stateHead);
    if (!c) {
      c = { stateHead: m.stateHead, members: 0, withSheet: 0, withoutSheet: [] };
      byHead.set(m.stateHead, c);
    }
    c.members++;
    if (m.fileId) c.withSheet++;
    else {
      c.withoutSheet.push(m.name);
      if (includeLeft) {
        (c.withoutSheetDetail ??= []).push({ name: m.name, state: m.state, isLeft: m.isLeft });
      }
    }
  }
  return [...byHead.values()].sort((a, b) => a.stateHead.localeCompare(b.stateHead));
}

/** Back-compat signature (undefined instead of null) for existing callers. */
export function getMemberFileId(normKey: string): string | undefined {
  return MEMBER_FILE_MAP[normKey];
}
