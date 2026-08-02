// Database store for member-level targets — the writable replacement for the
// read-only Prayag Target Master Google Sheet.
//
// Rows here are ONLY ever written by an explicit save from the Targets page
// (POST /api/targets). No seed or background job writes this table, so a
// user-entered value can never be overwritten by anything except another
// user save. The Target Master sheet remains a read-only seed underneath:
// loadTargetsForFy() in targets.ts overlays these DB rows on top of it,
// DB winning per member.
import { db, memberTargets } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { normName } from "./names.js";
import type { TargetRow, FieldValues, FieldMonthly } from "./targets.js";

function coerceAnnual(v: unknown): FieldValues {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  return {
    primary: num(o.primary),
    secondary: num(o.secondary),
    directDealer: num(o.directDealer),
    businessPlan: num(o.businessPlan),
  };
}

function coerceMonthly(v: unknown): FieldMonthly {
  const o = (v ?? {}) as Record<string, unknown>;
  const arr = (x: unknown): Array<number | null> => {
    const a = Array.isArray(x) ? x : [];
    return Array.from({ length: 12 }, (_, i) =>
      typeof a[i] === "number" && Number.isFinite(a[i]) ? (a[i] as number) : null,
    );
  };
  return {
    primary: arr(o.primary),
    secondary: arr(o.secondary),
    directDealer: arr(o.directDealer),
    businessPlan: arr(o.businessPlan),
  };
}

// Load all DB-saved member targets for a fiscal year, keyed by normName.
export async function loadDbTargetsForFy(fy: string): Promise<Map<string, TargetRow>> {
  const rows = await db.select().from(memberTargets).where(eq(memberTargets.fy, fy));
  const map = new Map<string, TargetRow>();
  for (const r of rows) {
    map.set(normName(r.teamMember), {
      fy: r.fy,
      teamMember: r.teamMember,
      stateHead: r.stateHead,
      level: r.level === "STATE_HEAD" ? "STATE_HEAD" : "TM",
      annual: coerceAnnual(r.annual),
      monthly: coerceMonthly(r.monthly),
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return map;
}

export type UpsertResult = { updated: number; appended: number };

// Upsert one row per (fy, team_member). Serialized sequentially — target
// saves are small and rare, and this keeps updated/appended counts exact.
export async function upsertMemberTargets(
  fy: string,
  rows: Array<{
    teamMember: string;
    stateHead: string;
    annual: FieldValues;
    monthly: FieldMonthly;
  }>,
  updatedBy: string,
): Promise<UpsertResult> {
  let updated = 0;
  let appended = 0;
  for (const row of rows) {
    const res = await db
      .insert(memberTargets)
      .values({
        fy,
        teamMember: row.teamMember,
        stateHead: row.stateHead,
        level: "TM",
        annual: row.annual,
        monthly: row.monthly,
        source: "user",
        updatedBy,
      })
      .onConflictDoUpdate({
        target: [memberTargets.fy, memberTargets.teamMember],
        set: {
          stateHead: row.stateHead,
          annual: row.annual,
          monthly: row.monthly,
          source: "user",
          updatedBy,
          updatedAt: sql`now()`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (res[0]?.inserted) appended += 1;
    else updated += 1;
  }
  return { updated, appended };
}
