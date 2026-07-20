// Normalization layer for the invoice-line sale registers.
// All mapping rules live in config files (config/group_map.json,
// config/normalize.json) — never hard-code a mapping here.
import { createHash } from "node:crypto";
import type { InsertSaleLine } from "@workspace/db";
import groupMapConfig from "../../../config/group_map.json";
import normalizeConfig from "../../../config/normalize.json";
import headAliasConfigRaw from "../../../config/head_alias.json";

export type CellValue = string | number | boolean | Date | null | undefined;

// ---------------------------------------------------------------------------
// Header detection (spec section B): scan the first 20 rows; the header is the
// row where (CODE|ITEMCODE) AND (QTY|QUANTITY) AND AMOUNT all appear after
// upper().replace(/[^A-Z0-9]/g,'').
// ---------------------------------------------------------------------------

export function normHeader(v: CellValue): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export type RegisterColumns = {
  headerRowNumber: number;
  serialNo: number; // column A "Serial no"; -1 when absent
  invoiceNo: number;
  date: number;
  customer: number;
  code: number;
  color: number; // e.g. "WHITE", "IVORY"; -1 when absent
  month: number;
  qty: number;
  rate: number;
  amount: number;
  group: number;
  station: number;
  state: number;
  head: number;
  type: number;
  fy: number;
};

export function isHeaderRow(values: CellValue[]): boolean {
  const set = new Set(values.map(normHeader));
  return (
    (set.has("CODE") || set.has("ITEMCODE") || set.has("OLDERPCODE")) &&
    (set.has("QTY") || set.has("QUANTITY")) &&
    (set.has("AMOUNT") || set.has("TAXABLEVALUE"))
  );
}

