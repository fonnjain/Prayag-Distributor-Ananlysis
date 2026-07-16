// Primary target entries — DB-persisted cadence-based annual targets for
// state heads and primary team members.  Completely separate from the Google
// Sheets Target Master, which stores secondary targets.
//
// Cadence:
//   "annual"      — 1 value  (full-year total)
//   "half_yearly" — 2 values (H1: Apr-Sep, H2: Oct-Mar)
//   "quarterly"   — 4 values (Q1: Apr-Jun, Q2: Jul-Sep, Q3: Oct-Dec, Q4: Jan-Mar)
//   "monthly"     — 12 values (Apr … Mar, fiscal order)
//
// Seasonal weights — NEVER use equal distribution:
//   Apr  May  Jun  Jul  Aug  Sep  Oct  Nov  Dec  Jan  Feb  Mar
//   4.2  8.0  8.7  7.2  6.9  6.4  6.4  8.2  9.5 10.1 10.9 13.6
// Sum = 100.1 — normalized internally so they sum to exactly 1.
import { eq } from "drizzle-orm";
import { db, primaryTargetEntries, primaryStateTargets } from "@workspace/db";
import { normName } from "./names.js";
import { loadStateDashboard } from "./stateDashboard.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

// ── Seasonal weights ──────────────────────────────────────────────────────────

// Fiscal month index: 0=Apr, 1=May, … 11=Mar
const RAW_WEIGHTS = [4.2, 8.0, 8.7, 7.2, 6.9, 6.4, 6.4, 8.2, 9.5, 10.1, 10.9, 13.6] as const;
const WEIGHT_SUM = RAW_WEIGHTS.reduce((s, w) => s + w, 0); // 100.1

export const SEASONAL_SHARES: readonly number[] = RAW_WEIGHTS.map((w) => w / WEIGHT_SUM);

// Half-year and quarter aggregate shares (for proportional intra-bucket split)
const H1_SHARE = SEASONAL_SHARES.slice(0, 6).reduce((s, w) => s + w, 0); // Apr-Sep
const H2_SHARE = SEASONAL_SHARES.slice(6, 12).reduce((s, w) => s + w, 0); // Oct-Mar
const Q_SHARES = [
  SEASONAL_SHARES.slice(0, 3).reduce((s, w) => s + w, 0),  // Q1 Apr-Jun
  SEASONAL_SHARES.slice(3, 6).reduce((s, w) => s + w, 0),  // Q2 Jul-Sep
  SEASONAL_SHARES.slice(6, 9).reduce((s, w) => s + w, 0),  // Q3 Oct-Dec
  SEASONAL_SHARES.slice(9, 12).reduce((s, w) => s + w, 0), // Q4 Jan-Mar
];

export type Cadence = "annual" | "half_yearly" | "quarterly" | "monthly";

// Expand a cadence+values entry into 12 monthly target amounts (fiscal order
// Apr … Mar).  Uses seasonal weights so that a Q1 total is distributed across
// Apr/May/Jun proportionally, never evenly.
export function expandToMonthly(cadence: Cadence, values: number[]): number[] {
  if (cadence === "monthly") {
    const arr = [...values.slice(0, 12)];
    while (arr.length < 12) arr.push(0);
    return arr;
  }

  if (cadence === "annual") {
    const annual = values[0] ?? 0;
    return SEASONAL_SHARES.map((s) => annual * s);
  }

  if (cadence === "half_yearly") {
    const h1 = values[0] ?? 0;
    const h2 = values[1] ?? 0;
    return SEASONAL_SHARES.map((s, i) =>
      i < 6 ? (H1_SHARE > 0 ? h1 * (s / H1_SHARE) : 0) : (H2_SHARE > 0 ? h2 * (s / H2_SHARE) : 0),
    );
  }

  if (cadence === "quarterly") {
    const q = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
    return SEASONAL_SHARES.map((s, i) => {
      const qi = Math.floor(i / 3);
      return Q_SHARES[qi] > 0 ? q[qi] * (s / Q_SHARES[qi]) : 0;
    });
  }

  return Array(12).fill(0);
}

// Sum monthly targets over a fiscal period.
// monthFrom/monthTo are 1-based (1=Apr, 12=Mar).
export function periodTarget(monthly12: number[], monthFrom: number, monthTo: number): number {
  let total = 0;
  for (let m = monthFrom; m <= monthTo; m++) {
    total += monthly12[m - 1] ?? 0;
  }
  return total;
}

// Annual total for an entry, regardless of cadence.
export function annualTotalFromEntry(cadence: Cadence, values: number[]): number {
  return values.reduce((s, v) => s + (v ?? 0), 0);
}

// ── DB ops ────────────────────────────────────────────────────────────────────

export type PrimaryTargetRow = {
  name: string;
  role: "state_head" | "team_member";
  cadence: Cadence;
  values: number[];
};

export async function loadPrimaryTargetEntries(fy: string): Promise<PrimaryTargetRow[]> {
  const rows = await db
    .select({
      name: primaryTargetEntries.name,
      role: primaryTargetEntries.role,
      cadence: primaryTargetEntries.cadence,
      values: primaryTargetEntries.values,
    })
    .from(primaryTargetEntries)
    .where(eq(primaryTargetEntries.fy, fy));

  return rows.map((r) => ({
    name: r.name,
    role: r.role as "state_head" | "team_member",
    cadence: r.cadence as Cadence,
    values: (r.values as number[]) ?? [],
  }));
}

