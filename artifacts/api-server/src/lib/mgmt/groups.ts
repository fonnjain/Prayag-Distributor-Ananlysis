// Authoritative GROUP -> canonical TYPE map, read live from the INDEX tab of
// the company's SALE COMPARISON workbook (never hardcoded). Used to classify
// order-booking segments; unmapped segments are surfaced in the report's
// source notes rather than silently bucketed.
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
  const key = norm(segment);
  if (!key) return null;
  const direct = index.map.get(key);
  if (direct) return direct;
  // Segments arrive like "C.P-CDA" — try the part before the first hyphen.
  const prefix = norm(segment.split("-")[0]);
  return index.map.get(prefix) ?? null;
}
