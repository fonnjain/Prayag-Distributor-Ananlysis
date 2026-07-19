// Normalization layer for secondary sale registers.
// Mirrors the structure of lib/registers/normalize.ts for primary registers.
// Maps raw row cells to canonical heads/states/brands using the same config
// files used by the primary pipeline (normalize.json, head_alias.json).
import { createHash } from "node:crypto";
import type { InsertSecRegLine } from "@workspace/db";
import normalizeConfig from "../../../config/normalize.json";
import headAliasConfigRaw from "../../../config/head_alias.json";
import colMapsConfig from "../../../config/secondary_column_maps.json";
import type { CellValue, SecColMap, SecParsedRow, SecUnmappedReport } from "./types.js";
import { bumpSecUnmapped } from "./types.js";

// ── Shared helpers (mirror primary normalize) ─────────────────────────────────

export function normHeader(v: CellValue): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function toNumber(v: CellValue): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export function toText(v: CellValue): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const MONTH_NAMES_3 = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];
const MONTH_INDEX = new Map<string, number>(
  MONTH_NAMES_3.map((m, i) => [m.toUpperCase(), i]),
);
const FULL_MONTHS_MAP: Record<string, number> = {
  JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
  JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
};

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

function excelSerialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial) * MS_PER_DAY);
}

export function formatMonthLabel(year: number, monthIdx: number): string {
  return `${MONTH_NAMES_3[monthIdx]}-${String(year % 100).padStart(2, "0")}`;
}

function fyYearForMonth(fy: string, monthIdx: number): number {
  const startYear = Number(fy.slice(0, 4));
  // Apr(3)..Dec(11) → first FY year; Jan(0)..Mar(2) → second FY year
  return monthIdx >= 3 ? startYear : startYear + 1;
}

export function toMonthLabel(v: CellValue, fy: string): string | null {
  if (v == null || v === "") return null;
  let monthIdx: number | undefined;
  if (typeof v === "number") {
    monthIdx = excelSerialToDate(v).getUTCMonth();
  } else if (v instanceof Date) {
    monthIdx = v.getUTCMonth();
  } else {
    const s = String(v).trim().toUpperCase();
    const m = s.match(/^([A-Z]{3,9})[\s\-./]*(\d{2,4})?$/);
    if (m) {
      const word = m[1];
      monthIdx = word.length === 3
        ? MONTH_INDEX.get(word)
        : FULL_MONTHS_MAP[word];
    }
  }
  if (monthIdx == null) return null;
  return formatMonthLabel(fyYearForMonth(fy, monthIdx), monthIdx);
}

// ── Alias and normalisation maps ──────────────────────────────────────────────

const headAliasConfig = headAliasConfigRaw as Record<string, string>;

// Build a name→canon map from head_alias.json (raw → canonical) and
// normalize.json territory_heads (canonical list).
const HEAD_ALIAS: Map<string, string> = new Map();
for (const [raw, canon] of Object.entries(headAliasConfig)) {
  HEAD_ALIAS.set(raw.toUpperCase().trim(), canon);
}

const STATE_MAP: Map<string, string> = new Map(
  Object.entries(
    (normalizeConfig as { state_map: Record<string, string> }).state_map,
  ).map(([k, v]) => [k.toUpperCase().trim(), v]),
);

// ── Column detection ──────────────────────────────────────────────────────────

// Anchor tokens that must appear in a header row for a secondary register.
// The 'v1' version (all years so far) requires at least one of these.
const ANCHOR_TOKENS = new Set(
  (colMapsConfig.versions.v1 as { header_anchor_tokens: string[] })
    .header_anchor_tokens,
);

function isSecHeaderRow(values: CellValue[]): boolean {
  const normed = new Set(values.map(normHeader));
  return [...ANCHOR_TOKENS].some((t) => normed.has(t));
}

