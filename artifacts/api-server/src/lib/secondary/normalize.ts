// Normalization layer for secondary sale registers.
// Mirrors the structure of lib/registers/normalize.ts for primary registers.
// Maps raw row cells to canonical heads/states/brands using the same config
// files used by the primary pipeline (normalize.json, head_alias.json).
import { createHash } from "node:crypto";
import type { InsertSecRegLine } from "@workspace/db";
import normalizeConfig from "../../../config/normalize.json";
// head_alias.json retired — alias and territory maps now come from person_registry DB table.
import {
  headAliasLookup as _registryAliasLookup,
  territoryHeads as _registryTerritoryHeads,
} from "../personRegistry.js";
import colMapsConfig from "../../../config/secondary_column_maps.json";
import type { CellValue, SecColMap, SecGrain, SecParsedRow, SecUnmappedReport } from "./types.js";
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

// Parse a discount percentage from a cell value.
// Handles:
//   number: 33.9 → 33.9
//   string "33.90 (%)": extract leading numeric part → 33.9
//   string "48": 48
//   blank / null: null
export function parseDiscountPct(v: CellValue): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  const m = String(v).match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
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
  // Apr(3)..Dec(11) -> first FY year; Jan(0)..Mar(2) -> second FY year
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
    // "Apr-25", "April 2025", "APR 2025", etc.
    const mName = s.match(/^([A-Z]{3,9})[\s\-./]*(\d{2,4})?$/);
    if (mName) {
      const word = mName[1];
      monthIdx = word.length === 3
        ? MONTH_INDEX.get(word)
        : FULL_MONTHS_MAP[word];
    } else {
      // Numeric date strings. Indian sheets use DD-MM-YYYY or DD/MM/YYYY.
      // YYYY-MM-DD (ISO) is also handled for completeness.
      // Ambiguity rule: if the first component > 12 it must be a day → DD-MM-YYYY.
      // If ≤ 12, assume DD-MM-YYYY (Indian convention).
      const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
      if (dmy) {
        // dmy[1]=DD dmy[2]=MM dmy[3]=YYYY
        monthIdx = parseInt(dmy[2], 10) - 1;
      } else {
        // YYYY-MM-DD
        const ymd = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (ymd) {
          monthIdx = parseInt(ymd[2], 10) - 1;
        }
      }
    }
  }
  if (monthIdx == null || monthIdx < 0 || monthIdx > 11) return null;
  return formatMonthLabel(fyYearForMonth(fy, monthIdx), monthIdx);
}

// ── Alias and normalisation maps ──────────────────────────────────────────────

// HEAD_ALIAS now sourced from person_registry DB table via _registryAliasLookup.
// It starts empty at module load and is populated by loadPersonRegistry() before
// any register ingest runs.
const HEAD_ALIAS = _registryAliasLookup;

const STATE_MAP: Map<string, string> = new Map(
  Object.entries(
    (normalizeConfig as { state_map: Record<string, string> }).state_map,
  ).map(([k, v]) => [k.toUpperCase().trim(), v]),
);

// ── Sub-total row detection ────────────────────────────────────────────────────
//
// Rows whose first five cells contain a known sub-total marker token are
// summary/aggregation rows that must NOT be parsed as data lines — doing so
// would double-count amounts. Applied to all FYs for safety.
//
// Tokens come from secondary_column_maps.json v1.sub_total_skip_tokens.
// They are already in normalised form (uppercase, non-alphanumeric stripped).

const SUB_TOTAL_SKIP_TOKENS = new Set<string>(
  (colMapsConfig.versions.v1 as { sub_total_skip_tokens: string[] })
    .sub_total_skip_tokens,
);

// Returns true when the row is a sub-total / grand-total summary row.
// Only the first five cells are scanned to avoid false positives on
// numeric amount or qty columns.
export function isSubTotalRow(cells: CellValue[]): boolean {
  const limit = Math.min(5, cells.length);
  for (let i = 0; i < limit; i++) {
    const n = normHeader(cells[i]);
    if (n && SUB_TOTAL_SKIP_TOKENS.has(n)) return true;
  }
  return false;
}

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
// Returns null when the mandatory gross_amount column cannot be found.
// grain is passed through from the FY config and stored on the SecColMap so
// downstream callers (loader, Gate 1 report) know the data grain for this FY.
export function mapSecColumns(
  values: CellValue[],
  headerRowNumber: number,
  mapVersion = "v1",
  grain: SecGrain = "line",
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

  const grossAmount = find(version.gross_amount);
  if (grossAmount < 0) return null; // gross_amount is the mandatory anchor

  return {
    headerRowNumber,
    grain,
    head: find(version.head),
    state: find(version.state),
    customer: find(version.customer),
    brand: find(version.brand),
    month: find(version.month),
    fy: find(version.fy),
    grossAmount,
    netAmount: find(version.net_amount),  // Sub Total column; -1 when absent
    discount: find(version.discount),
    qty: find(version.qty),
  };
}