export async function savePrimaryTargetEntries(
  fy: string,
  rows: PrimaryTargetRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  let saved = 0;
  for (const row of rows) {
    await db
      .insert(primaryTargetEntries)
      .values({
        fy,
        name: row.name,
        role: row.role,
        cadence: row.cadence,
        values: row.values,
      })
      .onConflictDoUpdate({
        target: [primaryTargetEntries.fy, primaryTargetEntries.name],
        set: {
          role: row.role,
          cadence: row.cadence,
          values: row.values,
          updatedAt: new Date(),
        },
      });
    saved++;
  }
  return saved;
}

// Build a normKey → monthly12 map for use in mgmt route integrations.
// The map is keyed by normName(entry.name) so it can be joined against the
// mgmt roster's normKey field.
export async function buildPrimaryTargetMap(
  fy: string,
): Promise<Map<string, number[]>> {
  const entries = await loadPrimaryTargetEntries(fy);
  const map = new Map<string, number[]>();
  for (const e of entries) {
    const key = normName(e.name);
    if (key) map.set(key, expandToMonthly(e.cadence, e.values));
  }
  return map;
}

// ── State-target-backed primary target map ────────────────────────────────────
//
// Reads monthly targets from primary_state_targets (the unified editable source)
// rather than primary_target_entries.  Use this in mgmt routes so edits made in
// the Data Sources "State Head Targets" editor propagate everywhere.
//
// Returns normName(stateHead) → 12-element array of monthly values in RUPEES
// (target_lakh × 1e5).  Month ordering: Apr=0 … Mar=11 (fiscal).

function fyMonthLabels(fy: string): string[] {
  const start = Number(fy.slice(2, 4));
  const end   = Number(fy.slice(5, 7));
  return [
    `Apr-${start}`, `May-${start}`, `Jun-${start}`, `Jul-${start}`,
    `Aug-${start}`, `Sep-${start}`, `Oct-${start}`, `Nov-${start}`,
    `Dec-${start}`, `Jan-${end}`,   `Feb-${end}`,   `Mar-${end}`,
  ];
}

export async function buildPrimaryTargetMapFromStateTargets(
  fy: string,
): Promise<Map<string, number[]>> {
  const rows = await db.select().from(primaryStateTargets).where(eq(primaryStateTargets.fy, fy));

  const monthLabels = fyMonthLabels(fy);
  // stateHead → monthLabel → sumLakh
  const headMap = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!headMap.has(row.stateHead)) headMap.set(row.stateHead, new Map());
    const m = headMap.get(row.stateHead)!;
    m.set(row.monthLabel, (m.get(row.monthLabel) ?? 0) + row.targetLakh);
  }

  const result = new Map<string, number[]>();
  for (const [head, monthMap] of headMap) {
    const key = normName(head);
    if (!key) continue;
    // Convert Lakh → rupees (× 1e5) for each of the 12 fiscal months in order.
    const monthly12 = monthLabels.map((lbl) => (monthMap.get(lbl) ?? 0) * 1e5);
    result.set(key, monthly12);
  }
  return result;
}

// ── Roster ────────────────────────────────────────────────────────────────────

export type PrimaryRoster = {
  stateHeads: string[];   // display names, sorted
  teamMembers: string[];  // isPrimaryRole members, display names, sorted
};

export async function loadPrimaryRoster(fy: string): Promise<PrimaryRoster> {
  try {
    const [sec, roster] = await Promise.all([
      loadStateDashboard(fy),
      loadRoster().catch(() => null),
    ]);
    if (!sec) return { stateHeads: [], teamMembers: [] };

    // State heads come from the stateHead field of secondary OB members.
    const headsSet = new Set<string>();
    for (const m of sec.members) {
      if (m.stateHead && m.stateHead.trim()) headsSet.add(m.stateHead.trim());
    }

    // Primary team members: raw display names from the "PRIMARY TEAM MEMBERS"
    // tab in the state-dashboard spreadsheet.  We prefer these over a roster
    // cross-reference because normKey alignment is fragile.
    const primaryRoleNames = sec.primaryRoleNames ?? [];

    // Supplement with any roster members whose normKey is in primaryRoleKeys
    // but whose name wasn't captured in the primary tab (rare edge case).
    const nameSet = new Set(primaryRoleNames.map((n) => normName(n)).filter(Boolean));
    if (roster) {
      for (const m of roster.members ?? []) {
        if (
          m.normKey &&
          sec.primaryRoleKeys.has(m.normKey) &&
          m.name?.trim() &&
          !nameSet.has(m.normKey)
        ) {
          primaryRoleNames.push(m.name.trim());
          nameSet.add(m.normKey);
        }
      }
    }

    return {
      stateHeads: [...headsSet].sort(),
      teamMembers: primaryRoleNames.slice().sort(),
    };
  } catch (err) {
    logger.warn({ err, fy }, "primaryTargets: roster load failed");
    return { stateHeads: [], teamMembers: [] };
  }
}
