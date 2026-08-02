// Target Master read + pro-rata split logic.
//
// Google Sheets access is strictly read-only. This module reads the Target
// Master sheet but no longer writes to it. The upsert route has been removed.
//
// Sheet schema (tab "targets", one row per fy x team_member):
//   fy | team_member | state_head | level |
//   primary_target_annual | secondary_target_annual |
//   direct_dealer_target_annual | business_plan_annual |
//   4 x 12 monthly override cells (Apr..Mar, blank = auto-split) |
//   updated_by | updated_at
import {
  readAllTabRows,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normName, priorFy } from "./names.js";
import { loadRoster, mgmtSources, type RosterMember } from "./roster.js";
import { loadOrderFile } from "./orders.js";
import { loadDbTargetsForFy } from "./memberTargetsStore.js";

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

async function loadStoredRows(): Promise<StoredRow[]> {
  const { sheetId, tab } = mgmtSources().target_master;
  const rows = await readAllTabRows(sheetId, tab);
  const out: StoredRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseRow(rows[i] ?? [], i + 1);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function loadTargetsForFy(fy: string): Promise<Map<string, TargetRow>> {
  // Sheet is the read-only seed; DB rows (explicit user saves) overlay it and
  // win per member. Known curl-test rows in the sheet are discarded — they
  // were confirmed as API tests, not real targets (Aug 2026 decision).
  const [stored, dbRows] = await Promise.all([
    loadStoredRows().catch((err) => {
      // Degraded: Sheets seed unavailable — serve DB-only rather than fail,
      // but make the outage visible in the server log.
      console.error("[targets] Target Master sheet read failed; serving DB-only", err);
      return [] as StoredRow[];
    }),
    loadDbTargetsForFy(fy),
  ]);
  const map = new Map<string, TargetRow>();
  for (const row of stored) {
    if (row.fy !== fy) continue;
    if (row.updatedBy.toLowerCase().startsWith("curl-test")) continue;
    map.set(normName(row.teamMember), row);
  }
  for (const [key, row] of dbRows) map.set(key, row);
  return map;
}

// --- Validation -----------------------------------------------------------

// Monthly overrides (plus seasonally-weighted auto-split for blank cells) must
// sum back to the annual figure within a small tolerance.
// Blank months contribute their SEASONAL share of the annual (not a flat ÷12),
// matching exactly what tgtMonthly() and tgtPeriod() compute at query time.
import { splitAnnualToMonth } from "../seasonal.js";
export function monthlyReconcileError(
  field: TargetField,
  annual: number | null,
  monthly: Array<number | null>,
): string | null {
  const overrides = monthly.filter((v): v is number => v != null);
  if (overrides.length === 0) return null;
  if (annual == null) {
    // FY26-27 shape: quarterly targets entered directly into monthly cells,
    // no annual figure.  Monthly-only is valid; nothing to cross-check.
    return null;
  }
  // Sum overrides + seasonal share for each blank month (idx = fiscal month, Apr=0).
  const implied = monthly.reduce<number>((sum, v, idx) => {
    return sum + (v != null ? v : (splitAnnualToMonth(annual, idx) ?? 0));
  }, 0);
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