// Scan the first maxRows rows for a header row.
// grain is threaded through so the returned SecColMap carries the FY's grain.
export function detectSecHeader(
  rows: CellValue[][],
  mapVersion = "v1",
  grain: SecGrain = "line",
  maxRows = 20,
): SecColMap | null {
  for (let i = 0; i < Math.min(maxRows, rows.length); i++) {
    if (isSecHeaderRow(rows[i])) {
      return mapSecColumns(rows[i], i + 1, mapVersion, grain); // row number is 1-indexed
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
  grossAmount: number,
  occurrence: number,
): string {
  const payload = [fy, monthLabel, headRaw ?? "", stateRaw ?? "",
    customer ?? "", brandRaw ?? "", String(grossAmount), String(occurrence)].join("|");
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
// TERRITORY_HEADS now sourced from person_registry DB table via _registryTerritoryHeads.
const TERRITORY_HEADS = _registryTerritoryHeads;
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
// Returns null for rows that have no gross_amount (header repeats, blank rows, etc.).
// Sub-total rows are detected upstream (isSubTotalRow) before this is called.
//
// discountPct in the returned row is the raw cell value (null when the cell is
// blank — typically continuation rows in FY2021-22 through FY2023-24).
// The caller (parseRows in loader.ts) carries the last non-null discountPct
// across order rows and backfills parsed.discountPct + parsed.netAmount.
export function parseSecRegisterRow(
  cells: CellValue[],
  cols: SecColMap,
  fy: string,
): SecParsedRow | null {
  const grossAmount = toNumber(cols.grossAmount >= 0 ? cells[cols.grossAmount] : null);
  if (grossAmount == null || !Number.isFinite(grossAmount)) return null;

  const rawMonth = cols.month >= 0 ? cells[cols.month] : null;
  const monthLabel = toMonthLabel(rawMonth, fy);
  if (!monthLabel) return null;

  // For subtotal-grain FYs, customer is expected to be null; the uid still
  // differentiates rows by head/month/brand/grossAmount/occurrence.
  const customer = (cols.grain === "subtotal" || cols.customer < 0)
    ? null
    : toText(cells[cols.customer]);

  // Discount: present on order-header rows; blank on continuation rows.
  // The loader carries the last non-null value across rows in the same order.
  const rawDiscount = cols.discount >= 0 ? cells[cols.discount] : null;
  const discountPct = parseDiscountPct(rawDiscount);

  // Read net amount directly from the Sub Total column when available.
  // Continuation rows (same order, subsequent SKUs) typically have a blank Sub
  // Total — toNumber returns null for those, and the loader's discount-carry
  // fills in a computed value as fallback.
  const netAmountFromSheet = cols.netAmount >= 0
    ? toNumber(cells[cols.netAmount])
    : null;

  return {
    fy,
    monthLabel,
    headRaw: cols.head >= 0 ? toText(cells[cols.head]) : null,
    stateRaw: cols.state >= 0 ? toText(cells[cols.state]) : null,
    customer,
    brandRaw: cols.brand >= 0 ? toText(cells[cols.brand]) : null,
    grossAmount,
    netAmount: netAmountFromSheet,  // null on continuation rows; loader fills via discount carry
    discountPct,                    // null when blank (continuation rows); loader carries
    qty: cols.qty >= 0 ? toNumber(cells[cols.qty]) : null,
  };
}

// Convert a SecParsedRow to an InsertSecRegLine, updating occurrence counter
// and unmapped report in place.
// The row's netAmount and discountPct must already be resolved by the loader
// before this is called.
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
    String(row.grossAmount),
  ].join("|");
  const occ = counter.next(naturalKey);

  return {
    lineUid: computeSecLineUid(
      row.fy, row.monthLabel,
      row.headRaw, row.stateRaw,
      row.customer, row.brandRaw,
      row.grossAmount, occ,
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
    grossAmount: String(row.grossAmount),
    netAmount: row.netAmount != null ? String(row.netAmount) : null,
    discountPct: row.discountPct != null ? String(row.discountPct) : null,
    qty: row.qty != null ? String(row.qty) : null,
    isTerritory: isTerritory(headCanon, row.stateRaw),
    source,
  };
}