export function mapRegisterColumns(
  values: CellValue[],
  headerRowNumber: number,
): RegisterColumns {
  const find = (...names: string[]): number => {
    for (const name of names) {
      const idx = values.findIndex((v) => normHeader(v) === name);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  // FY column: either literal "FY YEAR" or a header like "FY-2025-26".
  let fy = find("FYYEAR");
  if (fy < 0) {
    fy = values.findIndex((v) => /^FY\d{6}$/.test(normHeader(v)));
  }
  return {
    headerRowNumber,
    serialNo: find("SERIALNO", "SRNO", "SR", "SNO"),
    invoiceNo: find("INVOICENO", "DOCUMENTNO"),
    date: find("DATE"),
    customer: find("CUSTOMER", "CUSTOMERNAME"),
    code: find("CODE", "ITEMCODE", "OLDERPCODE"),
    color: find("COLOR", "COLOUR"),
    month: find("MONTH", "M0NTH"),
    qty: find("QTY", "QUANTITY"),
    rate: find("SALERATE", "RATE"),
    amount: find("AMOUNT", "TAXABLEVALUE"),
    group: find("GROUP"),
    station: find("STATION"),
    state: find("STATE"),
    head: find("STATEHEADA", "STATEHEAD"),
    type: find("TYPE", "MASTERGROUP"),
    fy,
  };
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function excelSerialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH_MS + Math.round(serial) * MS_PER_DAY);
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

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_INDEX = new Map<string, number>(
  MONTH_NAMES.map((m, i) => [m.toUpperCase(), i]),
);
const FULL_MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

export function formatMonthLabel(year: number, monthIdx: number): string {
  return `${MONTH_NAMES[monthIdx]}-${String(year % 100).padStart(2, "0")}`;
}

// Resolve the calendar year of a fiscal month from the FY label. Apr-Dec
// fall in the first FY year, Jan-Mar in the second.
function fyYearForMonth(fy: string, monthIdx: number): number {
  const startYear = Number(fy.slice(0, 4));
  return monthIdx >= 3 ? startYear : startYear + 1;
}

// Normalize a MONTH cell (excel serial, Date, "Apr-26", "APRIL", "Apr 2026",
// etc.) into the canonical 'Apr-26' label.
//
// IMPORTANT: only the month NAME is trusted from the cell. The year embedded
// in the cell is unreliable — the same FY-2024-25 block carries April rows
// stamped 2024 in one workbook and 2026 in another (sheet formulas re-stamp
// the current year). Since the FY is always known and a fiscal year contains
// each month exactly once, the year is derived from `fy`. This keeps line_uid
// stable across source files, which is what makes dedup work.
export function toMonthLabel(v: CellValue, fy: string | null): string | null {
  if (v == null || v === "") return null;
  let monthIdx: number | undefined;
  let cellYear: number | undefined;
  if (typeof v === "number") {
    const d = excelSerialToDate(v);
    monthIdx = d.getUTCMonth();
    cellYear = d.getUTCFullYear();
  } else if (v instanceof Date) {
    monthIdx = v.getUTCMonth();
    cellYear = v.getUTCFullYear();
  } else {
    const s = String(v).trim().toUpperCase();
    // "APR-26", "APR 26", "APR-2026", "APRIL-26"
    const m = s.match(/^([A-Z]{3,9})[\s\-./]*(\d{2,4})?$/);
    if (m) {
      const isValidName = m[1].length === 3 || FULL_MONTHS.includes(m[1]);
      monthIdx = isValidName ? MONTH_INDEX.get(m[1].slice(0, 3)) : undefined;
      if (m[2]) {
        cellYear = m[2].length === 4 ? Number(m[2]) : 2000 + Number(m[2]);
      }
    }
  }
  if (monthIdx == null) return null;
  if (fy) return formatMonthLabel(fyYearForMonth(fy, monthIdx), monthIdx);
  if (cellYear != null) return formatMonthLabel(cellYear, monthIdx);
  return null;
}

export function toIsoDate(v: CellValue): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    return excelSerialToDate(v).toISOString().slice(0, 10);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

// "FY-2026-27" / "FY 2026-27" / "2026-27" -> "2026-27"
export function normalizeFy(v: CellValue): string | null {
  const s = toText(v);
  if (!s) return null;
  const m = s.toUpperCase().match(/(\d{4})\s*-\s*(\d{2,4})/);
  if (!m) return null;
  const start = m[1];
  const end = m[2].slice(-2);
  return `${start}-${end}`;
}

// ---------------------------------------------------------------------------
// Canonical maps (loaded from config)
// ---------------------------------------------------------------------------

const groupLookup = new Map<string, string>();
for (const [canon, raws] of Object.entries(
  groupMapConfig as Record<string, string[]>,
)) {
  for (const raw of raws) groupLookup.set(raw.toUpperCase(), canon);
}

// Build alias map from raw uppercase key → canonical display name.
// Covers spelling variants (BIJJU→Biju C.O, SNADEEP JI→Sandeep Dadheech, etc.).
const headAliasLookup = new Map<string, string>(
  Object.entries(headAliasConfigRaw as Record<string, string>).map(
    ([raw, canon]) => [raw.toUpperCase().trim(), canon],
  ),
);

const territoryHeads = new Set(
  (normalizeConfig.territory_heads as string[]).map((h) => h.toUpperCase()),
);
const institutionalHeads = new Set(
  (normalizeConfig.institutional as string[]).map((h) => h.toUpperCase()),
);
export const NON_TERRITORY_BUCKET = normalizeConfig.non_territory_bucket as string;
const stateMap = new Map<string, string>(
  Object.entries(normalizeConfig.state_map as Record<string, string>).map(
    ([k, val]) => [k.toUpperCase(), val],
  ),
);
const stateChannelTokens = new Set(
  (normalizeConfig.state_channel_tokens as string[]).map((s) =>
    s.toUpperCase(),
  ),
);

export type UnmappedReport = {
  unmapped_groups: Record<string, number>;
  unmapped_heads: Record<string, number>;
  unmapped_states: Record<string, number>;
};

export function emptyUnmapped(): UnmappedReport {
  return { unmapped_groups: {}, unmapped_heads: {}, unmapped_states: {} };
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

export function canonGroup(
  raw: string | null,
  unmapped: UnmappedReport,
): string | null {
  if (raw == null) return null;
  const canon = groupLookup.get(raw.toUpperCase().trim());
  if (!canon) {
    bump(unmapped.unmapped_groups, raw);
    return null;
  }
  return canon;
}

export function canonHead(
  raw: string | null,
  unmapped: UnmappedReport,
): { headCanon: string | null; isTerritory: boolean | null } {
  if (raw == null) return { headCanon: null, isTerritory: null };
  const key = raw.toUpperCase().trim();
  if (territoryHeads.has(key)) {
    // Resolve through alias map first so variants like BIJJU → "Biju C.O" and
    // SNADEEP JI → "Sandeep Dadheech" always produce the canonical display name.
    return { headCanon: headAliasLookup.get(key) ?? titleCase(key), isTerritory: true };
  }
  if (institutionalHeads.has(key)) {
    return { headCanon: NON_TERRITORY_BUCKET, isTerritory: false };
  }
  bump(unmapped.unmapped_heads, raw);
  return { headCanon: null, isTerritory: null };
}

export function canonState(
  raw: string | null,
  unmapped: UnmappedReport,
): string | null {
  if (raw == null) return null;
  const key = raw.toUpperCase().trim();
  if (stateChannelTokens.has(key)) return NON_TERRITORY_BUCKET;
  const mapped = stateMap.get(key);
  if (mapped) return mapped;
  // Values already in canonical form (e.g. "WEST BENGAL", "KERALA") pass
  // through; anything unrecognizable is still a state name by construction.
  if (/^[A-Z][A-Z\s.&()-]*$/.test(key)) return key;
  bump(unmapped.unmapped_states, raw);
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Row parsing + line_uid
// ---------------------------------------------------------------------------

export type ParsedRegisterRow = {
  fy: string;
  serialNo: number | null; // source sheet column A; null when column absent
  invoiceNo: string | null;
  invoiceDate: string | null;
  monthLabel: string | null;
  customer: string | null;
  code: string;
  color: string | null; // e.g. "WHITE", "IVORY"; null when column absent
  qty: number | null;
  saleRate: number | null;
  amount: number;
  groupRaw: string | null;
  station: string | null;
  stateRaw: string | null;
  headRaw: string | null;
  typeRaw: string | null;
};

export type RowParseResult =
  | { kind: "row"; row: ParsedRegisterRow }
  | { kind: "empty" }
  | { kind: "invalid"; reason: string };

const at = (values: CellValue[], idx: number): CellValue =>
  idx >= 0 ? values[idx] : null;

export function parseRegisterRow(
  values: CellValue[],
  cols: RegisterColumns,
  fyOverride?: string,
): RowParseResult {
  const hasAny = values.some((v) => v != null && String(v).trim() !== "");
  if (!hasAny) return { kind: "empty" };

  // Order-register sheets have no FY column; fyOverride supplies the FY from
  // the sheet configuration. The column-derived value takes precedence when
  // present (for dual-FY workbooks where cross-year dedup matters).
  const fy = normalizeFy(at(values, cols.fy)) ?? fyOverride ?? null;
  if (!fy) {
    // Rows without an FY value in these workbooks are formatting residue —
    // verified to carry no amounts. Treat as empty, but re-check to be safe.
    const amount = toNumber(at(values, cols.amount));
    if (amount != null) {
      return { kind: "invalid", reason: "amount present but FY missing" };
    }
    return { kind: "empty" };
  }

  const code = toText(at(values, cols.code));
  const amount = toNumber(at(values, cols.amount));
  if (code == null || amount == null) {
    return {
      kind: "invalid",
      reason: code == null ? "missing item code" : "missing amount",
    };
  }

  return {
    kind: "row",
    row: {
      fy,
      serialNo: toNumber(at(values, cols.serialNo)),
      invoiceNo: toText(at(values, cols.invoiceNo)),
      invoiceDate: toIsoDate(at(values, cols.date)),
      monthLabel: toMonthLabel(at(values, cols.month), fy),
      customer: toText(at(values, cols.customer)),
      code,
      color: toText(at(values, cols.color)),
      qty: toNumber(at(values, cols.qty)),
      saleRate: toNumber(at(values, cols.rate)),
      amount,
      groupRaw: toText(at(values, cols.group)),
      station: toText(at(values, cols.station)),
      stateRaw: toText(at(values, cols.state)),
      headRaw: toText(at(values, cols.head)),
      typeRaw: toText(at(values, cols.type)),
    },
  };
}

// Deterministic occurrence counter so identical tuples get stable, distinct
// line_uids in source order (preserves the legitimate duplicate lines).
export class OccurrenceCounter {
  private counts = new Map<string, number>();

  next(key: string): number {
    const n = this.counts.get(key) ?? 0;
    this.counts.set(key, n + 1);
    return n;
  }
}

// NOTE: invoice_no is deliberately NOT part of the uid. The same FY block is
// exported with an invoice column in one workbook and without it in the next
// year's workbook, so including it would defeat cross-file dedup (the spec's
// 424,477-line acceptance requires those blocks to collapse). Legitimate
// duplicate lines are preserved by the occurrence counter, which depends only
// on the tuple itself, not on row order among identical tuples.
//
// When serial_no is present it is included in the key. Two colour variants of
// the same item on the same invoice share (code, qty, amount) but have distinct
// serial numbers, so including serial_no gives them distinct keys without
// needing the occurrence counter. For historical FYs without serial_no the key
// falls back to the original tuple and the occurrence counter disambiguates.
export function lineUidKey(row: ParsedRegisterRow): string {
  return [
    row.fy,
    row.code,
    row.qty ?? "",
    row.amount,
    row.monthLabel ?? "",
    row.serialNo ?? "",
  ].join("|");
}

export function computeLineUid(key: string, occurrence: number): string {
  return createHash("sha1").update(`${key}|${occurrence}`).digest("hex");
}

export function toSaleLine(
  row: ParsedRegisterRow,
  occurrence: OccurrenceCounter,
  unmapped: UnmappedReport,
  source: "sheets" | "xlsx_backfill",
): InsertSaleLine {
  const key = lineUidKey(row);
  const { headCanon, isTerritory } = canonHead(row.headRaw, unmapped);
  return {
    lineUid: computeLineUid(key, occurrence.next(key)),
    fy: row.fy,
    serialNo: row.serialNo,
    invoiceNo: row.invoiceNo,
    invoiceDate: row.invoiceDate,
    monthLabel: row.monthLabel,
    customer: row.customer,
    code: row.code,
    color: row.color,
    qty: row.qty == null ? null : String(row.qty),
    saleRate: row.saleRate == null ? null : String(row.saleRate),
    amount: String(row.amount),
    groupRaw: row.groupRaw,
    groupCanon: canonGroup(row.groupRaw, unmapped),
    station: row.station,
    stateRaw: row.stateRaw,
    stateCanon: canonState(row.stateRaw, unmapped),
    headRaw: row.headRaw,
    headCanon,
    isTerritory,
    typeRaw: row.typeRaw,
    source,
    versionStatus: "current",
  };
}
