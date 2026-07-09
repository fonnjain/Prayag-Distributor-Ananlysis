// Target Master read/write + pro-rata split logic.
//
// This is the ONLY module in the app that writes to Google Sheets, and it
// writes to exactly one spreadsheet: config mgmt_sources.target_master. The
// sheet id is registered with the sheetsApi write allowlist here; every other
// sheet stays read-only by construction.
//
// Sheet schema (tab "targets", one row per fy x team_member):
//   fy | team_member | state_head | level |
//   primary_target_annual | secondary_target_annual |
//   direct_dealer_target_annual | business_plan_annual |
//   4 x 12 monthly override cells (Apr..Mar, blank = auto-split) |
//   updated_by | updated_at
import {
  readAllTabRows,
  registerWritableSheet,
  updateValuesBatch,
  appendValues,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normName, priorFy } from "./names.js";
import { loadRoster, mgmtSources, type RosterMember } from "./roster.js";
import { loadOrderFile } from "./orders.js";

export const TARGET_FIELDS = [
  "primary",
  "secondary",
  "directDealer",
  "businessPlan",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

export type FieldValues = Record<TargetField, number | null>;
export type FieldMonthly = Record<TargetField, Array<number | null>>;

export type TargetRow = {
  fy: string;
  teamMember: string;
  stateHead: string;
  level: "TM" | "STATE_HEAD";
  annual: FieldValues;
  monthly: FieldMonthly;
  updatedBy: string;
  updatedAt: string;
};

type StoredRow = TargetRow & { sheetRow: number };

const NUM_COLS = 58;
const LAST_COL = "BF"; // column 58

function emptyAnnual(): FieldValues {
  return { primary: null, secondary: null, directDealer: null, businessPlan: null };
}

function emptyMonthly(): FieldMonthly {
  return {
    primary: Array(12).fill(null),
    secondary: Array(12).fill(null),
    directDealer: Array(12).fill(null),
    businessPlan: Array(12).fill(null),
  };
}

function cellNum(v: SheetCellValue | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function cellStr(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function targetSheet(): { sheetId: string; tab: string } {
  const cfg = mgmtSources().target_master;
  registerWritableSheet(cfg.sheetId);
  return { sheetId: cfg.sheetId, tab: cfg.tab };
}

function rowKey(fy: string, teamMember: string): string {
  return `${fy}|${normName(teamMember)}`;
}

// Annual cols 5-8, then 4 monthly blocks of 12, then updated_by/updated_at.
function parseRow(r: SheetCellValue[], sheetRow: number): StoredRow | null {
  const fy = cellStr(r[0]);
  const teamMember = cellStr(r[1]);
  if (!fy || !teamMember) return null;
  const annual = emptyAnnual();
  const monthly = emptyMonthly();
  TARGET_FIELDS.forEach((f, fi) => {
    annual[f] = cellNum(r[4 + fi]);
    for (let m = 0; m < 12; m++) {
      monthly[f][m] = cellNum(r[8 + fi * 12 + m]);
    }
  });
  const levelRaw = cellStr(r[3]).toUpperCase();
  return {
    fy,
    teamMember,
    stateHead: cellStr(r[2]),
    level: levelRaw === "STATE_HEAD" ? "STATE_HEAD" : "TM",
    annual,
    monthly,
    updatedBy: cellStr(r[56]),
    updatedAt: cellStr(r[57]),
    sheetRow,
  };
}

function serializeRow(row: TargetRow): SheetCellValue[] {
  const out: SheetCellValue[] = Array(NUM_COLS).fill("");
  out[0] = row.fy;
  out[1] = row.teamMember;
  out[2] = row.stateHead;
  out[3] = row.level;
  TARGET_FIELDS.forEach((f, fi) => {
    out[4 + fi] = row.annual[f] ?? "";
    for (let m = 0; m < 12; m++) {
      out[8 + fi * 12 + m] = row.monthly[f][m] ?? "";
    }
  });
  out[56] = row.updatedBy;
  out[57] = row.updatedAt;
  return out;
}

// Reads the whole targets tab. Small sheet (hundreds of rows), no cache: the
// tab is the write target and staleness after a save would be confusing.
async function loadStoredRows(): Promise<StoredRow[]> {
  const { sheetId, tab } = targetSheet();
  const rows = await readAllTabRows(sheetId, tab);
  const out: StoredRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseRow(rows[i] ?? [], i + 1);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function loadTargetsForFy(fy: string): Promise<Map<string, TargetRow>> {
  const stored = await loadStoredRows();
  const map = new Map<string, TargetRow>();
  for (const row of stored) {
    if (row.fy === fy) map.set(normName(row.teamMember), row);
  }
  return map;
}

// --- Validation -----------------------------------------------------------

// Monthly overrides (plus annual/12 auto-split for blank cells) must sum back
// to the annual figure within a small tolerance.
export function monthlyReconcileError(
  field: TargetField,
  annual: number | null,
  monthly: Array<number | null>,
): string | null {
  const overrides = monthly.filter((v): v is number => v != null);
  if (overrides.length === 0) return null;
  if (annual == null) {
    return `${field}: monthly values need an annual figure to reconcile against`;
  }
  const blanks = 12 - overrides.length;
  const implied =
    overrides.reduce((a, b) => a + b, 0) + blanks * (annual / 12);
  const tolerance = Math.max(12, Math.abs(annual) * 0.001);
  if (Math.abs(implied - annual) > tolerance) {
    return `${field}: monthly values total ${Math.round(implied).toLocaleString("en-IN")} but the annual target is ${Math.round(annual).toLocaleString("en-IN")}`;
  }
  return null;
}

export function validateRow(
  row: TargetRow,
  rosterKeys: Set<string>,
): string[] {
  const errors: string[] = [];
  if (!rosterKeys.has(normName(row.teamMember))) {
    errors.push(`"${row.teamMember}" is not in the roster`);
  }
  for (const f of TARGET_FIELDS) {
    const a = row.annual[f];
    if (a != null && (!Number.isFinite(a) || a < 0)) {
      errors.push(`${row.teamMember}: ${f} annual must be a number >= 0`);
    }
    for (const v of row.monthly[f]) {
      if (v != null && (!Number.isFinite(v) || v < 0)) {
        errors.push(`${row.teamMember}: ${f} monthly values must be numbers >= 0`);
        break;
      }
    }
    const rec = monthlyReconcileError(f, a, row.monthly[f]);
    if (rec) errors.push(`${row.teamMember}: ${rec}`);
  }
  return errors;
}

// --- Upsert ----------------------------------------------------------------

// Serializes saves within this process so two concurrent requests cannot both
// miss an existing row and append duplicates. The row map is re-read inside
// the lock, immediately before writing, and if duplicate rows for the same
// (fy, team member) key already exist in the sheet, every duplicate is
// overwritten with the same values so no stale copy survives.
let upsertLock: Promise<unknown> = Promise.resolve();

export async function upsertTargets(rows: TargetRow[]): Promise<{ updated: number; appended: number }> {
  const run = upsertLock.then(() => doUpsertTargets(rows));
  upsertLock = run.catch(() => undefined);
  return run;
}

async function doUpsertTargets(rows: TargetRow[]): Promise<{ updated: number; appended: number }> {
  const { sheetId, tab } = targetSheet();
  const stored = await loadStoredRows();
  const byKey = new Map<string, StoredRow[]>();
  for (const s of stored) {
    const key = rowKey(s.fy, s.teamMember);
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }

  const updates: Array<{ range: string; values: SheetCellValue[][] }> = [];
  const appendRows: SheetCellValue[][] = [];
  let updated = 0;
  for (const row of rows) {
    const existing = byKey.get(rowKey(row.fy, row.teamMember)) ?? [];
    const values = [serializeRow(row)];
    if (existing.length > 0) {
      for (const e of existing) {
        updates.push({ range: `'${tab}'!A${e.sheetRow}:${LAST_COL}${e.sheetRow}`, values });
      }
      updated += 1;
    } else {
      appendRows.push(values[0]);
    }
  }
  await updateValuesBatch(sheetId, updates);
  await appendValues(sheetId, tab, appendRows);
  return { updated, appended: appendRows.length };
}

// --- Pro-rata split ---------------------------------------------------------

export type SplitMember = {
  name: string;
  priorYearActual: number;
  weights: Record<TargetField, number>;
  allocated: FieldValues;
};

// Splits state-head totals across that head's members pro-rata by prior-FY
// order actuals. Members with no prior data fall back to an equal split: each
// gets an equal per-capita share (total / member count), and the remainder is
// allocated pro-rata among the members that do have prior-year actuals.
export function computeSplit(
  members: Array<{ name: string; priorYearActual: number }>,
  totals: FieldValues,
): Array<{ name: string; allocated: FieldValues }> {
  const n = members.length;
  const withData = members.filter((m) => m.priorYearActual > 0);
  const noData = n - withData.length;
  const actualSum = withData.reduce((a, m) => a + m.priorYearActual, 0);

  const shareOf = (m: { priorYearActual: number }): number => {
    if (n === 0) return 0;
    if (withData.length === 0 || actualSum <= 0) return 1 / n;
    const perCapita = 1 / n;
    if (m.priorYearActual <= 0) return perCapita;
    const proRataPool = 1 - perCapita * noData;
    return proRataPool * (m.priorYearActual / actualSum);
  };

  return members.map((m) => {
    const share = shareOf(m);
    const allocated = emptyAnnual();
    for (const f of TARGET_FIELDS) {
      const total = totals[f];
      allocated[f] = total == null ? null : Math.round(total * share);
    }
    return { name: m.name, allocated };
  });
}

// Fixes rounding drift so allocations sum exactly to the entered total: the
// largest allocation absorbs the remainder.
export function balanceSplit(
  split: Array<{ name: string; allocated: FieldValues }>,
  totals: FieldValues,
): void {
  for (const f of TARGET_FIELDS) {
    const total = totals[f];
    if (total == null || split.length === 0) continue;
    const sum = split.reduce((a, s) => a + (s.allocated[f] ?? 0), 0);
    const drift = Math.round(total) - sum;
    if (drift === 0) continue;
    let maxIdx = 0;
    for (let i = 1; i < split.length; i++) {
      if ((split[i].allocated[f] ?? 0) > (split[maxIdx].allocated[f] ?? 0)) maxIdx = i;
    }
    split[maxIdx].allocated[f] = (split[maxIdx].allocated[f] ?? 0) + drift;
  }
}

// --- Assembly for the GET endpoint ------------------------------------------

export type TargetsMember = {
  name: string;
  stateHead: string;
  state: string;
  headquarter: string;
  priorYearActual: number;
  saved: TargetRow | null;
};

export async function priorYearActuals(fy: string): Promise<Map<string, number>> {
  const prior = await loadOrderFile(priorFy(fy));
  const map = new Map<string, number>();
  if (!prior) return map;
  for (const [key, agg] of prior.perTm) map.set(key, agg.amount);
  return map;
}

export function activeMembers(members: RosterMember[]): RosterMember[] {
  return members.filter((m) => m.activeLeft.toLowerCase() !== "left");
}
