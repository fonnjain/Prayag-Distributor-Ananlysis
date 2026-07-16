// Seed/migration: loads the FY2026-27 Apr-Jul state-bifurcated primary targets.
//
// Rules:
//  - Runs once at server startup.
//  - Creates the primary_state_targets table if it does not yet exist (handles
//    production environments that have not been migrated through drizzle-kit push).
//  - Clean-replaces: deletes existing primary_state_targets rows for
//    fy=2026-27, month_label IN (Apr-26, May-26, Jun-26, Jul-26), then inserts.
//  - source="derived" for Apr/May (seasonal estimates); "given" for Jun/Jul (plan).
//  - Idempotent: if the exact set is already present (row count matches), skips.
//  - target_lakh stored in Lakh rupees (1 Lakh = 1,00,000).
import { db, primaryStateTargets, type InsertPrimaryStateTarget } from "@workspace/db";
import { pool } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../logger.js";

const FY = "2026-27";
const MONTHS = ["Apr-26", "May-26", "Jun-26", "Jul-26"] as const;
type Month = typeof MONTHS[number];

// ── Authoritative target data ─────────────────────────────────────────────────
// Source: IMport-Prayag_Primary_Targets_AllMonths.xlsx, imported Jul 2026.
// Verified: Jun total = 32.72 Cr, Jul total = 32.73 Cr.
// Apr/May are seasonal-derived; Jun/Jul are the management plan figures.

type HeadData = {
  head: string;
  states: {
    state: string;
    apr: number;
    may: number;
    jun: number;
    jul: number;
  }[];
};

const HEADS: HeadData[] = [
  {
    head: "Sandeep Dadheech",
    states: [
      { state: "W-BENGAL",   apr: 416, may: 792, jun: 872, jul: 800 },
      { state: "BIHAR",      apr: 171, may: 327, jun: 346, jul: 343 },
      { state: "JHARKHAND",  apr: 117, may: 223, jun: 251, jul: 220 },
      { state: "ODISHA",     apr:  91, may: 173, jun: 182, jul: 182 },
      { state: "ASSAM",      apr:  70, may: 133, jun: 140, jul: 140 },
      { state: "AP",         apr:  25, may:  47, jun:  50, jul:  50 },
      { state: "Telangana",  apr:  22, may:  41, jun:  46, jul:  41 },
    ],
  },
  {
    head: "Syed Aqil Rizvi",
    states: [
      { state: "UP(R)",        apr: 148, may: 282, jun: 300, jul: 295 },
      { state: "MP",           apr:  92, may: 175, jun: 200, jul: 170 },
      { state: "MAHARASTRA R", apr:  22, may:  41, jun:  40, jul:  47 },
      { state: "Chhattisgarh", apr:  14, may:  26, jun:  30, jul:  25 },
    ],
  },
  {
    head: "Lalan Kumar",
    states: [
      { state: "MAHARASTRA L", apr: 53, may: 101, jun: 110, jul: 100 },
      { state: "Goa",          apr: 53, may: 101, jun: 110, jul: 100 },
    ],
  },
  {
    head: "Pawan Sharma",
    states: [
      { state: "Rajasthan", apr: 38, may: 73, jun: 80, jul: 71 },
      { state: "Haryana",   apr: 32, may: 60, jun: 65, jul: 60 },
    ],
  },
  {
    head: "Anant Singh",
    states: [
      { state: "Uttarakhand", apr: 15, may: 28, jun:  30, jul:  25 },
      { state: "DELHI",       apr: 15, may: 28, jun:  30, jul:  34 },
      { state: "UP(A)",       apr: 41, may: 78, jun:  84, jul:  84 },
    ],
  },
  {
    head: "Biju C.O",
    states: [
      // Jun has no Kerala target — only Tamilnadu and Karnataka for that month.
      { state: "Tamilnadu", apr:  60, may: 114, jun: 118, jul: 125 },
      { state: "Kerala",    apr:  53, may: 100, jun:   0, jul: 110 },
      { state: "Karnataka", apr:  44, may:  83, jun:  11, jul:  91 },
    ],
  },
  {
    head: "Sulinder Pal",
    states: [
      // HP = new territory; actual will be ~0 — see isNewTerritory flag in API.
      { state: "HP",     apr: 19, may: 35, jun: 40, jul: 35 },
      { state: "PUNJAB", apr: 19, may: 37, jun: 40, jul: 45 },
    ],
  },
  {
    head: "Nasir Hussain Khan",
    states: [
      { state: "KASHMIR", apr: 25, may: 47, jun: 51, jul: 40 },
    ],
  },
  {
    head: "Sunil Patel",
    states: [
      { state: "Gujarat", apr: 22, may: 42, jun: 46, jul: 40 },
    ],
  },
];

// Map month-label → (column key in HeadData, source tag)
const MONTH_META: Record<Month, { key: "apr" | "may" | "jun" | "jul"; source: string }> = {
  "Apr-26": { key: "apr", source: "derived" },
  "May-26": { key: "may", source: "derived" },
  "Jun-26": { key: "jun", source: "given" },
  "Jul-26": { key: "jul", source: "given" },
};

function buildRows(): InsertPrimaryStateTarget[] {
  const rows: InsertPrimaryStateTarget[] = [];
  for (const h of HEADS) {
    for (const s of h.states) {
      for (const m of MONTHS) {
        const { key, source } = MONTH_META[m];
        const targetLakh = s[key];
        // Skip zero-value rows (e.g. Biju / Kerala / Jun where no target exists)
        if (targetLakh === 0) continue;
        rows.push({
          fy: FY,
          stateHead: h.head,
          state: s.state,
          monthLabel: m,
          targetLakh,
          source,
        });
      }
    }
  }
  return rows;
}

const EXPECTED_ROWS = buildRows().length;

// ── Table migration ───────────────────────────────────────────────────────────
// Creates the table when it does not yet exist — covers production deployments
// where drizzle-kit push has not yet run for this new table.

async function ensurePrimaryStateTargetsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS primary_state_targets (
      id          serial PRIMARY KEY,
      fy          text NOT NULL,
      state_head  text NOT NULL,
      state       text NOT NULL,
      month_label text NOT NULL,
      target_lakh real NOT NULL,
      source      text NOT NULL DEFAULT 'given',
      created_at  timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (fy, state_head, state, month_label)
    )
  `);
}

// ── Public seed function ──────────────────────────────────────────────────────

export async function ensureAndSeedStateTargets(): Promise<void> {
  try {
    await ensurePrimaryStateTargetsTable();

    // Check current count; skip if already correct.
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(primaryStateTargets)
      .where(
        and(
          eq(primaryStateTargets.fy, FY),
          inArray(primaryStateTargets.monthLabel, [...MONTHS]),
        ),
      );

    if (count === EXPECTED_ROWS) {
      logger.info(
        { fy: FY, rows: count },
        "stateTargetSeed: already up-to-date, skipping",
      );
      return;
    }

    // Clean-replace: delete existing Apr-Jul targets, then re-insert.
    await db
      .delete(primaryStateTargets)
      .where(
        and(
          eq(primaryStateTargets.fy, FY),
          inArray(primaryStateTargets.monthLabel, [...MONTHS]),
        ),
      );

    const rows = buildRows();
    await db.insert(primaryStateTargets).values(rows);

    logger.info(
      { fy: FY, inserted: rows.length, previousCount: count },
      "stateTargetSeed: state targets seeded",
    );
  } catch (err) {
    logger.error({ err }, "stateTargetSeed: seed failed");
    // Non-fatal: server continues even if seed fails.
  }
}
