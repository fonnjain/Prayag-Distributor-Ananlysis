// Authoritative GROUP -> canonical TYPE map, read live from the INDEX tab of
// the company's SALE COMPARISON workbook (never hardcoded). Used to classify
// order-booking segments; unmapped segments are surfaced in the report's
// source notes rather than silently bucketed.
//
// The order files label segments with product-line brand names ("CPVC
// DURALIFE", "SWR DRAINTECH") while the INDEX tab keys are item types ("CPVC
// PIPE", "SWR PIPE"). config/segment_alias.json translates brand line ->
// INDEX key; the INDEX tab stays the single authority for the final TYPE, so
// an alias pointing at a key the INDEX does not carry still counts as
// unmapped.
import segmentAliasJson from "../../../config/segment_alias.json";
import { readAllTabRows } from "../registers/sheetsApi.js";
import { mgmtSources } from "./roster.js";

export type GroupIndex = {
  map: Map<string, string>;
  loadedAt: number;
};

const TTL_MS = 15 * 60_000;
let cached: GroupIndex | null = null;

function norm(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function squash(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

let aliasCache: Map<string, string> | null = null;

// Squashed raw segment -> INDEX key (both sides config-driven). Statically
// imported so esbuild bundles it — a cwd-relative read breaks in production.
function segmentAlias(): Map<string, string> {
  if (!aliasCache) {
    const parsed = segmentAliasJson as Record<string, string>;
    aliasCache = new Map(
      Object.entries(parsed).map(([raw, key]) => [squash(raw), key]),
    );
  }
  return aliasCache;
}

export async function loadGroupIndex(): Promise<GroupIndex> {
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached;
  const cfg = mgmtSources().group_index;
  const rows = await readAllTabRows(cfg.sheetId, cfg.tab);
  const map = new Map<string, string>();
  // Columns A/B carry NEW TYPE -> TYPE (e.g. "PTMT" -> "PTMT GROUP").
  for (const r of rows) {
    const from = norm(r?.[0]);
    const to = norm(r?.[1]);
    if (!from || !to || from === "NEW TYPE") continue;
    if (!map.has(from)) map.set(from, to);
  }
  cached = { map, loadedAt: Date.now() };
  return cached;
}

export function canonicalGroup(index: GroupIndex, segment: string): string | null {
  const aliasKey = segmentAlias().get(squash(segment));
  const key = aliasKey ? norm(aliasKey) : norm(segment);
  if (!key) return null;
  const direct = index.map.get(key);
  if (direct) return direct;
  // Segments arrive like "C.P-CDA" — try the part before the first hyphen.
  const prefix = norm(segment.split("-")[0]);
  const byHyphen = index.map.get(prefix);
  if (byHyphen) return byHyphen;
  // Word-boundary prefix on the space-normalised label, longest key first:
  // "C P 5000 SERIES" matches key "C P" but "CPVC DURALIFE" does not.
  let best: string | null = null;
  let bestLen = -1;
  for (const [k, v] of index.map) {
    if (key.startsWith(`${k} `) && k.length > bestLen) {
      best = v;
      bestLen = k.length;
    }
  }
  if (best) return best;
  // Squashed prefix for keys of 4+ characters: "PTMTSYMET" starts with
  // "PTMT". Short keys like "CP" are excluded so "CPVC..." cannot mis-hit.
  const sq = squash(aliasKey ?? segment);
  for (const [k, v] of index.map) {
    const ks = squash(k);
    if (ks.length >= 4 && sq.startsWith(ks) && ks.length > bestLen) {
      best = v;
      bestLen = ks.length;
    }
  }
  return best;
}
