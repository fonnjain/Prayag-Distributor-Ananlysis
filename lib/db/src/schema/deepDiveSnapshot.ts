import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ── deep_dive_snapshot ────────────────────────────────────────────────────────
//
// One row per (FY, save) of the Data-tab parse result from the STATE HEAD
// DASHBOARD.  Written fire-and-forget after every successful Sheets read.
//
// Closed FYs (FY < current FY) are served exclusively from here on cold
// server start — Sheets is never re-read for them.  The most recent row per
// FY (by saved_at) is used.
//
// data shape: { allMembers: MemberKpis[], rawHeaders: string[], rowsRead: number }
// (MemberKpis imported at runtime; stored as plain JSON so the DB stays
// schema-agnostic).

export const deepDiveSnapshots = pgTable(
  "deep_dive_snapshot",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(),
    data: jsonb("data").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("deep_dive_snap_fy_idx").on(t.fy),
  ],
);