// Map a header row to column indices using the v1 column map config.
// Returns null when required columns (amount) cannot be found.
export function mapSecColumns(
  values: CellValue[],
  headerRowNumber: number,
  mapVersion = "v1",
): SecColMap | null {
  const version = (colMapsConfig.versions as Record<string, Record<string, unknown>>)[mapVersion];
  if (!version) return null;

  const find = (tokens: unknown): number => {
    if (!Array.isArray(tokens)) return -1;
    for (const token of tokens as string[]) {
      const t = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const idx = values.findIndex((v) => normHeader(v) === t);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const amount = find(version.amount);
  if (amount < 0) return null; // amount is the mandatory anchor

  return {
    headerRowNumber,
    head: find(version.head),
    state: find(version.state),
    customer: find(version.customer),
    brand: find(version.brand),
    month: find(version.month),
    fy: find(version.fy),
    amount,
    qty: find(version.qty),
  };
}

// Scan the first maxRows rows for a header row.
export function detectSecHeader(
  rows: CellValue[][],
  mapVersion = "v1",
  maxRows = 20,
): SecColMap | null {
  for (let i = 0; i < Math.min(maxRows, rows.length); i++) {
    if (isSecHeaderRow(rows[i])) {
      return mapSecColumns(rows[i], i + 1, mapVersion); // row number is 1-indexed
    }
  }
  return null;
}

// ── Occurrence counter ────────────────────────────────────────────────────────
// Identical pattern to primary normalize.ts: preserves legitimate duplicate
// lines while still deduplicating true double-reads.

export class SecOccurrenceCounter {
  private counts = new Map<string, number>();

  next(key: string): number {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
}

// ── line_uid generation ───────────────────────────────────────────────────────

export function computeSecLineUid(
  fy: string,
  monthLabel: string,
  headRaw: string | null,
  stateRaw: string | null,
  customer: string | null,
  brandRaw: string | null,
  amount: number,
  occurrence: number,
): string {
  const payload = [fy, monthLabel, headRaw ?? "", stateRaw ?? "",
    customer ?? "", brandRaw ?? "", String(amount), String(occurrence)].join("|");
  return createHash("sha1").update(payload).digest("hex");
}

// ── Canonical mapping ─────────────────────────────────────────────────────────

export function canonHead(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.toUpperCase().trim();
  return HEAD_ALIAS.get(key) ?? null;
}

export function canonState(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.toUpperCase().trim();
  return STATE_MAP.get(key) ?? key; // pass-through if not in state_map
}

// Brand canonicalization is intentionally minimal for now: trim + upper.
// A brand alias config can be added to secondary_column_maps.json later.
export function canonBrand(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  return s === "" ? null : s.toUpperCase();
}

// Classify territory: a row is territorial when headCanon is in the territory
// list AND the state does not contain channel tokens (PROJECT, GOVT, OTHER).
const TERRITORY_HEADS = new Set<string>(
  (normalizeConfig as { territory_heads: string[] }).territory_heads.map(
    (h) => h.toUpperCase().trim(),
  ),
);
const CHANNEL_TOKENS = new Set<string>(
  (
    normalizeConfig as { state_channel_tokens: string[] }
  ).state_channel_tokens.map((t) => t.toUpperCase()),
);

export function isTerritory(headCanon: string | null, stateRaw: string | null): boolean {
  if (!headCanon) return false;
  if (TERRITORY_HEADS.has(headCanon.toUpperCase().trim())) {
    const su = (stateRaw ?? "").toUpperCase();
    return ![...CHANNEL_TOKENS].some((t) => su.includes(t));
  }
  return false;
}

// ── Row parsing ───────────────────────────────────────────────────────────────

// Parse one raw register row into a SecParsedRow.
// Returns null for rows that have no amount (header repeats, blank rows, etc.).
export function parseSecRegisterRow(
  cells: CellValue[],
  cols: SecColMap,
  fy: string,
): SecParsedRow | null {
  const amount = toNumber(cols.amount >= 0 ? cells[cols.amount] : null);
  if (amount == null || !Number.isFinite(amount)) return null;

  const rawMonth = cols.month >= 0 ? cells[cols.month] : null;
  const monthLabel = toMonthLabel(rawMonth, fy);
  if (!monthLabel) return null;

  return {
    fy,
    monthLabel,
    headRaw: cols.head >= 0 ? toText(cells[cols.head]) : null,
    stateRaw: cols.state >= 0 ? toText(cells[cols.state]) : null,
    customer: cols.customer >= 0 ? toText(cells[cols.customer]) : null,
    brandRaw: cols.brand >= 0 ? toText(cells[cols.brand]) : null,
    amount,
    qty: cols.qty >= 0 ? toNumber(cells[cols.qty]) : null,
  };
}

// Convert a SecParsedRow to an InsertSecRegLine, updating occurrence counter
// and unmapped report in place.
export function toSecRegLine(
  row: SecParsedRow,
  counter: SecOccurrenceCounter,
  unmapped: SecUnmappedReport,
  source: "sheets" | "xlsx_backfill",
): InsertSecRegLine {
  const headCanon = canonHead(row.headRaw);
  const stateCanon = canonState(row.stateRaw);
  const brandCanon = canonBrand(row.brandRaw);

  if (row.headRaw && !headCanon) bumpSecUnmapped(unmapped, "unmapped_heads", row.headRaw);
  if (row.stateRaw && !stateCanon) bumpSecUnmapped(unmapped, "unmapped_states", row.stateRaw);

  const naturalKey = [
    row.fy, row.monthLabel,
    row.headRaw ?? "", row.stateRaw ?? "",
    row.customer ?? "", row.brandRaw ?? "",
    String(row.amount),
  ].join("|");
  const occ = counter.next(naturalKey);

  return {
    lineUid: computeSecLineUid(
      row.fy, row.monthLabel,
      row.headRaw, row.stateRaw,
      row.customer, row.brandRaw,
      row.amount, occ,
    ),
    fy: row.fy,
    monthLabel: row.monthLabel,
    headRaw: row.headRaw,
    headCanon,
    stateRaw: row.stateRaw,
    stateCanon,
    customer: row.customer,
    brandRaw: row.brandRaw,
    brandCanon,
    amount: String(row.amount),
    qty: row.qty != null ? String(row.qty) : null,
    isTerritory: isTerritory(headCanon, row.stateRaw),
    source,
  };
}
